import { afterEach, expect, spyOn, test } from "bun:test";
import type { Model, TackConfig } from "../src/config/schema";
import { createSession, deleteSession, setAgentResumeRef } from "../src/db";
import { prepareAgent, runAgent } from "../src/agent/execute";
import { runAgentToCompletion } from "../src/agent/detached";
import * as availability from "../src/runtimes/availability";
import * as resolution from "../src/runtimes/resolve";
import * as worktrees from "../src/worktree/worktree";
import { ClaudeRuntime } from "../src/runtimes/claude";
import { CodexRuntime } from "../src/runtimes/codex";
import type { AgentEvent, RunOptions } from "../src/runtimes/types";

const mocks: Array<{ mockRestore(): void }> = [];
const sessions: string[] = [];
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore();
  for (const id of sessions.splice(0)) deleteSession(id);
});

for (const kind of ["claude", "codex"] as const) {
  for (const mode of ["restore", "no handle", "ordinary"] as const) {
    test(`${kind}: ${mode} uses the correct conversation and prompt`, async () => {
      const session = createSession({});
      sessions.push(session.id);
      const model: Model = { key: "test", id: "test-model", runtime: kind, provider: "test", name: "Test", version: "1" };
      const project = { name: "test", path: "/tmp", description: "Test" };
      const config = { models: [model], projects: [project], roles: { agent: model.key } } as TackConfig;
      const agent = prepareAgent({ session, project, model, prompt: "Original task" });
      if (mode !== "no handle") setAgentResumeRef(agent.id, "prior-conversation");
      mocks.push(spyOn(availability, "checkModelOffered").mockReturnValue({ ok: true }));
      mocks.push(spyOn(resolution, "resolveRuntime").mockReturnValue({ kind, bin: kind, version: "test", policy: "off", satisfied: true }));
      mocks.push(spyOn(worktrees, "ensureWorktree").mockReturnValue({ repo: "/tmp", path: "/tmp", branch: "test", base: "HEAD" }));
      mocks.push(spyOn(worktrees, "worktreeDiff").mockReturnValue(""));
      const seen: RunOptions[] = [];
      const prototype = kind === "claude" ? ClaudeRuntime.prototype : CodexRuntime.prototype;
      mocks.push(spyOn(prototype, "run").mockImplementation(async function* (opts: RunOptions): AsyncGenerator<AgentEvent> {
        seen.push(opts);
        yield { type: "done", ok: true };
      }));
      // Exercise the detached runner's forwarding too; it is the unarchive entrypoint.
      await runAgentToCompletion(agent.id, config, { resume: mode !== "ordinary" });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.resume).toBe(mode === "restore");
      expect(seen[0]!.prompt).toBe(mode === "restore"
        ? "You were interrupted; continue the task where you left off."
        : "Original task");
      if (mode === "restore") expect(seen[0]!.sessionRef).toBe("prior-conversation");
      else expect(seen[0]!.sessionRef).not.toBe("prior-conversation");
      // A later ordinary attempt must still be fresh even with a persisted handle.
      for await (const _ of runAgent(agent.id, config)) { /* drain */ }
      expect(seen[1]!.resume).toBe(false);
      expect(seen[1]!.prompt).toBe("Original task");
    });
  }
}
