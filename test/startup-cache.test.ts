import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_CACHE_DIR } from "../src/paths";
import { execFileSync } from "node:child_process";
import { ConfigSchema, type TackConfig } from "../src/config/schema";
import { isBaseCacheFresh, readBaseCacheFreshness, recordBaseCacheFreshness } from "../src/worktree/base-cache";
import { resolveStartPoint } from "../src/worktree/worktree";
import { decodePreflight, encodePreflight, usablePreflight } from "../src/agent/preflight";

const cfg = () => ConfigSchema.parse({ roles: { agent: "x", supervisor: "x", summary: "x" } }) as unknown as TackConfig;
test("base cache defaults and freshness", () => {
  expect(cfg().baseCache).toEqual({ enabled: true, intervalSeconds: 120, maxAgeSeconds: 600 });
  const key = crypto.randomUUID();
  expect(readBaseCacheFreshness(key)).toBeNull();
  recordBaseCacheFreshness(key, "origin/main", "abc");
  expect(readBaseCacheFreshness(key)?.sha).toBe("abc");
  expect(isBaseCacheFresh(key, 60000, "origin/main")).toBe(true);
  expect(isBaseCacheFresh(key, 60000, "origin/other")).toBe(false);
  expect(isBaseCacheFresh(key, -1)).toBe(false);
});
test("fresh remote ref skips fetch; stale ref fetches", () => {
  const root = mkdtempSync(join(tmpdir(), "tack-base-test-"));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(root, "init", "--bare", "origin.git");
  git(root, "clone", "origin.git", "source");
  const source = join(root, "source");
  git(source, "config", "commit.gpgsign", "false"); git(source, "config", "user.email", "test@example.com"); git(source, "config", "user.name", "Test");
  git(source, "checkout", "-b", "main");
  writeFileSync(join(source, "file"), "one"); git(source, "add", "file"); git(source, "commit", "-m", "one"); git(source, "push", "-u", "origin", "main");
  git(root, "clone", "-b", "main", "origin.git", "client");
  const repo = join(root, "client"), key = crypto.randomUUID(), first = git(repo, "rev-parse", "origin/main");
  recordBaseCacheFreshness(key, "origin/main", first);
  writeFileSync(join(source, "file"), "two"); git(source, "commit", "-am", "two"); git(source, "push");
  const second = git(source, "rev-parse", "HEAD");
  expect(resolveStartPoint(repo, key, cfg())).toBe(first);
  const config = cfg(); config.baseCache.maxAgeSeconds = 0;
  // Force staleness without relying on clock granularity.
  config.baseCache.enabled = false;
  expect(resolveStartPoint(repo, key, config)).toBe(second);
  expect(readBaseCacheFreshness(key)?.sha).toBe(second);
});
test("preflight round trip and validation", () => {
  const p = { modelKey: "m", runtime: "codex" as const, bin: "/bin/codex", version: "1", modelOffered: "unknown" as const };
  expect(decodePreflight(encodePreflight(p))).toEqual(p);
  expect(usablePreflight(p, "m", "codex")).toBe(true);
  expect(usablePreflight(p, "other", "codex")).toBe(false);
  expect(usablePreflight(p, "m", "claude")).toBe(false);
  expect(usablePreflight({ ...p, bin: "" }, "m", "codex")).toBe(false);
  expect(decodePreflight("garbage")).toBeUndefined();
});
