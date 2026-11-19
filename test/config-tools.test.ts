import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../src/config/load";
import { STARTER_CONFIG } from "../src/config/starter";
import { readConfigView, requestConfigUpdate } from "../src/mcp/supervisor-server";

const dirs: string[] = [];
function configFile(src = STARTER_CONFIG): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tack-config-tools-")));
  dirs.push(dir);
  const path = join(dir, "config.ts");
  writeFileSync(path, src);
  return path;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function client(result: unknown, capable = true) {
  const elicitInput = mock(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return {
    elicitInput,
    getClientCapabilities: () => (capable ? { elicitation: {} } : {}),
  } as unknown as Pick<McpServer["server"], "getClientCapabilities" | "elicitInput"> & { elicitInput: typeof elicitInput };
}
const change = [{ op: "set" as const, path: ["models", "gpt-6.1-sol", "effort"], value: "high" }];

test("read_config redacts MCP server env and reports effective values and the denylist", async () => {
  const path = configFile(STARTER_CONFIG.replace(
    "supervisorMcpServers: [",
    'supervisorMcpServers: [\n    { name: "Atlassian", command: "uvx", env: { TOKEN: "s3cret", SITE: "x" } },',
  ));
  const view = await readConfigView(path);
  expect(JSON.stringify(view)).not.toContain("s3cret");
  expect((view.authored.supervisorMcpServers as { env: unknown }[])[0]!.env).toEqual({ TOKEN: "<redacted>", SITE: "<redacted>" });
  expect(view.effective).toMatchObject({ draftPrs: true, roles: { agent: ["gpt-6.1-sol"] }, prWatch: { autoReady: true } });
  expect(view.denylisted).toContain("supervisorMcpServers");
  expect(view.denylisted).toContain("projects.<name>.boot");
  // Authored, not parsed: defaults the user never wrote aren't reported as authored.
  expect(view.authored.prWatch).toEqual({});
});

test("update_config writes only on accept, after showing the diff", async () => {
  const path = configFile();
  const c = client({ action: "accept", content: { confirm: true } });
  const result = await requestConfigUpdate(c, change, "Human asked for more effort", path);
  expect(result).toMatchObject({ written: true, changedPaths: ['models["gpt-6.1-sol"].effort'] });
  expect(result.note).toContain("tack session refresh");
  const [[request]] = c.elicitInput.mock.calls as unknown as [[{ message: string }]];
  expect(request.message).toContain("Reason: Human asked for more effort");
  expect(request.message).toContain('- models["gpt-6.1-sol"].effort');
  expect(request.message).toContain('+    { key: "gpt-6.1-sol"');
  const config = await loadConfig(path);
  expect(config.models.find((m) => m.key === "gpt-6.1-sol")!.effort).toBe("high");
});

for (const [label, c] of [
  ["decline", client({ action: "decline" })],
  ["cancel", client({ action: "cancel" })],
  ["accept with confirm unticked", client({ action: "accept", content: { confirm: false } })],
  ["no elicitation capability", client({ action: "accept", content: { confirm: true } }, false)],
  ["elicitation error", client(new Error("timed out"))],
] as const) {
  test(`update_config writes nothing on ${label}`, async () => {
    const path = configFile();
    const result = await requestConfigUpdate(c, change, "why", path);
    expect(result.written).toBe(false);
    expect(result.note).toContain("tack config edit");
    expect(readFileSync(path, "utf8")).toBe(STARTER_CONFIG);
  });
}

test("update_config returns validation errors without prompting", async () => {
  const path = configFile();
  const c = client({ action: "accept", content: { confirm: true } });
  const denied = await requestConfigUpdate(c, [{ op: "set", path: ["readAllowlist"], value: ["/"] }], "why", path);
  expect(denied).toMatchObject({ written: false });
  expect(denied.error).toContain("tack config edit");
  const invalid = await requestConfigUpdate(c, [{ op: "set", path: ["roles", "agent"], value: "nope" }], "why", path);
  expect(invalid.error).toContain("is not a defined model");
  expect(c.elicitInput).not.toHaveBeenCalled();
  expect(readFileSync(path, "utf8")).toBe(STARTER_CONFIG);
});

test("smoke: a scratch TACK_HOME starter config edited through the engine still loads", async () => {
  const path = configFile();
  const c = client({ action: "accept", content: { confirm: true } });
  const result = await requestConfigUpdate(c, [
    { op: "set", path: ["projects", "demo"], value: { name: "demo", path: "~/demo", description: "Demo repo." } },
    { op: "set", path: ["personas", "strict"], value: { name: "strict", description: "Be strict." } },
    { op: "set", path: ["roles", "agent"], value: ["gpt-6.1-sol", "opus-5"] },
    { op: "set", path: ["autoOpenPrs"], value: false },
  ], "setup", path);
  expect(result.written).toBe(true);
  const config = await loadConfig(path);
  expect(config.projects.map((p) => p.name)).toEqual(["demo"]);
  expect(config.personas.map((p) => p.name)).toEqual(["strict"]);
  expect(config.roles.agent).toEqual(["gpt-6.1-sol", "opus-5"]);
  expect(config.autoOpenPrs).toBe(false);
  // Comments outside the touched blocks survive.
  expect(readFileSync(path, "utf8")).toContain("// Pin the CLI runtimes.");
});
