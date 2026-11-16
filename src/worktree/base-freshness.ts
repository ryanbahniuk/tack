import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_CACHE_DIR } from "../paths";

export interface BaseCacheFreshness { ref: string; sha: string; fetchedAt: number }
const cachePath = (project: string) => join(BASE_CACHE_DIR, `${encodeURIComponent(project)}.json`);
export function readBaseCacheFreshness(project: string): BaseCacheFreshness | null {
  try {
    const v = JSON.parse(readFileSync(cachePath(project), "utf8"));
    return typeof v.ref === "string" && typeof v.sha === "string" && typeof v.fetchedAt === "number" && Number.isFinite(v.fetchedAt) ? v : null;
  } catch { return null; }
}
export function isBaseCacheFresh(project: string, maxAgeMs: number, ref?: string): boolean {
  const v = readBaseCacheFreshness(project);
  return !!v && (!ref || v.ref === ref) && Date.now() >= v.fetchedAt && Date.now() - v.fetchedAt <= maxAgeMs;
}
export function recordBaseCacheFreshness(project: string, ref: string, sha: string): void {
  mkdirSync(BASE_CACHE_DIR, { recursive: true });
  const path = cachePath(project), temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify({ ref, sha, fetchedAt: Date.now() }));
  renameSync(temp, path);
}
