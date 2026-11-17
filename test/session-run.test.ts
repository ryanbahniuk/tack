import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRun, resolveRun, template, envRewrites, mergeRun } from "../src/session/run-detect";
import { allocatePorts, needsSetup, setupHash, selectTree, planRun, copyRunFiles, repeatedRunFlag, formatRunConfig, formatRunStatus, portFree, runLive, type RunState, type RunApp } from "../src/session/run";

import { tmuxRunName, tmuxSessionName } from "../src/session/tmux";

function fixture(files: Record<string,string>): string { const dir = mkdtempSync(join(tmpdir(), "tack-run-test-")); for (const [name, data] of Object.entries(files)) { mkdirSync(join(dir, name, ".."), { recursive: true }); writeFileSync(join(dir, name), data); } return dir; }
describe("local app resolution", () => {
  test("node managers, framework ports and compound scripts", () => {
    const tree = fixture({ "package.json": JSON.stringify({ scripts: { dev: "next dev -p 5188" } }), "yarn.lock": "" });
    expect(detectRun(tree)?.command).toBe("yarn next dev -p ${port}"); expect(detectRun(tree)?.port).toBe(5188);
    writeFileSync(join(tree, "package.json"), JSON.stringify({ scripts: { dev: "vite" } })); expect(detectRun(tree)?.port).toBe(5173);
    writeFileSync(join(tree, "package.json"), JSON.stringify({ scripts: { dev: "next dev -p 3000 && echo done" } })); expect(detectRun(tree)?.warnings.length).toBe(1); rmSync(tree, { recursive: true });
  });
  test("rails, Procfile and missing detection", () => {
    const rails = fixture({ Gemfile: "", "config/application.rb": "" }); expect(detectRun(rails)?.detectedBy).toBe("Rails");
    const proc = fixture({ Procfile: "web: serve --port $PORT\n" }); expect(detectRun(proc)?.command).toBe("serve --port ${port}");
    const empty = fixture({}); expect(detectRun(empty)).toBeUndefined(); for (const dir of [rails,proc,empty]) rmSync(dir, { recursive: true });
  });
  test("overrides and templates", () => {
    const dir = fixture({ "package.json": '{"scripts":{"dev":"vite"}}' });
    expect(resolveRun(dir, { port: 1234, env: { API: "x" } })?.port).toBe(1234); expect(resolveRun(dir, false)).toBeUndefined();
    expect(template("${url:api} ${port} ${worktree}", { port: 3, tree: dir }, { api: { port: 4 } })).toBe(`http://localhost:4 3 ${dir}`); expect(() => template("${url:no}", { port: 3, tree: dir }, {})).toThrow(); rmSync(dir, { recursive: true });
  });
  test("env rewriting avoids ambiguity and respects explicit env", () => {
    const dir = fixture({ ".env": "API=http://localhost:3000\nOTHER=http://127.0.0.1:4000\n" }); const warnings: string[] = [];
    const apps = [{ name: "api", preferred: 3000, port: 3001 }, { name: "a", preferred: 4000, port: 4001 }, { name: "b", preferred: 4000, port: 4002 }];
    expect(envRewrites(dir, "client", apps, {}, s => warnings.push(s))).toEqual({ API: "http://localhost:3001" }); expect(warnings.some(s => s.includes("ambiguous"))).toBe(true);
    expect(envRewrites(dir, "client", apps, { API: "explicit" }, () => {})).toEqual({}); rmSync(dir, { recursive: true });
  });
  test("ports, worktrees and setup gating", async () => {
    expect(await allocatePorts([3000,3000], async p => p !== 3000)).toEqual([3001,3002]);
    const dir = fixture({ "yarn.lock": "one" }); const project = { name: "app", path: dir, description: "app" };
    const rows = [{ id: "one", project_name: "app", kind: "worker", worktree_path: dir, created_at: "1", branch: "a" }, { id: "two", project_name: "app", kind: "review", worktree_path: dir, created_at: "2", branch: "b" }] as any;
    expect(selectTree(project, rows, []).agentId).toBe("one"); expect(() => selectTree(project, rows, ["two"])).toThrow(); expect(selectTree(project, [], []).main).toBe(true);
    const app = { tree: dir, main: false, spec: { setupInputs: ["yarn.lock"] } } as RunApp; const hash = setupHash(dir, ["yarn.lock"]); expect(needsSetup(app, hash)).toBe(false); writeFileSync(join(dir, "yarn.lock"), "two"); expect(needsSetup(app, hash)).toBe(true); app.main = true; expect(needsSetup(app, hash, true)).toBe(false); rmSync(dir, { recursive: true });
  });
});

