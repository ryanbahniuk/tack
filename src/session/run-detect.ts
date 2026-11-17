import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunOverride } from "../config/schema";

export interface RunSpec {
  command: string; setup: string[]; setupInputs: string[]; port: number; portEnv: string;
  env: Record<string, string>; copyFiles: string[]; requires: string[]; readyPath: string;
  readyTimeoutSeconds: number; source: "detected" | "config" | "mixed"; detectedBy?: string;
  setupCheck?: string; warnings: string[];
}
const inputs = ["yarn.lock", "package-lock.json", "bun.lock", "bun.lockb", "pnpm-lock.yaml", "Gemfile.lock", "go.sum"];
export function detectRun(tree: string): RunSpec | undefined {
  const has = (p: string) => existsSync(join(tree, p));
  const base = { setupInputs: inputs.filter(has), portEnv: "PORT", env: {}, copyFiles: [], requires: [], readyPath: "/", readyTimeoutSeconds: 120, source: "detected" as const, warnings: [] as string[] };
  if (has("package.json")) {
    let pkg: any; try { pkg = JSON.parse(readFileSync(join(tree, "package.json"), "utf8")); } catch { pkg = {}; }
    const script = pkg.scripts?.dev ? "dev" : pkg.scripts?.start ? "start" : undefined;
    if (script) {
      const text = String(pkg.scripts[script]);
      const pm = String(pkg.packageManager ?? "").split("@")[0] || (has("yarn.lock") ? "yarn" : has("pnpm-lock.yaml") ? "pnpm" : has("bun.lock") || has("bun.lockb") ? "bun" : "npm");
      const framework = /\bnext\b/.test(text) ? "next" : /\bvite\b/.test(text) ? "vite" : "node";
      const flag = /(?:^|\s)(?:-p|--port)(?:\s+|=)(\d+)\b/.exec(text);
      const port = flag ? Number(flag[1]) : framework === "vite" ? 5173 : 3000;
      let command = `${pm} run ${script}`;
      if (flag && !/[;&|]/.test(text)) {
        const rewritten = text.replace(/((?:^|\s)(?:-p|--port)(?:\s+|=))\d+\b/, "$1${port}");
        command = `${pm === "yarn" ? "yarn" : pm === "pnpm" ? "pnpm exec" : pm === "bun" ? "bunx" : "npx"} ${rewritten}`;
      } else if (flag) base.warnings.push(`Script hardcodes port ${port}; Tack may not be able to override it.`);
      return { ...base, command, setup: [`${pm} install`], setupCheck: "node_modules", port, detectedBy: `package.json ${script} script (${pm}, ${framework})` };
    }
  }
  if (has("Gemfile") && (has("bin/rails") || has("config/application.rb"))) return { ...base, command: "bin/rails server -p ${port}", setup: ["bundle install"], port: 3000, detectedBy: "Rails" };
  if (has("Procfile")) {
    const line = readFileSync(join(tree, "Procfile"), "utf8").match(/^web:\s*(.+)$/m);
    if (line) return { ...base, command: line[1]!.replace(/\$\{PORT\}|\$PORT\b/g, "${port}"), setup: [], port: 5000, detectedBy: "Procfile web" };
  }
}
export function mergeRun(detected: RunSpec, override: RunOverride): RunSpec {
  return { ...detected, ...override, env: { ...detected.env, ...override.env }, source: detected.source === "detected" && Object.keys(override).length ? "mixed" : detected.source };
}
export function resolveRun(tree: string, override?: RunOverride | false, main?: string): RunSpec | undefined {
  if (override === false) return;
  const detected = detectRun(tree);
  if (!detected && !override?.command) return;
  const defaults: RunSpec = { command: "", setup: [], setupInputs: inputs.filter(p => existsSync(join(tree, p))), port: 3000, portEnv: "PORT", env: {}, copyFiles: [], requires: [], readyPath: "/", readyTimeoutSeconds: 120, source: "config", warnings: [] };
  const spec = mergeRun(detected ?? defaults, override ?? {});
  if (override?.copyFiles === undefined && main && main !== tree && existsSync(join(main, ".env"))) spec.copyFiles = [".env"];
  return spec;
}
export function template(value: string, own: { port: number; tree: string }, apps: Record<string, { port: number }>): string {
  return value.replace(/\$\{(port|url|worktree)(?::([^}]+))?\}/g, (_, key: string, name?: string) => {
    if (name && (key === "worktree" || !apps[name])) throw new Error(`Unknown or unbooted project: ${name}`);
    const port = name ? apps[name]!.port : own.port;
    return key === "worktree" ? own.tree : key === "url" ? `http://localhost:${port}` : String(port);
  });
}
export function envRewrites(tree: string, name: string, apps: { name: string; preferred: number; port: number }[], configured: Record<string,string>, warn: (s: string) => void): Record<string,string> {
  const values: Record<string,string> = {};
  for (const file of [".env.example", ".env.sample", ".env"]) {
    try { for (const line of readFileSync(join(tree, file), "utf8").split(/\r?\n/)) { const m = line.match(/^\s*(?:export\s+)?([\w]+)\s*=\s*["']?([^"'\s#]+)["']?/); if (m) values[m[1]!] = m[2]!; } } catch { /* optional */ }
  }
  const result: Record<string,string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (key in configured) continue;
    const m = value.match(/^https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)\/?$/); if (!m) continue;
    const matches = apps.filter(a => a.name !== name && a.preferred === Number(m[1]));
    if (matches.length > 1) warn(`${name}: ${key} is ambiguous; set an explicit env entry.`);
    if (matches.length === 1) { const other = matches[0]!; result[key] = `http://localhost:${other.port}`; warn(`${name}: ${key} → ${result[key]} (${other.name})`); }
  }
  return result;
}
