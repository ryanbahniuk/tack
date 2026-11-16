import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  bareVersion,
  installPlanFor,
  resolveOnPath,
  shadowWarning,
  versionChange,
} from "../src/runtimes/install";

// Pure decision/labelling helpers only — nothing here spawns bun or installs anything.

describe("installPlanFor", () => {
  test("unpinned (the starter default) installs the latest", () => {
    expect(installPlanFor(undefined)).toBe("latest");
    expect(installPlanFor({})).toBe("latest");
  });

  test("a version pin uses the managed pinned install", () => {
    expect(installPlanFor({ version: "2.1.261" })).toBe("pinned");
  });

  test("an explicit bin is verify-only, even when also pinned", () => {
    expect(installPlanFor({ bin: "~/.local/bin/codex" })).toBe("verify");
    expect(installPlanFor({ bin: "~/.local/bin/codex", version: "0.147.0" })).toBe("verify");
  });
});

describe("bareVersion", () => {
  test("extracts the semver from runtime --version output", () => {
    expect(bareVersion("2.1.300 (Claude Code)")).toBe("2.1.300");
    expect(bareVersion("codex-cli 0.147.0")).toBe("0.147.0");
    expect(bareVersion("codex-cli 0.148.0-alpha.2")).toBe("0.148.0-alpha.2");
  });

  test("falls back to the trimmed text when there's no semver", () => {
    expect(bareVersion("  dev build \n")).toBe("dev build");
  });
});

describe("versionChange", () => {
  test("no previous binary → installed", () => {
    expect(versionChange(null, "2.1.300 (Claude Code)")).toEqual({ action: "installed", label: "installed 2.1.300" });
  });

  test("a different previous version → upgraded A → B", () => {
    expect(versionChange("2.1.261 (Claude Code)", "2.1.300 (Claude Code)")).toEqual({
      action: "upgraded",
      label: "upgraded 2.1.261 → 2.1.300",
    });
  });

  test("the same version → already latest", () => {
    expect(versionChange("codex-cli 0.147.0", "codex-cli 0.147.0")).toEqual({
      action: "present",
      label: "already latest 0.147.0",
    });
  });
});

describe("shadowWarning", () => {
  const bunBin = "/home/u/.bun/bin";

  test("no warning when PATH resolves to bun's global bin", () => {
    expect(shadowWarning("claude", "/home/u/.bun/bin/claude", bunBin)).toBeNull();
  });

  test("names both paths and the PATH fix when another copy shadows it", () => {
    const w = shadowWarning("claude", "/home/u/.local/bin/claude", bunBin)!;
    expect(w).toContain("/home/u/.local/bin/claude");
    expect(w).toContain("/home/u/.bun/bin/claude");
    expect(w).toContain(`export PATH="${bunBin}:$PATH"`);
  });

  test("warns when the runtime isn't on PATH at all", () => {
    expect(shadowWarning("codex", null, bunBin)).toContain("isn't on PATH");
  });

  test("honours a realpath-aware directory comparison", () => {
    const sameDir = (a: string, b: string) => a.replace("/link", "/home/u/.bun") === b;
    expect(shadowWarning("codex", "/link/bin/codex", bunBin, sameDir)).toBeNull();
  });
});

describe("resolveOnPath", () => {
  test("returns the first executable match in PATH order", () => {
    const root = mkdtempSync(join(tmpdir(), "tack-path-"));
    const [a, b] = [join(root, "a"), join(root, "b")];
    for (const dir of [a, b]) {
      mkdirSync(dir);
      writeFileSync(join(dir, "claude"), "#!/bin/sh\n");
    }
    chmodSync(join(b, "claude"), 0o755); // a's copy isn't executable, so it's skipped
    expect(resolveOnPath("claude", [a, b].join(delimiter))).toBe(join(b, "claude"));
    chmodSync(join(a, "claude"), 0o755);
    expect(resolveOnPath("claude", [a, b].join(delimiter))).toBe(join(a, "claude"));
    expect(resolveOnPath("codex", [a, b].join(delimiter))).toBeNull();
  });
});
