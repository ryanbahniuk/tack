import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LOGS_DIR } from "../paths";
import type { BootPlan } from "./recipe";

export function bootLogPath(session: string, project: string): string {
  return join(LOGS_DIR, session, `boot-${encodeURIComponent(project)}.log`);
}
function runCommand(plan: BootPlan, command: string, log: string): void {
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "a");
  try {
    const result = spawnSync("/bin/sh", ["-c", command], { cwd: plan.cwd, env: { ...process.env, ...plan.env }, stdio: ["ignore", fd, fd] });
    if (result.error || result.status !== 0) {
      const tail = readFileSync(log, "utf8").split("\n").slice(-20).join("\n");
      throw new Error(`Command failed: ${command} (exit ${result.status ?? result.error?.message ?? result.signal})\n${tail}`);
    }
  } finally { closeSync(fd); }
}
export function runSteps(plan: BootPlan, commands: string[], log: string, onProgress?: (message: string) => void): void {
  for (const command of commands) { onProgress?.(`${plan.project}: ${command}`); runCommand(plan, command, log); }
}
export function startRun(plan: BootPlan, log: string): number | null {
  if (!plan.run) return null;
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "a");
  try {
    const child = spawn("/bin/sh", ["-c", plan.run], { cwd: plan.cwd, env: { ...process.env, ...plan.env }, detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
    if (!child.pid) throw new Error("Failed to start boot process.");
    return child.pid;
  } finally { closeSync(fd); }
}
export function stopRun(pid: number | null): void {
  if (!pid) return;
  try { process.kill(-pid, "SIGTERM"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; return; }
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) { try { process.kill(-pid, 0); } catch { return; } Bun.sleepSync(20); }
  try { process.kill(-pid, "SIGKILL"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
}
export function processAlive(pid: number | null): boolean { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
export function probe(plan: BootPlan, log: string): boolean | null {
  if (!plan.status) return null;
  try { runCommand(plan, plan.status, log); return true; } catch { return false; }
}
