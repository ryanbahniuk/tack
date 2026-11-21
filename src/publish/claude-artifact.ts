import type { TackConfig } from "../config/schema";
import { runPublishTurn, type PublishRunner } from "./connector";
import type { PagePublisher } from "./types";

export function parseArtifactUrl(text: string): string | undefined {
  const matches = text.match(/https:\/\/claude\.ai\/[A-Za-z0-9_\-/]*artifact\/[A-Za-z0-9_\-/?=&%#]+/gi);
  return matches?.at(-1);
}

export function claudeArtifactPublisher(config: TackConfig, runner?: PublishRunner): PagePublisher {
  return { kind: "claude-artifact", label: "Claude Artifact", format: "html", owns: (url) => parseArtifactUrl(url) === url, async publish(input) {
    const prompt = `Read the HTML file ${input.file}. ${input.existingUrl ? `First call Artifact with action: "read" on ${input.existingUrl}. Then publish using url: ${input.existingUrl} to retain the link.` : "Publish a new private artifact."} Use the Artifact tool with file_path: ${input.file}, icon: "book", title: ${input.title}, description: ${input.description ?? "Session README"}. Finish with a final line ARTIFACT_URL: <url>.`;
    const url = parseArtifactUrl(await runPublishTurn(config, input.file, prompt, { allowTools: ["Read", "Artifact"], runner }));
    if (!url) throw new Error(`Artifact publisher returned no valid URL; the local file remains at ${input.file}`);
    return { url };
  } };
}
