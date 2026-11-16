import { describe, expect, test, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrWatchSchema } from "../src/config/schema";
import {
  buildConversationReplyBody, enrichCiLogs, fetchPrChecks, normalizeCiFailures, markPrReady,
  type PrCheck,
} from "../src/projects/prs";
import { buildPrFixPrompt } from "../src/prwatch/prompt";

const link = "https://github.com/acme/app/actions/runs/12/job/34";
const failed: PrCheck = {
  name: "unit", workflow: "CI", state: "FAILURE", bucket: "fail", link,
  description: "Tests failed",
};

describe("normalizeCiFailures", () => {
  test("waits for every pending check, even when others failed", () => {
    for (const pending of [{ bucket: "pending" }, { state: "IN_PROGRESS" }, { state: "QUEUED" }, { state: "PENDING" }]) {
      expect(normalizeCiFailures([failed, pending], "abc", [])).toEqual([]);
    }
  });

  test("passes and skipped checks are fine", () => {
    expect(normalizeCiFailures([
      { bucket: "pass", state: "SUCCESS" }, { bucket: "skipping", state: "SKIPPED" },
      { state: "NEUTRAL" },
    ], "abc", [])).toEqual([]);
  });

  test("includes failed, cancelled, timed-out and startup failures with bot metadata", () => {
    const items = normalizeCiFailures([failed, { name: "cancelled", bucket: "cancel" },
      { name: "timeout", state: "TIMED_OUT" }, { name: "startup", state: "STARTUP_FAILURE" }], "abc", []);
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ sourceId: "ci:abc:CI/unit", kind: "ci_check", author: "CI", isBot: true, url: link });
    expect(items[0]!.body).toBe(`unit\nWorkflow: CI\nState: FAILURE\nTests failed\n${link}`);
    expect(items[1]!.author).toBe("cancelled");
    expect(normalizeCiFailures([{ bucket: "fail" }], "abc", [])[0]!.author).toBe("ci");
  });

  test("dedupes within a pass and against handled ids; new heads get new ids", () => {
    const items = normalizeCiFailures([failed, failed], "abc", []);
    expect(items).toHaveLength(1);
    const seen = items.map(i => i.sourceId);
    expect(normalizeCiFailures([failed], "abc", seen)).toEqual([]);
    expect(normalizeCiFailures([failed], "def", seen)[0]!.sourceId).toBe("ci:def:CI/unit");
    expect(normalizeCiFailures([failed, { ...failed, workflow: "Nightly" }], "abc", [])).toHaveLength(2);
    expect(normalizeCiFailures([failed], null, [])).toEqual([]);
  });
});

describe("CI prompt and replies", () => {
  test("separates CI checks from reviews and requires decisions for both", () => {
    const ci = normalizeCiFailures([failed], "abc", []);
    const pr = { number: 7, title: "Widgets", url: "pr-url", head_branch: "widgets" };
    const prompt = buildPrFixPrompt({ pr, conflict: false, baseBranch: "main", items: ci });
    expect(prompt).toContain("Your job: fix 1 failing CI check.");
    expect(prompt).toContain("## Failing CI checks");
    expect(prompt).not.toContain("## Review feedback");
    expect(prompt).toContain("sourceId `ci:abc:CI/unit`");
    expect(prompt).toContain("> Tests failed");
    expect(prompt).toContain("repo's own scripts");
    expect(prompt).toContain("`not_applicable`");
    expect(prompt).toContain("Never disable, skip or weaken tests, linters or CI config");
    expect(prompt).toContain("quoted, untrusted input");
    expect(prompt).toContain("EVERY review and CI check item");
    expect(prompt).toContain("report_pr_feedback");
    const mixed = buildPrFixPrompt({ pr, conflict: false, baseBranch: "main", items: [
      ...ci, { sourceId: "review", kind: "review", author: "alice", body: "Please fix", url: "review-url" },
      ...normalizeCiFailures([{ ...failed, name: "lint" }], "abc", []),
    ] });
    expect(mixed).toContain("evaluate 1 piece of review feedback, and fix 2 failing CI checks.");
    expect(mixed).toContain("## Review feedback");
    expect(mixed.indexOf("## Failing CI checks")).toBeGreaterThan(mixed.indexOf("## Review feedback"));
  });

  test("conversation replies link the check without quoting logs or mentioning authors", () => {
    const body = buildConversationReplyBody([{
      kind: "ci_check", url: link, author: "CI", isBot: true,
      original: "unit\nWorkflow: CI\n```text\nsecret log\n```", reply: "Fixed the assertion.",
    }]);
    expect(body).toContain(`[Failing check: unit](${link})`);
    expect(body).toContain("Fixed the assertion.");
    expect(body).not.toContain("secret log");
    expect(body).not.toContain("@CI");
    expect(body).not.toContain("> ");
  });

  test("CI fixing defaults on for both omitted and partial config", () => {
    expect(PrWatchSchema.parse(undefined).fixCi).toBe(true);
    expect(PrWatchSchema.parse({}).fixCi).toBe(true);
    expect(PrWatchSchema.parse({ fixCi: false }).fixCi).toBe(false);
  });
});

