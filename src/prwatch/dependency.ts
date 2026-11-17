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
/** Release timestamps and tagged commit dates give one comparable ordering even
 * when a repository mixes releases and tags. Undated tags are skipped rather than
 * guessed; each tick retries transient API failures. Calls and pagination are bounded. */
export async function findRelease(path: string, repo: string, sha: string, mergedAt: string, pkg: string, run: GhRunner = runGh): Promise<{tag: string; version: string} | null> {
  try {
    type Release = { tagName: string; createdAt: string; isDraft: boolean; isPrerelease: boolean };
    type Tag = { name: string; commit?: { sha?: string } };
    const releases: Release[] = await run(["release", "list", "--limit", "100", "--json", "tagName,createdAt,isDraft,isPrerelease"], path).then(JSON.parse).catch(() => []);
    const tags: Tag[] = [];
    for (let page = 1; page <= 3; page++) {
      const rows: Tag[] = await run(["api", `repos/${repo}/tags?per_page=100&page=${page}`], path).then(JSON.parse).catch(() => []);
      tags.push(...rows); if (rows.length < 100) break;
    }
    const excluded = new Set(releases.filter(r => r.isDraft || r.isPrerelease).map(r => r.tagName));
    const candidates = new Map<string, number>();
    const afterMerge = Date.parse(mergedAt);
    for (const r of releases) {
      const date = Date.parse(r.createdAt);
      if (!excluded.has(r.tagName) && tagVersion(r.tagName, pkg) && Number.isFinite(date) && date >= afterMerge) candidates.set(r.tagName, date);
    }
    const releaseTags = new Set(releases.map(r => r.tagName));
    const tagOnly = tags.filter(t => !excluded.has(t.name) && !releaseTags.has(t.name) && tagVersion(t.name, pkg) && t.commit?.sha);
    // Avoid hundreds of concurrent gh processes on repositories with many tags.
    for (let i = 0; i < tagOnly.length; i += 8) {
      await Promise.all(tagOnly.slice(i, i + 8).map(async t => {
        const commit = await run(["api", `repos/${repo}/commits/${encodeURIComponent(t.commit!.sha!)}`], path).then(JSON.parse).catch(() => null);
        const date = Date.parse(commit?.commit?.committer?.date ?? "");
        // Tags are observed after merge, even when their commit predates it (for
        // example a tag pointing directly at the merge commit).
        if (Number.isFinite(date)) candidates.set(t.name, date);
      }));
    }
    const prefixed = (tag: string) => ["-", "/", "@"].some(sep => tag.startsWith(pkg + sep));
    const ordered = [...candidates].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    for (const [tag] of [...ordered.filter(([tag]) => prefixed(tag)), ...ordered.filter(([tag]) => !prefixed(tag))]) {
      const comparison = await run(["api", `repos/${repo}/compare/${encodeURIComponent(sha)}...${encodeURIComponent(tag)}`], path).then(JSON.parse).catch(() => null);
      if (comparison && ["ahead", "identical"].includes(comparison.status)) return { tag, version: tagVersion(tag, pkg)! };
    }
  } catch { /* best effort on every tick */ }
  return null;
}
