import { describe, expect, test } from "bun:test";
import { inferPackage, tagVersion, findRelease, type GhRunner } from "../src/prwatch/dependency";
import { buildPrFixPrompt, readyToPromote } from "../src/prwatch/watch";

describe("release dependencies", () => {
  test("infers packages from matching manifests", () => {
    expect(inferPackage({ Gemfile: "" }, { "x.gemspec": "spec.name = 'chime-schemas'" })).toEqual({ ecosystem: "ruby", package: "chime-schemas" });
    expect(inferPackage({ Gemfile: "" }, { "x.gemspec": "" })?.package).toBe("x");
    expect(inferPackage({ "package.json": "{}" }, { "package.json": '{"name":"@a/b"}' })?.package).toBe("@a/b");
    expect(inferPackage({ "requirements.txt": "" }, { "pyproject.toml": '[project]\nname = "python-pkg"\nversion = "1"\n' })?.package).toBe("python-pkg");
    expect(inferPackage({ "go.mod": "" }, { "go.mod": "module example.org/pkg\n" })?.package).toBe("example.org/pkg");
    expect(inferPackage({ Gemfile: "" }, { "go.mod": "module x" })).toBeNull();
  });
  test("parses stable versions", () => {
    expect(tagVersion("foo-v1.2.3", "foo")).toBe("1.2.3");
    expect(tagVersion("foo/1.2", "foo")).toBe("1.2");
    expect(tagVersion("foo@v1.0", "foo")).toBe("1.0");
    expect(tagVersion("pre-1.0", "foo")).toBeNull();
    expect(tagVersion("v1.0-rc1", "foo")).toBeNull();
  });
  test("chooses the oldest containing stable prefixed release", async () => {
    const runner: GhRunner = async args => {
      if (args[0] === "release") return JSON.stringify([
        { tagName: "pkg-v1.2", createdAt: "2025-02-01", isDraft: false, isPrerelease: false },
        { tagName: "pkg-v1.1", createdAt: "2025-01-02", isDraft: false, isPrerelease: false },
        { tagName: "pkg-v1.0-rc1", createdAt: "2025-01-01", isPrerelease: true },
      ]);
      if (args[1]?.includes("/tags?")) return "[]";
      return JSON.stringify({ status: "ahead" });
    };
    expect(await findRelease("/tmp", "o/r", "abc", "2025-01-01", "pkg", runner)).toEqual({ tag: "pkg-v1.1", version: "1.1" });
  });
  test("renders dependency as instructions", () => {
    const p = buildPrFixPrompt({ pr: { number: 1, title: null, url: "https://example", head_branch: null }, conflict: false, baseBranch: null, items: [{ sourceId: "dep:x:1", kind: "dependency_release", author: "Tack", url: "", body: "Package: pkg\nVersion: 1" }] });
    expect(p).toContain("## Dependency release");
    expect(p).toContain("Package: pkg");
    expect(p).not.toContain("> Package: pkg");
    expect(p).toContain("never hand-edit a lockfile");
  });
  test("unresolved dependency blocks promotion", () => {
    expect(readyToPromote({ enabled: true, autoReady: true, isDraft: true, readyPromotedAt: null, mergeable: "MERGEABLE", prFixBusy: false, freshCount: 0, releasedCount: 0, feedback: [], checks: [], unresolvedDependencies: 1 })).toBe(false);
  });
});

test("migration creates unique dependency declarations", async () => {
  const { Database } = await import("bun:sqlite");
  const { migrate } = await import("../src/db/migrate");
  const db = new Database(":memory:");
  migrate(db);
  const columns = db.query("PRAGMA table_info(pr_dependencies)").all() as { name: string }[];
  expect(columns.map(c => c.name)).toContain("released_version");
  expect(columns.map(c => c.name)).toContain("feedback_id");
  db.close();
});
