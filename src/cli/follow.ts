import { closeSync, openSync, readSync, fstatSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import pc from "picocolors";
import { agentArtifactPath } from "../artifacts/store";
import { getAgent, type AgentStatus } from "../db";

export function isTerminalAgentStatus(status: AgentStatus): boolean {
  return status === "done" || status === "failed" || status === "stopped";
}

/** Reads only new bytes; the decoder preserves UTF-8 characters split across reads. */
export function readTranscript(path: string, offset: number, decoder: StringDecoder): { text: string; offset: number; exists: boolean } {
  let fd: number;
  try { fd = openSync(path, "r"); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { text: "", offset, exists: false };
    throw err;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.min(offset, size);
    const buffer = Buffer.alloc(size - start);
    const count = readSync(fd, buffer, 0, buffer.length, start);
    return { text: decoder.write(buffer.subarray(0, count)), offset: start + count, exists: true };
  } finally { closeSync(fd); }
}

/** Follow a durable transcript without attaching to the agent's runtime. */
export async function followAgent(agentId: string): Promise<void> {
  const initial = getAgent(agentId);
  if (!initial) throw new Error(`Unknown agent ${agentId}`);
  const path = agentArtifactPath(initial.session_id, agentId, "transcript");
  console.log(`${pc.bold(agentId)} (${initial.runtime}:${initial.model}) · ${initial.status} · live`);
  let offset = 0;
  let waiting = false;
  let finished = false;
  let quit = false;
  const decoder = new StringDecoder("utf8");
  const stdin = process.stdin;
  const wasRaw = stdin.isTTY && stdin.isRaw;
  const onData = (data: Buffer) => {
    if (finished || data.includes(113) || data.includes(27) || data.includes(3)) quit = true;
  };
  const onSignal = () => { quit = true; };
  try {
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.resume();
    process.on("SIGINT", onSignal);
    while (!quit) {
      const chunk = readTranscript(path, offset, decoder);
      offset = chunk.offset;
      if (!chunk.exists && !waiting) {
        console.log(pc.dim("waiting for the agent's first output…"));
        waiting = true;
      }
      if (chunk.text) process.stdout.write(chunk.text);
      const agent = getAgent(agentId);
      if (!agent) throw new Error(`Unknown agent ${agentId}`);
      if (isTerminalAgentStatus(agent.status)) {
        const tail = readTranscript(path, offset, decoder);
        process.stdout.write(tail.text + decoder.end());
        console.log(`\n${pc.bold(agent.status)}${agent.status === "failed" && agent.error ? ` · ${agent.error}` : ""}`);
        finished = true;
        if (!stdin.isTTY) break;
        console.log(pc.dim("press any key to return"));
        while (!quit) await new Promise(resolve => setTimeout(resolve, 100));
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  } finally {
    stdin.off("data", onData);
    process.off("SIGINT", onSignal);
    if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
    stdin.pause();
  }
}
