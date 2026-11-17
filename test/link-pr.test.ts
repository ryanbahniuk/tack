import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { TackConfig } from "../src/config/schema";
import {
  createAgent, createSession, getSessionPr, insertPrFeedback, listPrFeedback, listSessionPrs,
  prFeedbackSourceIds, upsertSessionPr,
} from "../src/db";
import * as prs from "../src/projects/prs";
import { normalizeFeedback, parseGithubPrUrl, type PrStatus, type ReviewThread } from "../src/projects/prs";
import { readyToPromote } from "../src/prwatch/watch";
import { linkSessionPr, resolveLinkProject, unlinkSessionPr } from "../src/session/link-pr";
import { composeSessionSummary } from "../src/session/summary";

describe("parseGithubPrUrl", () => {
  const valid: Array<[string, { host: string; owner: string; repo: string; number: number }]> = [
    ["https://github.com/acme/app/pull/12", { host: "github.com", owner: "acme", repo: "app", number: 12 }],
    ["https://github.com/acme/app/pull/12/", { host: "github.com", owner: "acme", repo: "app", number: 12 }],
    ["https://github.com/acme/app/pull/12/files", { host: "github.com", owner: "acme", repo: "app", number: 12 }],
    ["https://github.com/acme/app/pull/12/commits/abc123", { host: "github.com", owner: "acme", repo: "app", number: 12 }],
    ["https://github.com/acme/app/pull/12/checks?check_run_id=9", { host: "github.com", owner: "acme", repo: "app", number: 12 }],
    ["https://github.com/acme/app/pull/12#discussion_r123", { host: "github.com", owner: "acme", repo: "app", number: 12 }],
    ["  https://github.com/Acme-Co/my.app_x/pull/7?w=1  ", { host: "github.com", owner: "Acme-Co", repo: "my.app_x", number: 7 }],
    ["https://GitHub.example.com/team/svc/pull/3", { host: "github.example.com", owner: "team", repo: "svc", number: 3 }],
  ];
  for (const [url, want] of valid) test(`parses ${url.trim()}`, () => expect(parseGithubPrUrl(url)).toEqual(want));

  for (const url of [
    "", "github.com/acme/app/pull/12", "https://github.com/acme/app", "https://github.com/acme/app/issues/12",
    "https://github.com/acme/app/pull/", "https://github.com/acme/app/pull/abc", "https://github.com/acme/app/pull/0",
    "https://github.com/acme/app/pulls/12", "https://github.com/acme/pull/12", "ftp://github.com/acme/app/pull/12",
    "https://github.com/acme/app/pull/12 trailing words", "#12",
  ]) test(`rejects ${JSON.stringify(url)}`, () => expect(parseGithubPrUrl(url)).toBeNull());
});

const config = {
  projects: [
    { name: "app", path: "/repos/app", description: "" },
    { name: "lib", path: "/repos/lib", description: "" },
  ],
} as unknown as TackConfig;
const repos: Record<string, { owner: string; name: string }> = {
  "/repos/app": { owner: "Acme", name: "App" },
  "/repos/lib": { owner: "acme", name: "lib" },
};
const fakeGhRepo = async (path: string) => {
  const r = repos[path];
  if (!r) throw new Error("not a GitHub repo");
  return r;
};

