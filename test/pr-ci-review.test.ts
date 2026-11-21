import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ConfigSchema, type TackConfig } from "../src/config/schema";
import { migrate } from "../src/db/migrate";
import { createSession, getSessionPr, listSessionPrs, setSessionPrStatus, upsertSessionPr } from "../src/db";
import * as prs from "../src/projects/prs";
import { ciStatusFrom, reviewStatusFrom, type GhReview, type PrStatus } from "../src/projects/prs";
import { pollPrStatus, watchPr } from "../src/prwatch/watch";
import { prCiDisplay, prReviewDisplay } from "../src/cli/dashboard";

describe("ciStatusFrom", () => {
  test("no checks on the head is none", () => {
    expect(ciStatusFrom([])).toBe("none");
  });
  test("all successful checks is passing", () => {
    expect(ciStatusFrom([{ state: "SUCCESS", bucket: "pass" }, { state: "SKIPPED", bucket: "skipping" }])).toBe("passing");
  });
  test("any pending check is pending", () => {
    expect(ciStatusFrom([{ state: "SUCCESS" }, { state: "IN_PROGRESS" }])).toBe("pending");
  });
  test("a failing check outranks a still-pending one", () => {
    expect(ciStatusFrom([{ state: "QUEUED" }, { state: "FAILURE" }, { state: "SUCCESS" }])).toBe("failing");
  });
});

describe("reviewStatusFrom", () => {
  const review = (login: string | undefined, state: string): GhReview =>
    ({ id: `${login}-${state}`, author: login ? { login } : null, state });

  test("maps GitHub's review decision directly, ignoring individual reviews", () => {
    const blocking = [review("a", "CHANGES_REQUESTED")];
    expect(reviewStatusFrom("APPROVED", blocking)).toBe("approved");
    expect(reviewStatusFrom("CHANGES_REQUESTED", [])).toBe("changes_requested");
    expect(reviewStatusFrom("REVIEW_REQUIRED", [review("a", "APPROVED")])).toBe("review_required");
  });
  test("without a decision, changes requested by one author outweighs another's approval", () => {
    expect(reviewStatusFrom("", [review("a", "APPROVED"), review("b", "CHANGES_REQUESTED")])).toBe("changes_requested");
  });
  test("without a decision, an author's later approval supersedes their own changes request", () => {
    expect(reviewStatusFrom(null, [review("a", "CHANGES_REQUESTED"), review("a", "APPROVED")])).toBe("approved");
  });
  test("a dismissed review clears that author's earlier verdict", () => {
    expect(reviewStatusFrom(null, [review("a", "CHANGES_REQUESTED"), review("a", "DISMISSED")])).toBe("none");
  });
  test("later comments don't override an author's verdict", () => {
    expect(reviewStatusFrom(null, [review("a", "APPROVED"), review("a", "COMMENTED")])).toBe("approved");
  });
  test("comments, pending reviews and authorless reviews alone are none", () => {
    expect(reviewStatusFrom(undefined, [review("a", "COMMENTED"), review("b", "PENDING"), review(undefined, "APPROVED")])).toBe("none");
  });
});

test("v26 adds nullable ci_status and review_status to session_prs and is idempotent", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    db.exec(`ALTER TABLE session_prs DROP COLUMN ci_status; ALTER TABLE session_prs DROP COLUMN review_status;
      DELETE FROM _migrations WHERE version >= 26;
      INSERT INTO sessions (id, status, created_at, updated_at) VALUES ('s', 'active', 'then', 'then');
      INSERT INTO session_prs (id, session_id, url, created_at, updated_at) VALUES ('p', 's', 'u', 'then', 'then');`);
    migrate(db);
    expect(db.query("SELECT ci_status, review_status FROM session_prs").get()).toEqual({ ci_status: null, review_status: null });
    db.exec("DELETE FROM _migrations WHERE version >= 26");
    migrate(db);
  } finally {
    db.close();
  }
});

test("setSessionPrStatus keeps stored CI and review status when they're omitted", () => {
  const session = createSession({ title: "status coalesce" });
  upsertSessionPr({ sessionId: session.id, url: `https://github.com/acme/app/pull/${session.id}`, number: 1, state: "open" });
  const pr = listSessionPrs(session.id)[0]!;
  const base = { state: "open", mergeable: null, baseBranch: "main", headSha: "h" };
  setSessionPrStatus(pr.id, { ...base, ciStatus: "failing", reviewStatus: "approved" });
  setSessionPrStatus(pr.id, base);
  expect(getSessionPr(pr.id)).toMatchObject({ ci_status: "failing", review_status: "approved" });
  upsertSessionPr({ sessionId: session.id, url: pr.url, number: 1, state: "open", title: "rediscovered" });
  expect(getSessionPr(pr.id)).toMatchObject({ ci_status: "failing", review_status: "approved" });
});

function openStatus(url: string, overrides: Partial<PrStatus> = {}): PrStatus {
  return { state: "OPEN", isDraft: false, mergeable: "MERGEABLE", baseRefName: "main", headRefOid: "head",
    headRefName: "pr", title: "PR", url, comments: [], reviews: [], ...overrides };
}

async function withPr(run: (pr: NonNullable<ReturnType<typeof getSessionPr>>, session: ReturnType<typeof createSession>) => Promise<void>) {
  const session = createSession({ title: "poll ci/review" });
  upsertSessionPr({ sessionId: session.id, url: `https://github.com/acme/app/pull/${session.id}`,
    number: 7, state: "open", projectName: "app" });
  await run(listSessionPrs(session.id)[0]!, session);
}