test("npm vite detection and compound fallback", () => {
  const dir = fixture({ "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
  expect(detectRun(dir)).toMatchObject({ command: "npm run dev", port: 5173, setup: ["npm install"] });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite --port=5188 && echo started" } }));
  expect(detectRun(dir)).toMatchObject({ command: "npm run dev", port: 5188 });
  expect(detectRun(dir)?.warnings[0]).toContain("hardcodes port");
  rmSync(dir, { recursive: true });
});

test("override replaces fields and merges environment keys", () => {
  const dir = fixture({ "package.json": '{"scripts":{"dev":"vite"}}' });
  const base = detectRun(dir)!;
  base.env = { KEEP: "one", REPLACE: "old" };
  const merged = mergeRun(base, { env: { REPLACE: "new", ADD: "three" }, setup: ["custom"], port: 9999 });
  expect(merged).toMatchObject({ source: "mixed", port: 9999, setup: ["custom"], env: { KEEP: "one", REPLACE: "new", ADD: "three" } });
  rmSync(dir, { recursive: true });
});

test("tree selection chooses latest eligible and honors explicit agent", () => {
  const dir = fixture({});
  const project = { name: "app", path: dir, description: "app" };
  const rows = [
    { id: "old", project_name: "app", kind: "worker", worktree_path: dir, created_at: "1", branch: "old" },
    { id: "new", project_name: "app", kind: "manual", worktree_path: dir, created_at: "2", branch: "new" },
    { id: "review", project_name: "app", kind: "review", worktree_path: dir, created_at: "3", branch: "review" },
    { id: "gone", project_name: "app", kind: "pr_fix", worktree_path: join(dir, "missing"), created_at: "4", branch: "gone" },
  ] as any;
  expect(selectTree(project, rows, []).agentId).toBe("new");
  expect(selectTree(project, rows, ["old"]).agentId).toBe("old");
  expect(() => selectTree(project, rows, ["review"])).toThrow();
  rmSync(dir, { recursive: true });
});

test("required projects use main checkout without setup or copy", () => {
  const main = fixture({ "package.json": '{"scripts":{"dev":"vite"}}', ".env": "main" });
  const tree = fixture({ "package.json": '{"scripts":{"dev":"vite"}}', ".env": "worktree" });
  const service = fixture({ "package.json": '{"scripts":{"dev":"vite"}}' });
  const projects = [{ name: "client", path: main, description: "client", run: { requires: ["service"] } }, { name: "service", path: service, description: "service", run: { copyFiles: [".env"] } }];
  const rows = [{ id: "worker", project_name: "client", kind: "worker", worktree_path: tree, created_at: "1", branch: "topic" }] as any;
  const apps = planRun("ses_test", { projects } as any, [], [], rows);
  expect(apps.map(a => a.name)).toEqual(["client", "service"]);
  expect(apps[1]).toMatchObject({ tree: service, main: true, agentId: null });
  expect(needsSetup(apps[1]!, undefined, true)).toBe(false);
  copyRunFiles(apps[1]!, main);
  expect(existsSync(join(service, ".env"))).toBe(false);
  copyRunFiles(apps[0]!, main);
  expect(readFileSync(join(tree, ".env"), "utf8")).toBe("worktree");
  for (const dir of [main, tree, service]) rmSync(dir, { recursive: true });
});

test("setup runs for missing check, changed inputs or force", () => {
  const dir = fixture({ "yarn.lock": "one" });
  const app = { tree: dir, main: false, spec: { setupInputs: ["yarn.lock"], setupCheck: "node_modules" } } as RunApp;
  const hash = setupHash(dir, ["yarn.lock"]);
  expect(needsSetup(app, hash)).toBe(true);
  mkdirSync(join(dir, "node_modules"));
  expect(needsSetup(app, hash)).toBe(false);
  expect(needsSetup(app, hash, true)).toBe(true);
  writeFileSync(join(dir, "yarn.lock"), "changed");
  expect(needsSetup(app, hash)).toBe(true);
  rmSync(dir, { recursive: true });
});

test("formatting and repeatable options", () => {
  expect(repeatedRunFlag(["--project", "one", "--project=two", "--agent", "a"], "project")).toEqual(["one", "two"]);
  const dir = fixture({ "package.json": '{"scripts":{"dev":"vite"}}' });
  const app = { name: "client", spec: resolveRun(dir, { env: { "A-B": "value" } })! } as RunApp;
  expect(formatRunConfig(app)).toContain("// client (detected by package.json dev script (npm, vite))\nrun: {");
  expect(formatRunConfig(app)).toContain('"A-B": "value"');
  expect(formatRunConfig(app)).toContain("port: 5173");
  expect(formatRunStatus(undefined, false)).toBe("No run found.");
  rmSync(dir, { recursive: true });
});

test("both loopback families participate in port checks", async () => {
  const hosts: string[] = [];
  expect(await portFree(3000, async (_, host) => { hosts.push(host); return host !== "::1"; })).toBe(false);
  expect(hosts).toEqual(["127.0.0.1", "::1"]);
  expect(await portFree(3001, async () => true)).toBe(true);
});

test("run tmux session is not a live supervisor", () => {
  const state = { sessionId: "ses_abc", mode: "tmux", status: "running", apps: [] } as RunState;
  const sessions = new Set([tmuxRunName("ses_abc")]);
  expect(runLive(state, sessions)).toBe(true);
  expect(sessions.has(tmuxSessionName("ses_abc"))).toBe(false);
});
