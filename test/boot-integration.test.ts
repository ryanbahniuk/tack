import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as connection from "../src/db/connection";
import { migrate, createSession, createAgent, setAgentWorktree, getBootLink } from "../src/db";
import { bootSession, unbootSession } from "../src/boot";
import { processAlive } from "../src/boot/exec";
import { loadConfig } from "../src/config/load";
import type { TackConfig } from "../src/config/schema";

const dir = mkdtempSync(join(tmpdir(), "tack-boot-integration-"));

test("config rejects an unknown recipe", async () => {
  const file = join(dir, "invalid-config.ts");
  writeFileSync(file, `export default { models: [{ key: "m", provider: "p", name: "m", version: "1", runtime: "codex", id: "m" }], roles: { supervisor: "m", agent: "m", summary: "m" }, projects: [{ name: "web", path: "/tmp", description: "web", boot: { recipe: "missing" } }] }`);
  await expect(loadConfig(file)).rejects.toThrow('projects.web.boot.recipe = "missing"');
});

test("locks, stealing, reboots and stored teardown", async () => {
  const db = new Database(":memory:"); migrate(db);
  const mock = spyOn(connection, "getDb").mockReturnValue(db);
  const first = createSession({}); const second = createSession({});
  const a = createAgent({ sessionId: first.id, projectName: "web" });
  const b = createAgent({ sessionId: second.id, projectName: "web" });
  setAgentWorktree(a.id, dir, "first"); setAgentWorktree(b.id, dir, "second");
  const config = { bootRecipes: {}, projects: [{ name: "web", path: dir, description: "web", boot: { up: ["echo up >> events"], down: ["echo down >> events"], run: "sleep 30" } }] } as unknown as TackConfig;
  try {
    expect(bootSession(config, first.id)[0]?.status).toBe("booted");
    const pid = getBootLink("web")!.pid!; expect(processAlive(pid)).toBe(true);
    expect(bootSession(config, second.id)[0]).toMatchObject({ status: "locked", holder: first.id });
    expect(bootSession(config, second.id, { steal: true })[0]?.status).toBe("booted");
    expect(getBootLink("web")?.session_id).toBe(second.id);
    expect(bootSession(config, second.id)[0]?.status).toBe("booted");
    config.projects[0]!.boot!.down = ["echo changed >> events"];
    const finalPid = getBootLink("web")!.pid!;
    expect(unbootSession(config, second.id)[0]?.status).toBe("booted");
    for (let i = 0; i < 50 && processAlive(finalPid); i++) await Bun.sleep(10);
    expect(processAlive(finalPid)).toBe(false);
    expect(readFileSync(join(dir, "events"), "utf8").trim().split("\n")).toEqual(["up", "down", "up", "down", "up", "down"]);
    expect(getBootLink("web")).toBeNull();
  } finally { unbootSession(config, first.id); unbootSession(config, second.id); mock.mockRestore(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("shell steps can write through another SQLite connection", () => {
  const root = mkdtempSync(join(tmpdir(), "tack-boot-db-"));
  const dbPath = join(root, "state.db"); const db = new Database(dbPath); migrate(db);
  const mock = spyOn(connection, "getDb").mockReturnValue(db);
  const session = createSession({}); const agent = createAgent({ sessionId: session.id, projectName: "web" });
  setAgentWorktree(agent.id, root, "main");
  const script = join(root, "write.ts");
  writeFileSync(script, `import { Database } from "bun:sqlite"; const db = new Database(${JSON.stringify(dbPath)}); db.exec("PRAGMA busy_timeout=250; INSERT INTO boot_probe VALUES ('ok')"); db.close();`);
  db.exec("CREATE TABLE boot_probe (value TEXT)");
  const command = `'${process.execPath.replace(/'/g, "'\\''")}' '${script.replace(/'/g, "'\\''")}'`;
  const config = { bootRecipes: {}, projects: [{ name: "web", path: root, description: "web", boot: { up: [command], down: [command] } }] } as unknown as TackConfig;
  try {
    expect(bootSession(config, session.id)[0]?.status).toBe("booted");
    expect(unbootSession(config, session.id)[0]?.status).toBe("booted");
    expect(db.query("SELECT COUNT(*) AS n FROM boot_probe").get()).toEqual({ n: 2 });
  } finally { mock.mockRestore(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a stolen claim cannot finalize and cleans up its own process", async () => {
  const root = mkdtempSync(join(tmpdir(), "tack-boot-stolen-")); const db = new Database(":memory:"); migrate(db);
  const mock = spyOn(connection, "getDb").mockReturnValue(db);
  const session = createSession({}); const other = createSession({}); const agent = createAgent({ sessionId: session.id, projectName: "web" });
  setAgentWorktree(agent.id, root, "main");
  const config = { bootRecipes: {}, projects: [{ name: "web", path: root, description: "web", boot: { up: ["true"], run: "sleep 30", down: ["touch cleaned"] } }] } as unknown as TackConfig;
  try {
    const result = bootSession(config, session.id, { onProgress: msg => {
      if (msg === "web: sleep 30") db.query("UPDATE boot_links SET session_id = ? WHERE lock = ?").run(other.id, "web");
    } });
    expect(result[0]).toMatchObject({ status: "locked", holder: other.id });
    expect(getBootLink("web")?.session_id).toBe(other.id);
    expect(readFileSync(join(root, "cleaned"), "utf8")).toBe("");
  } finally { mock.mockRestore(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a stale booting claim can be taken without steal", () => {
  const root = mkdtempSync(join(tmpdir(), "tack-boot-stale-")); const db = new Database(":memory:"); migrate(db);
  const mock = spyOn(connection, "getDb").mockReturnValue(db);
  const first = createSession({}); const second = createSession({}); const agent = createAgent({ sessionId: second.id, projectName: "web" });
  setAgentWorktree(agent.id, root, "main");
  db.query("INSERT INTO boot_links (lock, session_id, project_name, status, updated_at) VALUES (?, ?, ?, ?, ?)").run("web", first.id, "web", "booting", new Date(Date.now() - 16 * 60_000).toISOString());
  const config = { bootRecipes: {}, projects: [{ name: "web", path: root, description: "web", boot: { up: ["true"] } }] } as unknown as TackConfig;
  try {
    expect(bootSession(config, second.id)[0]?.status).toBe("booted");
    expect(getBootLink("web")).toMatchObject({ session_id: second.id, status: "running" });
    unbootSession(config, second.id);
  } finally { mock.mockRestore(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
