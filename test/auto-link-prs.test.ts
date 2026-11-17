import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigSchema, type TackConfig } from "../src/config/schema";
import { STARTER_CONFIG } from "../src/config/starter";
import { CONFIG_PATH } from "../src/paths";
import { createSession, listSessionPrs, markSessionPrLinked, upsertSessionPr } from "../src/db";
import {
  AUTO_LINK_TIMEOUT_REASON, MAX_AUTO_LINK_URLS, autoLinkNote, autoLinkPromptPrs, autoLinkablePrompt,
  extractPrUrls, promptWithAutoLinks, type AutoLinkOutcome,
} from "../src/session/auto-link-prs";
import { parseRemoteRepo, resolveLinkProject, type LinkPrResult } from "../src/session/link-pr";
import { APPROVE_PROMPT_MARKER } from "../src/supervisor/approve-prompt";
import { REFRESH_MESSAGE } from "../src/session/refresh-message";

describe("extractPrUrls", () => {
  test("finds PR URLs in prose, markdown links and angle brackets, stripping punctuation", () => {
    const text = [
      "Please look at https://github.com/acme/app/pull/12.",
      "Also [the lib PR](https://github.com/acme/lib/pull/3), and <https://github.com/acme/svc/pull/9>!",
      "(see https://github.com/acme/web/pull/4)",
      "Quoted: \"https://github.com/acme/cli/pull/5\"; `https://github.com/acme/api/pull/6`?",
    ].join("\n");
    expect(extractPrUrls(text)).toEqual([
      "https://github.com/acme/app/pull/12",
      "https://github.com/acme/lib/pull/3",
      "https://github.com/acme/svc/pull/9",
      "https://github.com/acme/web/pull/4",
      "https://github.com/acme/cli/pull/5",
      "https://github.com/acme/api/pull/6",
    ]);
  });

  test("normalizes sub-pages, queries and fragments, and dedupes case-insensitively in first-seen order", () => {
    const text = "https://github.com/Acme/App/pull/12/files then https://github.com/acme/lib/pull/3#discussion_r1 " +
      "and again https://github.com/acme/app/pull/12?w=1 and [x](https://github.com/acme/lib/pull/3/commits/abc)";
    expect(extractPrUrls(text)).toEqual(["https://github.com/Acme/App/pull/12", "https://github.com/acme/lib/pull/3"]);
  });

  test("ignores GitHub URLs that aren't PRs, and plain text", () => {
    expect(extractPrUrls([
      "https://github.com/acme/app/issues/12", "https://github.com/acme/app/blob/main/a.ts",
      "https://github.com/acme/app/commit/abc123", "https://github.com/acme/app", "acme/app#12",
      "github.com/acme/app/pull/12", "https://github.com/acme/app/pulls",
    ].join(" "))).toEqual([]);
  });

  test("accepts enterprise hosts and caps the number of URLs", () => {
    expect(extractPrUrls("https://GitHub.example.com/team/svc/pull/3")).toEqual(["https://github.example.com/team/svc/pull/3"]);
    const many = Array.from({ length: 15 }, (_, i) => `https://github.com/acme/app/pull/${i + 1}`).join(" ");
    expect(extractPrUrls(many)).toHaveLength(MAX_AUTO_LINK_URLS);
  });
});

test("autoLinkablePrompt skips commands and synthetic openers", () => {
  expect(autoLinkablePrompt("fix https://github.com/a/b/pull/1")).toBe(true);
  for (const p of ["", "  ", "/approve", "/review sec https://github.com/a/b/pull/1", "/pr-fix on",
    `x\n${APPROVE_PROMPT_MARKER}`, `${REFRESH_MESSAGE} https://github.com/a/b/pull/1`, "/compact"]) {
    expect(autoLinkablePrompt(p)).toBe(false);
  }
});

const config = { projects: [{ name: "app", path: "/repos/app", description: "" }] } as unknown as TackConfig;

