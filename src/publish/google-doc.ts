import type { TackConfig } from "../config/schema";
import { connectorResult, PUBLISH_REPORT_INSTRUCTIONS, runPublishTurn, type PublishRunner } from "./connector";
import type { PagePublisher } from "./types";

export function ownsGoogleDocUrl(url: string): boolean {
  return /^https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+\S*$/.test(url);
}

export function googleDocPrompt(config: TackConfig, input: { file: string; title: string; existingUrl?: string | null }): string {
  const folderId = config.readme?.googleDoc?.folderId;
  const lines = [
    `Read the Markdown file ${input.file}. Publish its full contents as a native Google Doc (a Google Docs document converted from the Markdown, not an uploaded .md file) titled ${JSON.stringify(input.title)}.`,
    folderId ? `Create it in the Drive folder with id ${folderId}.` : "Create it in the user's My Drive.",
  ];
  if (input.existingUrl) lines.push(`A doc already exists at ${input.existingUrl}. If the available tools can replace that doc's content in place, replace it with the file's Markdown and keep its title ${JSON.stringify(input.title)}. Otherwise create a new doc as above and say that a new doc was created instead.`);
  lines.push(
    "Never add, change or widen sharing permissions; never share the doc with anyone, a group, a domain or by link.",
    "After publishing, list the doc's permissions. Report PRIVATE: yes only after confirming the owner is the only permission; report no if any other permission exists, or unverified if you could not check.",
    PUBLISH_REPORT_INSTRUCTIONS,
  );
  return lines.join("\n");
}

export function googleDocPublisher(config: TackConfig, runner?: PublishRunner): PagePublisher {
  const g = config.readme?.googleDoc ?? {};
  const server = g.mcpServer ?? "claude_ai_Google_Drive";
  return { kind: "google-doc", label: "Google Doc", format: "markdown", owns: ownsGoogleDocUrl, async publish(input) {
    const allowTools = ["Read", ...(g.tools?.length ? g.tools : [`mcp__${server}`])];
    const text = await runPublishTurn(config, input.file, googleDocPrompt(config, input), { allowTools, inheritUserMcp: true, runner });
    return connectorResult(text, { label: "Google Doc", owns: ownsGoogleDocUrl, file: input.file, hint: `Check that the Google Drive connector is connected in claude (claude mcp list) and that readme.googleDoc.mcpServer matches its name (currently "${server}").` });
  } };
}
