import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveAgentSandbox, loadConfig } from "../src/config/load";
import { ConfigSchema } from "../src/config/schema";
import { agentSandboxSettings, ClaudeRuntime } from "../src/runtimes/claude";
import { codexSandboxFlags, CodexRuntime } from "../src/runtimes/codex";
import type { RunOptions } from "../src/runtimes/types";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configFile(src: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tack-sandbox-")));
  dirs.push(dir);
  const path = join(dir, "config.ts");
  writeFileSync(path, src);
  return path;
}

const CONFIG = (extra: string) => `export default {
  models: [{ key: "a", provider: "p", name: "A", version: "1", runtime: "claude", id: "a" }],
  roles: { supervisor: "a", agent: "a", summary: "a" },
  ${extra}
};
`;

const model = { key: "a", provider: "p", name: "A", version: "1", runtime: "claude" as const, id: "a" };
const codexModel = { ...model, runtime: "codex" as const, id: "gpt" };
const base: RunOptions = { bin: "x", cwd: "/w", prompt: "Go", model, logPath: "/tmp/log" };
const argv = (runtime: object, opts: RunOptions) => (runtime as { buildCmd(o: RunOptions): string[] }).buildCmd(opts);
const settingsArg = (cmd: string[]) => JSON.parse(cmd[cmd.indexOf("--settings") + 1]!);

const RUBY = {
  allowedDomains: ["*.jfrog.io", "rubygems.org"],
  readPaths: ["/h/.rbenv", "/h/.bundle"],
  writePaths: ["/h/.rbenv/versions", "/h/.gem"],
};

describe("agentSandbox config", () => {
  test("each list defaults to empty", () => {
    const parsed = ConfigSchema.parse({ roles: { agent: "x", supervisor: "x", summary: "x" }, agentSandbox: {} });
    expect(parsed.agentSandbox).toEqual({ allowedDomains: [], readPaths: [], writePaths: [] });
  });

  test("no block anywhere yields no sandbox allowances", async () => {
    const config = await loadConfig(configFile(CONFIG(`projects: [{ name: "p", path: "/p", description: "P." }],`)));
    expect(config.agentSandbox).toBeUndefined();
    expect(effectiveAgentSandbox(config, "p")).toBeUndefined();
  });

  test("all-empty blocks yield no sandbox allowances", async () => {
    const config = await loadConfig(configFile(CONFIG(`agentSandbox: {},
  projects: [{ name: "p", path: "/p", description: "P.", agentSandbox: { readPaths: [] } }],`)));
    expect(effectiveAgentSandbox(config, "p")).toBeUndefined();
  });

  test("effective sandbox is the de-duplicated union of global and project blocks, home-expanded", async () => {
    const config = await loadConfig(configFile(CONFIG(`agentSandbox: { allowedDomains: ["rubygems.org"], readPaths: ["~/.bundle"], writePaths: ["~/.gem"] },
  projects: [
    { name: "p", path: "/p", description: "P.", agentSandbox: { allowedDomains: ["*.jfrog.io", "rubygems.org"], readPaths: ["~/.rbenv", "~/.bundle"] } },
    { name: "q", path: "/q", description: "Q." },
  ],`)));
    const home = homedir();
    expect(effectiveAgentSandbox(config, "p")).toEqual({
      allowedDomains: ["rubygems.org", "*.jfrog.io"],
      readPaths: [join(home, ".bundle"), join(home, ".rbenv")],
      writePaths: [join(home, ".gem")],
    });
    expect(effectiveAgentSandbox(config, "q")).toEqual({
      allowedDomains: ["rubygems.org"],
      readPaths: [join(home, ".bundle")],
      writePaths: [join(home, ".gem")],
    });
  });

  test("a project-only block applies to that project alone", async () => {
    const config = await loadConfig(configFile(CONFIG(`projects: [
    { name: "p", path: "/p", description: "P.", agentSandbox: { writePaths: ["/opt/gems"] } },
    { name: "q", path: "/q", description: "Q." },
  ],`)));
    expect(effectiveAgentSandbox(config, "p")).toEqual({ allowedDomains: [], readPaths: [], writePaths: ["/opt/gems"] });
    expect(effectiveAgentSandbox(config, "q")).toBeUndefined();
  });
});

