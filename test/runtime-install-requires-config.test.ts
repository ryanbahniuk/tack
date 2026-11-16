import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// First-run setup is explicit: `tack init` creates the config, then `tack runtimes
// install` installs runtimes. Install must refuse (before touching any runtime) and
// never scaffold a config on its own.
describe("tack runtimes install without a config", () => {
  test("exits non-zero, points at `tack init`, and writes no config", () => {
    const home = join(realpathSync(mkdtempSync(join(tmpdir(), "tack-install-noconfig-"))), "tack");
    const configPath = join(home, "config.ts");
    const result = Bun.spawnSync(
      [process.execPath, resolve(import.meta.dir, "../bin/tack.ts"), "runtimes", "install", "--no-models"],
      { env: { ...process.env, TACK_HOME: home }, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(`No config at ${configPath}. Run \`tack init\` first.`);
    expect(existsSync(configPath)).toBe(false);
  });
});
