import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRoleInConfig } from "../src/config/edit";
import { loadConfig, modelForRole, roleModelKeys } from "../src/config/load";
import type { Roles } from "../src/config/schema";

const models = ["a", "b", "c"].map((key) => ({
  key, provider: "test", name: key, version: "1", runtime: "codex", id: key,
}));
const dirs: string[] = [];
const prefix = "// Preserve this comment.\nexport default {\n  models: " + JSON.stringify(models) + ",\n  ";
const suffix = ",\n  projects: [], // Preserve this too.\n};\n";
function configFile(roles: Roles): string {
  const dir = mkdtempSync(join(tmpdir(), "tack-roles-"));
  dirs.push(dir);
  const path = join(dir, "config.ts");
  writeFileSync(path, prefix + "roles: " + JSON.stringify(roles) + suffix);
  return path;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("role config", () => {
  test("normalizes legacy strings for every role", async () => {
    const config = await loadConfig(configFile({ supervisor: "a", agent: "b", summary: "c" }));
    expect(config.roles).toEqual({ supervisor: ["a"], agent: ["b"], summary: ["c"] });
    expect(config.draftPrs).toBe(true);
    expect(config.prWatch.autoReady).toBe(true);
    expect(roleModelKeys(config, "agent")).toEqual(["b"]);
  });

  test("loads explicit draft and auto-ready opt-outs", async () => {
    const path = configFile({ supervisor: "a", agent: "b", summary: "c" });
    writeFileSync(path, readFileSync(path, "utf8").replace("export default {", "export default { draftPrs: false, prWatch: { autoReady: false },"));
    const config = await loadConfig(path);
    expect(config.draftPrs).toBe(false);
    expect(config.prWatch.autoReady).toBe(false);
  });

  test("normalizes arrays and removes duplicates in order", async () => {
    const config = await loadConfig(configFile({ supervisor: ["a"], agent: ["b", "a", "b", "c"], summary: ["c", "c"] }));
    expect(config.roles).toEqual({ supervisor: ["a"], agent: ["b", "a", "c"], summary: ["c"] });
  });

  test("rejects empty lists and empty keys", async () => {
    for (const agent of [[], [""]]) {
      await expect(loadConfig(configFile({ supervisor: "a", agent, summary: "c" }))).rejects.toThrow();
    }
  });

  test("validates every key and identifies the role, bad key, and known keys", async () => {
    await expect(loadConfig(configFile({ supervisor: "a", agent: ["b", "missing"], summary: "c" })))
      .rejects.toThrow('roles.agent = "missing" is not a defined model. Known: a, b, c');
  });

  test("picks equal-width random buckets including both ends", async () => {
    const config = await loadConfig(configFile({ supervisor: "a", agent: ["a", "b", "c"], summary: "c" }));
    for (const [rng, key] of [[0, "a"], [0.32, "a"], [1 / 3, "b"], [0.5, "b"], [2 / 3, "c"], [0.999999, "c"]] as const) {
      expect(modelForRole(config, "agent", () => rng).key).toBe(key);
    }
    expect(modelForRole(config, "supervisor", () => { throw new Error("single candidate must not roll"); }).key).toBe("a");
  });

  test("edits string to array to string and preserves content outside roles", async () => {
    const path = configFile({ supervisor: ["a"], agent: "a", summary: "c" });
    expect(await setRoleInConfig(path, "agent", ["b", "c"])).toBe("a");
    expect(readFileSync(path, "utf8")).toBe(prefix + 'roles: {\n    supervisor: "a",\n    agent: ["b", "c"],\n    summary: "c",\n  }' + suffix);
    expect((await loadConfig(path)).roles.agent).toEqual(["b", "c"]);
    expect(await setRoleInConfig(path, "agent", "a")).toEqual(["b", "c"]);
    expect((await loadConfig(path)).roles.agent).toEqual(["a"]);
    expect(readFileSync(path, "utf8")).toContain('agent: "a",');
    await setRoleInConfig(path, "agent", ["b"]);
    expect(readFileSync(path, "utf8")).toContain('agent: "b",');
  });
});