describe("claude worktree agent sandbox settings", () => {
  const DEFAULT = '{"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false},"permissions":{"blockReadsOutsideWorkingDirectories":true}}';

  test("argv is byte-for-byte the default without allowances", () => {
    const plain = argv(new ClaudeRuntime(), base);
    expect(settingsArg(plain)).toEqual(JSON.parse(DEFAULT));
    expect(plain[plain.indexOf("--settings") + 1]).toBe(DEFAULT);
    expect(argv(new ClaudeRuntime(), { ...base, sandbox: { allowedDomains: [], readPaths: [], writePaths: [] } })).toEqual(plain);
  });

  test("allowances merge into the sandbox blob while the hard gates stay", () => {
    expect(settingsArg(argv(new ClaudeRuntime(), { ...base, sandbox: RUBY }))).toEqual({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        network: { allowedDomains: ["*.jfrog.io", "rubygems.org"] },
        filesystem: {
          allowRead: ["/h/.rbenv", "/h/.bundle", "/h/.rbenv/versions", "/h/.gem"],
          allowWrite: ["/h/.rbenv/versions", "/h/.gem"],
        },
      },
      permissions: { blockReadsOutsideWorkingDirectories: true },
    });
  });

  test("read paths are granted read-only, never as add-dirs or write paths", () => {
    const sandbox = { allowedDomains: [], readPaths: ["/h/.bundle"], writePaths: [] };
    const cmd = argv(new ClaudeRuntime(), { ...base, sandbox });
    expect(cmd).not.toContain("--add-dir");
    expect(settingsArg(cmd).sandbox.filesystem).toEqual({ allowRead: ["/h/.bundle"] });
  });

  test("domains alone add only the network allowlist", () => {
    expect(agentSandboxSettings({ allowedDomains: ["rubygems.org"], readPaths: [], writePaths: [] }).sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: ["rubygems.org"] },
    } as any);
  });

  test("read-only runs never carry the agent sandbox", () => {
    const cmd = argv(new ClaudeRuntime(), { ...base, readOnly: true, sandbox: RUBY });
    expect(cmd).not.toContain("--settings");
  });
});

describe("codex worktree agent sandbox flags", () => {
  const opts: RunOptions = { ...base, model: codexModel };

  test("no allowances add no flags", () => {
    expect(codexSandboxFlags(undefined)).toEqual([]);
    expect(codexSandboxFlags({ allowedDomains: [], readPaths: ["/h/.rbenv"], writePaths: [] })).toEqual([]);
    expect(argv(new CodexRuntime(), { ...opts, sandbox: { allowedDomains: [], readPaths: [], writePaths: [] } }))
      .toEqual(argv(new CodexRuntime(), opts));
  });

  test("write paths become add-dirs and any domain turns on workspace-write network access", () => {
    expect(codexSandboxFlags(RUBY)).toEqual([
      "--add-dir", "/h/.rbenv/versions",
      "--add-dir", "/h/.gem",
      "-c", "sandbox_workspace_write.network_access=true",
    ]);
    const cmd = argv(new CodexRuntime(), { ...opts, sandbox: RUBY });
    expect(cmd.slice(0, 8)).toEqual(["x", "exec", "--json", "--skip-git-repo-check", "-m", "gpt", "--approve-for-me", "--add-dir"]);
    expect(cmd).not.toContain("/h/.bundle");
  });

  test("on resume the allowances precede the subcommand", () => {
    const cmd = argv(new CodexRuntime(), { ...opts, resume: true, sessionRef: "ref", sandbox: RUBY });
    const resume = cmd.indexOf("resume");
    expect(cmd.slice(resume)).toEqual(["resume", "ref", "Go"]);
    expect(cmd.indexOf("sandbox_workspace_write.network_access=true")).toBeLessThan(resume);
    expect(cmd.lastIndexOf("--add-dir")).toBeLessThan(resume);
  });

  test("read-only runs ignore allowances", () => {
    const ro = { ...opts, readOnly: true };
    expect(argv(new CodexRuntime(), { ...ro, sandbox: RUBY })).toEqual(argv(new CodexRuntime(), ro));
  });
});
