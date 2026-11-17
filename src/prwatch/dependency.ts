import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

export type Ecosystem = "ruby" | "node" | "python" | "go";
export type Manifests = Record<string, string>;

/** Infer from names and contents alone; package versions are deliberately ignored. */
export function inferPackage(downstream: Manifests, upstream: Manifests): { ecosystem: Ecosystem; package: string } | null {
  const names = Object.keys(downstream);
  const has = (re: RegExp) => names.some(n => re.test(n));
  const gem = Object.keys(upstream).find(n => n.endsWith(".gemspec"));
  if (has(/^(Gemfile|.*\.gemspec)$/) && gem) {
    const name = upstream[gem]!.match(/\b\w+\.name\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? gem.slice(0, -8);
    if (name) return { ecosystem: "ruby", package: name };
  }
  if (has(/^package\.json$/) && upstream["package.json"]) {
    try { const name = JSON.parse(upstream["package.json"]).name; if (typeof name === "string" && name) return { ecosystem: "node", package: name }; } catch { /* malformed manifest */ }
  }
  if (has(/^(pyproject\.toml|setup\.py|requirements.*\.txt)$/) && upstream["pyproject.toml"]) {
    const section = upstream["pyproject.toml"].match(/^\[(?:project|tool\.poetry)\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
    const name = section?.match(/^\s*name\s*=\s*['"]([^'"]+)['"]/m)?.[1];
    if (name) return { ecosystem: "python", package: name };
  }
  if (has(/^go\.mod$/) && upstream["go.mod"]) {
    const name = upstream["go.mod"].match(/^module\s+(\S+)/m)?.[1];
    if (name) return { ecosystem: "go", package: name };
  }
  return null;
}
export function readManifests(path: string): Manifests {
  const result: Manifests = {};
  try { for (const n of readdirSync(path)) if (/^(Gemfile|.*\.gemspec|package\.json|pyproject\.toml|setup\.py|requirements.*\.txt|go\.mod)$/.test(n)) {
    try { result[n] = readFileSync(join(path, n), "utf8"); } catch { /* unavailable */ }
  } } catch { /* missing worktree */ }
  return result;
}
export function tagVersion(tag: string, pkg: string): string | null {
  let value = tag;
  for (const sep of ["-", "/", "@"]) if (value.startsWith(pkg + sep)) { value = value.slice(pkg.length + 1); break; }
  value = value.replace(/^v/, "");
  return /^\d+(?:\.\d+)*(?:\+[\w.-]+)?$/.test(value) ? value : null;
}
export type GhRunner = (args: string[], cwd: string) => Promise<string>;
export const runGh: GhRunner = (args, cwd) => new Promise((resolve, reject) => {
  const child = spawn("gh", args, { cwd }); let out = "", err = "";
  child.stdout.on("data", c => out += c); child.stderr.on("data", c => err += c);
  child.on("error", reject); child.on("close", code => code === 0 ? resolve(out) : reject(new Error(err)));
});
/** Releases carry timestamps; tag-only candidates are checked in API order (newest first).
 * Containment is authoritative even when GitHub does not expose tag creation dates. */
export async function findRelease(path: string, repo: string, sha: string, mergedAt: string, pkg: string, run: GhRunner = runGh): Promise<{tag: string; version: string} | null> {
  try {
    const releases = await run(["release", "list", "--limit", "100", "--json", "tagName,createdAt,isDraft,isPrerelease"], path).then(JSON.parse).catch(() => []);
    const tags: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const rows = await run(["api", `repos/${repo}/tags?per_page=100&page=${page}`], path).then(JSON.parse).catch(() => []);
      tags.push(...rows.map((r: {name: string}) => r.name)); if (rows.length < 100) break;
    }
    const excluded = new Set(releases.filter((r: any) => r.isDraft || r.isPrerelease || r.createdAt < mergedAt).map((r: any) => r.tagName));
    const releaseCandidates = releases.filter((r: any) => !excluded.has(r.tagName))
      .sort((a: any, b: any) => a.createdAt.localeCompare(b.createdAt)).map((r: any) => r.tagName as string);
    // The tags endpoint is newest first. A tag has no creation date in this API;
    // containment supplies the decisive check, and reversing gives oldest seen first.
    const candidates: string[] = [...releaseCandidates, ...tags.reverse()];
    const seen = new Set<string>();
    const eligible = candidates.filter(tag => tagVersion(tag, pkg) && !excluded.has(tag));
    const prefixed = (tag: string) => ["-", "/", "@"].some(sep => tag.startsWith(pkg + sep));
    for (const tag of [...eligible.filter(prefixed), ...eligible.filter(tag => !prefixed(tag))]) {
      if (seen.has(tag)) continue; seen.add(tag);
      const comparison = await run(["api", `repos/${repo}/compare/${encodeURIComponent(sha)}...${encodeURIComponent(tag)}`], path).then(JSON.parse).catch(() => null);
      if (comparison && ["ahead", "identical"].includes(comparison.status)) return { tag, version: tagVersion(tag, pkg)! };
    }
  } catch { /* best effort on every tick */ }
  return null;
}