describe("pollPrStatus", () => {
  test("persists CI and review status and returns the fetched checks", async () => {
    await withPr(async (pr) => {
      const status = spyOn(prs, "fetchPrStatus").mockResolvedValue(openStatus(pr.url, { reviewDecision: "CHANGES_REQUESTED" }));
      const checks = spyOn(prs, "fetchPrChecks").mockResolvedValue([{ state: "IN_PROGRESS" }]);
      try {
        const polled = await pollPrStatus(pr.id, "/unused", 7);
        expect(polled.checks).toEqual([{ state: "IN_PROGRESS" }]);
        expect(getSessionPr(pr.id)).toMatchObject({ ci_status: "pending", review_status: "changes_requested" });
      } finally { status.mockRestore(); checks.mockRestore(); }
    });
  });
  test("a failed checks fetch records review status but keeps the last known CI status", async () => {
    await withPr(async (pr) => {
      setSessionPrStatus(pr.id, { state: "open", mergeable: null, baseBranch: "main", headSha: "old", ciStatus: "passing" });
      const status = spyOn(prs, "fetchPrStatus").mockResolvedValue(openStatus(pr.url, { reviewDecision: "APPROVED" }));
      const checks = spyOn(prs, "fetchPrChecks").mockRejectedValue(new Error("gh exploded"));
      try {
        const polled = await pollPrStatus(pr.id, "/unused", 7);
        expect(polled).toMatchObject({ checks: null, checksError: "gh exploded" });
        expect(getSessionPr(pr.id)).toMatchObject({ ci_status: "passing", review_status: "approved", head_sha: "head" });
      } finally { status.mockRestore(); checks.mockRestore(); }
    });
  });
  test("a merged PR skips the checks fetch", async () => {
    await withPr(async (pr) => {
      const status = spyOn(prs, "fetchPrStatus").mockResolvedValue(openStatus(pr.url, { state: "MERGED", mergedAt: "2026-01-01T00:00:00Z" }));
      const checks = spyOn(prs, "fetchPrChecks").mockResolvedValue([]);
      try {
        const polled = await pollPrStatus(pr.id, "/unused", 7);
        expect(checks).not.toHaveBeenCalled();
        expect(polled.checks).toBeNull();
        expect(getSessionPr(pr.id)).toMatchObject({ state: "merged", ci_status: null });
      } finally { status.mockRestore(); checks.mockRestore(); }
    });
  });
});

describe("watchPr checks reuse", () => {
  const config = () => ConfigSchema.parse({ projects: [{ name: "app", path: "/unused", description: "test" }],
    roles: { supervisor: "x", agent: "x", summary: "x" },
    prWatch: { fixCi: true, autoReady: false, maxFixRunsPerDay: 0 } }) as unknown as TackConfig;

  test("fetches checks exactly once per tick", async () => {
    await withPr(async (pr, session) => {
      const mocks = [
        spyOn(prs, "fetchPrStatus").mockResolvedValue(openStatus(pr.url)),
        spyOn(prs, "fetchReviewThreads").mockResolvedValue([]),
      ];
      const checks = spyOn(prs, "fetchPrChecks").mockResolvedValue([{ state: "SUCCESS" }]);
      try {
        await watchPr(session, pr, config(), () => {});
        expect(checks).toHaveBeenCalledTimes(1);
        expect(getSessionPr(pr.id)!.ci_status).toBe("passing");
      } finally { checks.mockRestore(); for (const m of mocks) m.mockRestore(); }
    });
  });
  test("logs a failed checks fetch for an open PR", async () => {
    await withPr(async (pr, session) => {
      const mocks = [
        spyOn(prs, "fetchPrStatus").mockResolvedValue(openStatus(pr.url)),
        spyOn(prs, "fetchReviewThreads").mockResolvedValue([]),
        spyOn(prs, "fetchPrChecks").mockRejectedValue(new Error("rate limited")),
      ];
      const logs: string[] = [];
      try {
        await watchPr(session, pr, config(), (msg) => logs.push(msg));
        expect(logs).toContain("PR #7: fetching CI checks failed: rate limited");
      } finally { for (const m of mocks) m.mockRestore(); }
    });
  });
});

describe("dashboard PR badges", () => {
  test("CI status display", () => {
    expect(prCiDisplay("passing")).toEqual({ glyph: "✔", color: "green", label: "passing" });
    expect(prCiDisplay("failing")).toEqual({ glyph: "✖", color: "red", label: "failing" });
    expect(prCiDisplay("pending")).toEqual({ glyph: "◌", color: "yellow", label: "pending" });
    expect(prCiDisplay("none")).toEqual({ glyph: "–", color: "gray", label: "none", dim: true });
    expect(prCiDisplay(null)).toBeNull();
  });
  test("review status display", () => {
    expect(prReviewDisplay("approved")).toEqual({ glyph: "✔", color: "green", label: "approved" });
    expect(prReviewDisplay("changes_requested")).toEqual({ glyph: "✖", color: "red", label: "changes requested" });
    expect(prReviewDisplay("review_required")).toEqual({ glyph: "◌", color: "yellow", label: "review required" });
    expect(prReviewDisplay("none")).toEqual({ glyph: "–", color: "gray", label: "no reviews", dim: true });
    expect(prReviewDisplay(null)).toBeNull();
  });
});
