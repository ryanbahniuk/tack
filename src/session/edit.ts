import { execFileSync } from "node:child_process";
import type { AgentRow, SessionPrRow } from "../db";

type EditTarget =
  | { ok: true; agent: AgentRow; path: string }
  | { ok: false; reason: "not_found" | "no_worktree" | "none" | "ambiguous" | "running"; candidates?: AgentRow[]; message: string };

/** Resolve before touching the terminal: the CLI must never silently pick one of
 * several trees, and a running writer needs an explicit override in either UI.
 * Manual workspaces resolve like any worker but never need the override: no runtime
 * ever writes to them. */
export function resolveEditTarget(
  agents: AgentRow[], agentId: string | undefined, exists: (p: string) => boolean,
  opts: { force?: boolean } = {},
): EditTarget {
  let agent: AgentRow;
  if (agentId !== undefined) {
    const found = agents.find(a => a.id === agentId);
    if (!found) return { ok: false, reason: "not_found", message: `Agent ${agentId} is not in this session.` };
    if (!found.worktree_path || !exists(found.worktree_path))
      return { ok: false, reason: "no_worktree", message: `Agent ${agentId} has no worktree on disk.` };
    agent = found;
  } else {
    const candidates = agents.filter(a => a.worktree_path !== null && exists(a.worktree_path));
    if (!candidates.length) return { ok: false, reason: "none", message: "No agent worktrees exist on disk for this session." };
    if (candidates.length > 1) return { ok: false, reason: "ambiguous", candidates, message: "Several agent worktrees exist. Pass an agent id." };
    agent = candidates[0]!;
  }
  if (!opts.force && agent.kind !== "manual" && (agent.status === "pending" || agent.status === "running"))
    return { ok: false, reason: "running", message: `Agent ${agent.id} is still running. Use --force to edit its worktree anyway.` };
  return { ok: true, agent, path: agent.worktree_path! };
}

/** Hints are copyable shell commands, so paths and remote refs must remain single
 * arguments even when the worktree lives under a directory containing spaces. */
const shellArg = (value: string) => /^[a-zA-Z0-9_./:@+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

/** Observe only: manual edits belong to the human until they commit/push or ask
 * the supervisor to open a PR. Comparing HEAD also catches already-committed edits. */
export function worktreeEditSummary(agent: AgentRow, prs: SessionPrRow[], path: string): string[] {
  const git = (...args: string[]) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
  const branch = git("branch", "--show-current") || agent.branch || "detached HEAD";
  const status = git("status", "--short");
  const lines = [`Branch: ${branch}`, status || "no uncommitted changes"];
  const pr = prs.find(pr => pr.agent_id === agent.id && (pr.state === "open" || pr.state === "draft"));
  if (pr && (status || git("rev-parse", "HEAD") !== pr.head_sha)) {
    lines.push("These edits aren't on the PR yet.");
    if (pr.head_branch) lines.push(`git -C ${shellArg(path)} commit -am "…" && git -C ${shellArg(path)} push origin ${shellArg(`HEAD:${pr.head_branch}`)}`);
    else lines.push("PR head branch is unavailable; refresh PR status before pushing.");
  } else if (!pr && agent.kind === "manual") {
    lines.push(`Ask the supervisor to open a PR for ${agent.id}; open_pr commits leftover changes when it opens the PR.`);
  } else if (!pr) {
    lines.push("The supervisor's open_pr commits leftover changes when it opens the PR.");
  }
  return lines;
}