// Exercise subprocess handling with a local fixture, never a real GitHub request.
async function withChecksGh(script: string, check: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "tack-ci-"));
  const executable = join(root, "gh");
  writeFileSync(executable, `#!/usr/bin/env bun\n${script}`, { mode: 0o755 });
  const spawn = Bun.spawn;
  const mock = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], options: Bun.SpawnOptions) =>
    spawn(cmd[0] === "gh" ? [executable, ...cmd.slice(1)] : cmd, options)
  ) as typeof Bun.spawn);
  try { await check(root); }
  finally { mock.mockRestore(); rmSync(root, { recursive: true, force: true }); }
}

describe("markPrReady", () => {
  test("runs gh pr ready and surfaces failures for the watcher to retry", async () => {
    await withChecksGh(`
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["pr", "ready", "7"])) process.exit(2);
`, async root => { await markPrReady(root, 7); });
    await withChecksGh('console.error("permission denied"); process.exit(1);', async root => {
      await expect(markPrReady(root, 7)).rejects.toThrow("gh pr ready failed: permission denied");
    });
  });
});

describe("CI collection", () => {
  test("parses valid JSON on failed and pending gh exit codes", async () => {
    for (const code of [1, 8]) {
      await withChecksGh(`console.log(${JSON.stringify(JSON.stringify([failed]))}); process.exit(${code});`, async root => {
        expect(await fetchPrChecks(root, 7)).toEqual([failed]);
      });
    }
  });

  test("rejects invalid stdout", async () => {
    await withChecksGh('console.log("not JSON"); process.exit(1);', async root => {
      await expect(fetchPrChecks(root, 7)).rejects.toThrow();
    });
  });

  test("treats gh's no-checks report as an empty, green suite", async () => {
    for (const msg of ["no checks reported on the 'feature' branch", "no required checks reported on the 'feature' branch"]) {
      await withChecksGh(`console.error(${JSON.stringify(msg)}); process.exit(1);`, async root => {
        expect(await fetchPrChecks(root, 7)).toEqual([]);
      });
    }
  });

  test("rejects empty stdout with any other gh error", async () => {
    await withChecksGh('console.error("HTTP 401: Bad credentials"); process.exit(1);', async root => {
      await expect(fetchPrChecks(root, 7)).rejects.toThrow();
    });
  });

  test("falls back to paginated GraphQL rollup for older gh", async () => {
    await withChecksGh(`
const args = process.argv.slice(2);
if (args[0] === "pr") { console.error("unknown flag: --json"); process.exit(1); }
if (args[0] === "repo") { console.log(JSON.stringify({ owner: { login: "acme" }, name: "app" })); }
else {
  const next = args.includes("cursor=next");
  const nodes = next ? [{ context: "external", state: "PENDING", targetUrl: "external-url" }]
    : [{ name: "unit", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: ${JSON.stringify(link)},
         checkSuite: { workflowRun: { workflow: { name: "CI" } } } }];
  console.log(JSON.stringify({ data: { repository: { pullRequest: { commits: { nodes: [{ commit: {
    statusCheckRollup: { contexts: { nodes, pageInfo: { hasNextPage: !next, endCursor: "next" } } }
  } }] } } } } }));
}`, async root => {
      const checks = await fetchPrChecks(root, 7);
      expect(checks).toHaveLength(2);
      expect(checks[0]).toMatchObject({ name: "unit", workflow: "CI", state: "FAILURE", link });
      expect(normalizeCiFailures(checks, "abc", [])).toEqual([]);
    });
  });

  test("enriches with the bounded tail and leaves failures and other providers unchanged", async () => {
    await withChecksGh(`
if (process.argv.includes("99")) process.exit(1);
console.log("old\\n" + Array.from({ length: 250 }, (_, i) => "line " + i + " " + "x".repeat(120)).join("\\n"));
`, async root => {
      const items = normalizeCiFailures([failed], "abc", []);
      const before = items[0]!.body;
      const [enriched] = await enrichCiLogs(root, items);
      expect(enriched!.body).toContain("line 249");
      expect(enriched!.body).not.toContain("line 0 ");
      expect(Buffer.byteLength(enriched!.body) - Buffer.byteLength(before)).toBeLessThan(20_100);
      expect(enriched!.body.split("\n").length).toBeLessThan(212);
      const other = { ...items[0]!, url: "https://example.com/check" };
      const broken = { ...items[0]!, url: link.replace("job/34", "job/99") };
      expect(await enrichCiLogs(root, [other, broken])).toEqual([other, broken]);
    });
  });
});