function result(url: string, extra: Partial<LinkPrResult> = {}): LinkPrResult {
  return {
    ok: true, pr: Number(url.split("/").pop()), url, project: "app", title: `Title ${url.split("/").pop()}`,
    state: "open", headBranch: "h", baseBranch: "main", baselined: 0, next: "", ...extra,
  };
}

describe("autoLinkPromptPrs", () => {
  test("classifies linked, already and skipped outcomes without throwing", async () => {
    const session = createSession({ title: "auto" });
    // A PR this session linked earlier counts as "already".
    upsertSessionPr({ sessionId: session.id, url: "https://github.com/acme/app/pull/2", projectName: "app", number: 2, title: "t", state: "open", headBranch: "x" });
    markSessionPrLinked(listSessionPrs(session.id)[0]!.id);
    const calls: string[] = [];
    const link = async ({ url }: { url: string }) => {
      calls.push(url);
      if (url.endsWith("/1")) return result(url);
      if (url.endsWith("/2")) return result(url);
      if (url.endsWith("/3")) return result(url, { alreadySessionPr: true });
      if (url.endsWith("/4")) throw new Error("acme/app#4 is already merged; there's nothing to add to it.");
      if (url.endsWith("/5")) throw new Error("acme/app#5 is closed; reopen it on GitHub first to link it.");
      if (url.endsWith("/6")) throw new Error("acme/app#6 comes from a fork; Tack can only push to branches in acme/app itself.");
      if (url.endsWith("/7")) throw new Error("other/x isn't a configured project, so its PR can't be linked.");
      throw new Error("gh pr view failed: HTTP 502\nmore");
    };
    const prompt = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `https://github.com/acme/app/pull/${n}`).join(", ");
    const outcomes = await autoLinkPromptPrs({ sessionId: session.id, config, prompt, link });
    expect(calls).toHaveLength(8);
    expect(outcomes.map((o) => [o.ref, o.status, o.reason])).toEqual([
      ["acme/app#1", "linked", undefined],
      ["acme/app#2", "already", undefined],
      ["acme/app#3", "already", undefined],
      ["acme/app#4", "skipped", "already merged"],
      ["acme/app#5", "skipped", "closed"],
      ["acme/app#6", "skipped", "from a fork"],
      ["acme/app#7", "skipped", "not a configured project"],
      ["acme/app#8", "skipped", "gh pr view failed: HTTP 502"],
    ]);
    expect(outcomes[0]).toMatchObject({ project: "app", title: "Title 1", url: "https://github.com/acme/app/pull/1" });
  });

  test("returns nothing for prompts without PR URLs", async () => {
    const link = async () => { throw new Error("should not be called"); };
    expect(await autoLinkPromptPrs({ sessionId: "nope", config, prompt: "hello https://github.com/a/b/issues/1", link })).toEqual([]);
  });

  test("stops at the deadline: an in-flight link is abandoned and the rest are skipped", async () => {
    const session = createSession({ title: "slow" });
    const started: string[] = [];
    const link = ({ url }: { url: string }) => {
      started.push(url);
      return url.endsWith("/1") ? Promise.resolve(result(url)) : new Promise<LinkPrResult>(() => {});
    };
    const prompt = "https://github.com/acme/app/pull/1 https://github.com/acme/app/pull/2 https://github.com/acme/app/pull/3";
    const outcomes = await autoLinkPromptPrs({ sessionId: session.id, config, prompt, link, deadlineMs: Date.now() + 50 });
    expect(outcomes.map((o) => [o.status, o.reason])).toEqual([
      ["linked", undefined],
      ["skipped", AUTO_LINK_TIMEOUT_REASON],
      ["skipped", AUTO_LINK_TIMEOUT_REASON],
    ]);
    expect(started).toHaveLength(2); // #3 was never started

    const late = await autoLinkPromptPrs({ sessionId: session.id, config, prompt, link, deadlineMs: Date.now() - 1 });
    expect(late.every((o) => o.status === "skipped" && o.reason === AUTO_LINK_TIMEOUT_REASON)).toBe(true);
  });
});

