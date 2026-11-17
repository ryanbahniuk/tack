import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlan, resolveRecipe } from "../src/boot/recipe";
import { runSteps, startRun, stopRun, processAlive } from "../src/boot/exec";
import { resolveBootTarget } from "../src/boot/resolve";
import { ConfigSchema, type TackConfig } from "../src/config/schema";
import type { AgentRow } from "../src/db";

describe("boot recipes", () => {
  test("defaults and merges recipes", () => {
    expect(ConfigSchema.parse({ roles: { supervisor: "x", agent: "x", summary: "x" } }).bootRecipes).toEqual({});
    const config = { bootRecipes: { shared: { up: ["first"], env: { A: "a", B: "b" }, vars: { x: "old" } } } } as unknown as TackConfig;
    const recipe = resolveRecipe(config, { name: "web", path: "/tmp", description: "web", boot: { recipe: "shared", up: ["second"], env: { A: "new" }, vars: { x: "new" } } });
    expect(recipe.up).toEqual(["second"]); expect(recipe.env).toEqual({ A: "new", B: "b" }); expect(recipe.vars?.x).toBe("new");
  });
  test("templates quote commands and reject unknown values", () => {
    const ctx = { project: "my app", path: "/tmp/a b", session: "s", agent: "a", branch: "it's" };
    const plan = buildPlan({ vars: { service: "{project}" }, up: ["echo {service} {branch}"], url: "http://{service}" }, ctx);
    expect(plan.up[0]).toBe("echo 'my app' 'it'\\''s'"); expect(plan.url).toBe("http://my app");
    expect(() => buildPlan({ run: "echo {missing}" }, ctx)).toThrow("missing");
  });
  test("worktrees resolve with explicit selection", () => {
    const a = { id: "a", project_name: "web", worktree_path: "/a", kind: "manual" } as AgentRow;
    const b = { ...a, id: "b", kind: null } as AgentRow;
    const fix = { ...a, id: "c", kind: "pr_fix" } as AgentRow;
    expect(resolveBootTarget([a, fix], "web", undefined, () => true).ok).toBe(true);
    expect(resolveBootTarget([a, b], "web", undefined, () => true).ok).toBe(false);
    expect(resolveBootTarget([a, b], "web", "b", () => true).ok).toBe(true);
    expect(resolveBootTarget([a], "web", undefined, () => false).ok).toBe(false);
  });
  test("executes steps and stops a detached process", () => {
    const dir = mkdtempSync(join(tmpdir(), "tack-boot-"));
    try {
      const plan = buildPlan({ up: ["touch up"], down: ["touch down"], run: "sleep 30" }, { project: "x", path: dir, session: "s", agent: "a", branch: "b" });
      const log = join(dir, "log"); runSteps(plan, plan.up, log); expect(existsSync(join(dir, "up"))).toBe(true);
      const pid = startRun(plan, log); expect(processAlive(pid)).toBe(true); stopRun(pid);
      runSteps(plan, plan.down, log); expect(existsSync(join(dir, "down"))).toBe(true);
      expect(() => runSteps(plan, ["exit 7"], log)).toThrow("exit 7");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
