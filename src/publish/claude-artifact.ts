import { dirname } from "node:path";
import type { TackConfig } from "../config/schema";
import { resolveRuntime, selectRuntime } from "../runtimes";
import type { RunOptions, AgentEvent } from "../runtimes/types";
import type { PagePublisher } from "./types";

export function parseArtifactUrl(text: string): string | undefined {
  const matches = text.match(/https:\/\/claude\.ai\/[A-Za-z0-9_\-/]*artifact\/[A-Za-z0-9_\-/?=&%#]+/gi);
  return matches?.at(-1);
}

export function claudeArtifactPublisher(config: TackConfig, runner?: (opts: RunOptions) => AsyncIterable<AgentEvent>): PagePublisher {
  return { kind: "claude-artifact", label: "Claude Artifact", async publish(input) {
    const model = config.models.find(m => m.runtime === "claude") ?? { key: "artifact-publisher", provider: "anthropic", name: "Claude", version: "default", runtime: "claude" as const, id: "sonnet" };
    const runtime = selectRuntime("claude");
    const bin = runner ? "claude" : resolveRuntime(config, "claude").bin;
    const prompt = `Read the HTML file ${input.file}. ${input.existingUrl ? `First call Artifact with action: "read" on ${input.existingUrl}. Then publish using url: ${input.existingUrl} to retain the link.` : "Publish a new private artifact."} Use the Artifact tool with file_path: ${input.file}, icon: "book", title: ${input.title}, description: ${input.description ?? "Session README"}. Finish with a final line ARTIFACT_URL: <url>.`;
    let text = "", summary = "";
    for await (const ev of (runner ?? ((opts) => runtime.run(opts)))({ prompt, cwd: dirname(input.file), model, bin, readOnly: true, disallowShell: true, addDirs: [dirname(input.file)], logPath: `${input.file}.publish.log`, allowTools: ["Read", "Artifact"] })) {
      if (ev.type === "text") text += ev.text;
      else if (ev.type === "done") summary = ev.summary ?? "";
      else if (ev.type === "error") throw new Error(ev.message);
    }
    const url = parseArtifactUrl(text || summary);
    if (!url) throw new Error(`Artifact publisher returned no valid URL; the local file remains at ${input.file}`);
    return { url };
  } };
}