describe("autoLinkNote", () => {
  const linked: AutoLinkOutcome = { url: "u", ref: "acme/app#12", status: "linked", project: "app", title: "Fix \"it\"" };
  const already: AutoLinkOutcome = { url: "u", ref: "acme/app#2", status: "already", project: "app", title: "Old" };
  const skipped: AutoLinkOutcome = { url: "u", ref: "acme/app#9", status: "skipped", reason: "already merged" };

  test("null when there's nothing to report", () => expect(autoLinkNote([])).toBeNull());

  test("lists linked PRs with guidance, and what wasn't linked", () => {
    expect(autoLinkNote([linked, already, skipped])).toBe(
      "Tack auto-linked PR URLs from the human's message: acme/app#12 in project \"app\" (\"Fix \\\"it\\\"\"), " +
      "acme/app#2 in project \"app\" (\"Old\"). They're session PRs now: change them with fix_pr, never " +
      "spawn_agent + open_pr. Not linked: acme/app#9 (already merged).",
    );
  });

  test("only skipped outcomes still produce a note", () => {
    expect(autoLinkNote([skipped])).toBe("Tack didn't auto-link PR URLs from the human's message: acme/app#9 (already merged).");
  });
});

describe("promptWithAutoLinks", () => {
  const link = async ({ url }: { url: string }) => result(url);
  test("appends the note when enabled", async () => {
    const session = createSession({ title: "headless" });
    const prompt = "work on https://github.com/acme/app/pull/1";
    const out = await promptWithAutoLinks({ sessionId: session.id, config: { ...config, autoLinkPrs: true }, prompt, link });
    expect(out.startsWith(`${prompt}\n\n(Tack auto-linked PR URLs`)).toBe(true);
  });
  test("leaves the prompt alone when disabled, filtered, or URL-free", async () => {
    const fail = async () => { throw new Error("should not be called"); };
    const session = createSession({ title: "off" });
    for (const [autoLinkPrs, prompt] of [
      [false, "https://github.com/acme/app/pull/1"], [true, `${REFRESH_MESSAGE} https://github.com/acme/app/pull/1`], [true, "no urls"],
    ] as const) {
      expect(await promptWithAutoLinks({ sessionId: session.id, config: { ...config, autoLinkPrs }, prompt, link: fail })).toBe(prompt);
    }
  });
});