describe("resolveLinkProject", () => {
  test("matches owner/name case-insensitively", async () => {
    expect((await resolveLinkProject(config, { owner: "acme", repo: "app" }, undefined, fakeGhRepo)).name).toBe("app");
    expect((await resolveLinkProject(config, { owner: "ACME", repo: "LIB" }, undefined, fakeGhRepo)).name).toBe("lib");
  });
  test("an explicit project must be the PR's repo", async () => {
    expect((await resolveLinkProject(config, { owner: "acme", repo: "lib" }, "lib", fakeGhRepo)).name).toBe("lib");
    await expect(resolveLinkProject(config, { owner: "acme", repo: "lib" }, "app", fakeGhRepo)).rejects.toThrow(/isn't the GitHub repo acme\/lib/);
    await expect(resolveLinkProject(config, { owner: "acme", repo: "lib" }, "nope", fakeGhRepo)).rejects.toThrow(/isn't a configured project/);
  });
  test("an unconfigured repo is refused by name", async () => {
    await expect(resolveLinkProject(config, { owner: "other", repo: "thing" }, undefined, fakeGhRepo))
      .rejects.toThrow("other/thing isn't a configured project");
  });
});

describe("linkSessionPr / unlinkSessionPr", () => {
  const url = "https://github.com/acme/app/pull/42";
  const thread: ReviewThread = { isResolved: false, comments: { nodes: [
    { databaseId: 101, author: { login: "rev" }, body: "rename this", path: "a.ts", line: 3, url: `${url}#discussion_r101` },
  ] } };
  const resolved: ReviewThread = { isResolved: true, comments: { nodes: [
    { databaseId: 102, author: { login: "rev" }, body: "old nit", path: "b.ts", line: 1 },
  ] } };
  let status: PrStatus;
  let view: Awaited<ReturnType<typeof prs.fetchPrForLink>>;
  let threads: ReviewThread[];
  let checks: prs.PrCheck[];
  let spies: Array<{ mockRestore(): void }> = [];

  beforeEach(() => {
    status = {
      state: "OPEN", isDraft: true, mergeable: "MERGEABLE", baseRefName: "main", headRefOid: "sha1",
      headRefName: "feature/x", url, title: "Human PR",
      comments: [{ id: "IC_1", author: { login: "human" }, body: "please also do y", url: `${url}#c1` }],
      reviews: [{ id: "R_1", author: { login: "rev" }, body: "changes requested", url: `${url}#r1` }],
    } as PrStatus;
    view = {
      number: 42, url, title: "Human PR", state: "OPEN", isDraft: true, headRefName: "feature/x",
      baseRefName: "main", headRefOid: "sha1", mergeable: "MERGEABLE", mergedAt: null, isCrossRepository: false,
    };
    threads = [thread, resolved];
    checks = [{ name: "test", state: "FAILURE", workflow: "CI", link: "https://ci/1" }];
    spies = [
      spyOn(prs, "ghRepo").mockImplementation(fakeGhRepo),
      spyOn(prs, "fetchPrForLink").mockImplementation(async () => view),
      spyOn(prs, "fetchPrStatus").mockImplementation(async () => status),
      spyOn(prs, "fetchReviewThreads").mockImplementation(async () => threads),
      spyOn(prs, "fetchPrChecks").mockImplementation(async () => checks),
    ];
  });
  afterEach(() => { for (const s of spies.reverse()) s.mockRestore(); });

  test("links a draft, latches readiness and baselines existing feedback and CI as handled", async () => {
    const session = createSession({ title: "link" });
    const result = await linkSessionPr({ sessionId: session.id, config, url: `${url}/files` });
    expect(result).toMatchObject({
      ok: true, pr: 42, url, project: "app", title: "Human PR", state: "draft",
      headBranch: "feature/x", baseBranch: "main", baselined: 5,
      next: "Use fix_pr with this PR to add changes; don't open a new PR.",
    });
    expect(result.baselineWarning).toBeUndefined();
    const row = listSessionPrs(session.id)[0]!;
    expect(row).toMatchObject({ agent_id: null, project_name: "app", number: 42, state: "draft", base_branch: "main",
      head_sha: "sha1", linked_at: expect.any(String), ready_promoted_at: expect.any(String) });
    const feedback = listPrFeedback(row.id);
    expect(feedback.map((f) => f.source_id).sort()).toEqual(["101", "102", "IC_1", "R_1", "ci:sha1:CI/test"]);
    expect(feedback.every((f) => f.decision === "not_applicable" && f.handled_at && !f.reply_ref && !f.fix_agent_id)).toBe(true);

    // The watcher's view: nothing pending from history, CI already seen for this head…
    const known = prFeedbackSourceIds(row.id);
    expect(normalizeFeedback(status, threads, known)).toEqual([]);
    expect(prs.normalizeCiFailures(checks, "sha1", known)).toEqual([]);
    // …and the linked draft is never auto-promoted.
    expect(readyToPromote({
      enabled: true, autoReady: true, isDraft: true, readyPromotedAt: row.ready_promoted_at, mergeable: "MERGEABLE",
      prFixBusy: false, freshCount: 0, releasedCount: 0, feedback: [], checks: [],
    })).toBe(false);

    // Feedback that arrives after the link is still picked up.
    status.comments.push({ id: "IC_2", author: { login: "human" }, body: "one more thing", url: `${url}#c2` });
    expect(normalizeFeedback(status, threads, known).map((f) => f.sourceId)).toEqual(["IC_2"]);
  });

  test("re-linking refreshes metadata without duplicating or re-baselining", async () => {
    const session = createSession({ title: "relink" });
    await linkSessionPr({ sessionId: session.id, config, url });
    const first = listSessionPrs(session.id)[0]!;
    const fb = listPrFeedback(first.id);
    view = { ...view, title: "Renamed", isDraft: false };
    status.comments.push({ id: "IC_2", author: { login: "human" }, body: "new", url });
    const again = await linkSessionPr({ sessionId: session.id, config, url });
    expect(again).toMatchObject({ title: "Renamed", state: "open", baselined: 1 });
    const rows = listSessionPrs(session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, title: "Renamed", linked_at: first.linked_at,
      ready_promoted_at: first.ready_promoted_at });
    const after = listPrFeedback(first.id);
    expect(after).toHaveLength(fb.length + 1);
    for (const f of fb) expect(after.find((a) => a.id === f.id)).toEqual(f);
  });

  test("baseline failure still links, with a warning", async () => {
    spies.push(spyOn(prs, "fetchReviewThreads").mockRejectedValue(new Error("graphql down")));
    const session = createSession({ title: "warn" });
    const result = await linkSessionPr({ sessionId: session.id, config, url });
    expect(result.baselined).toBe(0);
    expect(result.baselineWarning).toContain("graphql down");
    expect(listSessionPrs(session.id)[0]!.linked_at).toEqual(expect.any(String));
  });

  test("refuses bad URLs, merged/closed and fork PRs", async () => {
    const session = createSession({ title: "refuse" });
    await expect(linkSessionPr({ sessionId: session.id, config, url: "https://github.com/acme/app/issues/1" }))
      .rejects.toThrow(/isn't a GitHub pull request URL/);
    view = { ...view, state: "MERGED", mergedAt: "then" };
    await expect(linkSessionPr({ sessionId: session.id, config, url })).rejects.toThrow(/already merged/);
    view = { ...view, state: "CLOSED", mergedAt: null };
    await expect(linkSessionPr({ sessionId: session.id, config, url })).rejects.toThrow(/is closed/);
    view = { ...view, state: "OPEN", isCrossRepository: true };
    await expect(linkSessionPr({ sessionId: session.id, config, url })).rejects.toThrow(/fork/);
    expect(listSessionPrs(session.id)).toEqual([]);
  });

  test("leaves a PR this session opened alone", async () => {
    const session = createSession({ title: "own" });
    upsertSessionPr({ sessionId: session.id, url, number: 42, state: "draft", projectName: "app", headBranch: "tack/pr/x/y" });
    const result = await linkSessionPr({ sessionId: session.id, config, url });
    expect(result.alreadySessionPr).toBe(true);
    const row = listSessionPrs(session.id)[0]!;
    expect(row.linked_at).toBeNull();
    expect(row.ready_promoted_at).toBeNull();
    expect(listPrFeedback(row.id)).toEqual([]);
    expect(() => unlinkSessionPr(row)).toThrow(/opened by this session/);
    expect(getSessionPr(row.id)).not.toBeNull();
  });

  test("unlink removes a linked PR and its feedback, but refuses while a fix is busy", async () => {
    const session = createSession({ title: "unlink" });
    await linkSessionPr({ sessionId: session.id, config, url });
    const row = listSessionPrs(session.id)[0]!;
    const fix = createAgent({ sessionId: session.id, projectName: "app", kind: "pr_fix", sessionPrId: row.id });
    expect(() => unlinkSessionPr(row)).toThrow(/still running or awaiting/);
    const { getDb } = await import("../src/db");
    getDb().prepare(`UPDATE agents SET status = 'done', post_fixed_at = 'then' WHERE id = ?`).run(fix.id);
    insertPrFeedback({ sessionPrId: row.id, sourceId: "late", sourceKind: "issue_comment" });
    expect(unlinkSessionPr(row)).toEqual({ ok: true, pr: 42, url });
    expect(getSessionPr(row.id)).toBeNull();
    expect(listPrFeedback(row.id)).toEqual([]);
  });
});

describe("session summary", () => {
  test("labels a linked PR as linked", () => {
    const base = { title: "T", project_name: "app", url: "u", state: "open", head_branch: "b" };
    const summary = composeSessionSummary({
      session: { id: "s", title: "S", created_at: "2026-01-01T00:00:00Z" }, jira: [], contract: null,
      prs: [{ row: { ...base, linked_at: "2026-02-03T00:00:00Z" } }, { row: { ...base, url: "v", linked_at: null } }],
    });
    expect(summary).toContain("- Linked: 2026-02-03 (existing PR adopted into this session)");
    expect(summary.match(/- Linked:/g)).toHaveLength(1);
  });
});