describe("resolveLinkProject local-remote fast path", () => {
  test("parses https, ssh and scp-style remotes", () => {
    for (const url of [
      "https://github.com/Acme/App.git", "https://github.com/Acme/App", "http://ghe.example.com/Acme/App/",
      "ssh://git@github.com/Acme/App.git", "ssh://git@github.com:22/Acme/App", "git@github.com:Acme/App.git",
      "github.com:Acme/App",
    ]) expect(parseRemoteRepo(url)).toEqual({ owner: "Acme", repo: "App" });
    for (const url of ["/local/path/repo", "file:///x/y", "", "https://github.com/onlyowner"])
      expect(parseRemoteRepo(url)).toBeNull();
  });

  const projects = {
    projects: [
      { name: "app", path: "/repos/app", description: "" },
      { name: "lib", path: "/repos/lib", description: "" },
      { name: "local", path: "/repos/local", description: "" },
    ],
  } as unknown as TackConfig;
  const remotes: Record<string, string> = {
    "/repos/app": "git@github.com:acme/app.git",
    "/repos/lib": "https://github.com/Acme/Lib.git",
  };
  const remoteUrl = async (p: string) => {
    if (!remotes[p]) throw new Error("no origin");
    return remotes[p]!;
  };

  test("matches origin case-insensitively without calling gh", async () => {
    const gh: string[] = [];
    const ghRepo = async (p: string) => { gh.push(p); return { owner: "x", name: "y" }; };
    expect((await resolveLinkProject(projects, { owner: "ACME", repo: "lib" }, undefined, ghRepo, remoteUrl)).name).toBe("lib");
    expect((await resolveLinkProject(projects, { owner: "acme", repo: "app" }, "app", ghRepo, remoteUrl)).name).toBe("app");
    expect(gh).toEqual([]);
  });

  test("falls back to gh only for projects whose origin couldn't be read, keeping the errors", async () => {
    const gh: string[] = [];
    const ghRepo = async (p: string) => { gh.push(p); return { owner: "team", name: "local" }; };
    expect((await resolveLinkProject(projects, { owner: "team", repo: "local" }, undefined, ghRepo, remoteUrl)).name).toBe("local");
    expect(gh).toEqual(["/repos/local"]);
    await expect(resolveLinkProject(projects, { owner: "other", repo: "thing" }, undefined, ghRepo, remoteUrl))
      .rejects.toThrow("other/thing isn't a configured project");
    await expect(resolveLinkProject(projects, { owner: "acme", repo: "lib" }, "app", ghRepo, remoteUrl))
      .rejects.toThrow(/isn't the GitHub repo acme\/lib/);
  });
});

describe("autoLinkPrs config", () => {
  test("defaults to true and can be turned off", () => {
    const base = { roles: { supervisor: "a", agent: "a", summary: "a" } };
    expect(ConfigSchema.parse(base).autoLinkPrs).toBe(true);
    expect(ConfigSchema.parse({ ...base, autoLinkPrs: false }).autoLinkPrs).toBe(false);
  });
  test("the starter config documents it", () => expect(STARTER_CONFIG).toContain("autoLinkPrs: true"));
});

describe("__approve-prompt auto-link", () => {
  // The hook loads the scratch TACK_HOME's config. Its only project's origin is a
  // local remote URL for acme/app, so other repos resolve locally without gh/network.
  const repo = mkdtempSync(join(tmpdir(), "tack-autolink-repo-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  Bun.spawnSync(["git", "remote", "add", "origin", "git@github.com:acme/app.git"], { cwd: repo });
  const writeConfig = (autoLinkPrs: boolean) => writeFileSync(CONFIG_PATH, `export default ${JSON.stringify({
    models: [{ key: "m", provider: "t", name: "m", version: "1", runtime: "codex", id: "m" }],
    roles: { supervisor: "m", agent: "m", summary: "m" },
    projects: [{ name: "app", path: repo, description: "The app." }],
    autoLinkPrs,
  })};\n`);
  afterAll(() => {
    rmSync(CONFIG_PATH, { force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  function submit(sessionId: string, prompt: string): string {
    const r = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../bin/tack.ts"), "__approve-prompt", sessionId], {
      env: { ...process.env }, stdin: Buffer.from(JSON.stringify({ prompt })), stdout: "pipe", stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toString()).toBe("");
    return r.stdout.toString();
  }

  test("writes one JSON object carrying the note", () => {
    writeConfig(true);
    const session = createSession({ title: "hook" });
    const out = submit(session.id, "Please fix https://github.com/other/thing/pull/7 and https://github.com/other/thing/pull/7/files.");
    const parsed = JSON.parse(out); // throws if two objects were written
    expect(parsed).toEqual({ hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "Tack didn't auto-link PR URLs from the human's message: other/thing#7 (not a configured project).",
    } });
    expect(listSessionPrs(session.id)).toEqual([]);
  });

  test("stays silent when disabled, and /approve still yields a single object", () => {
    writeConfig(false);
    const session = createSession({ title: "hook off" });
    expect(submit(session.id, "see https://github.com/other/thing/pull/7")).toBe("");
    writeConfig(true);
    const approved = JSON.parse(submit(session.id, "/approve https://github.com/other/thing/pull/7"));
    expect(approved.hookSpecificOutput.additionalContext).toBe(
      "The human approved the plan via /approve; plan_approved_at is set. Proceed to spawn agents.",
    );
  });
});
