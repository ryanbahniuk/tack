import type { TackConfig } from "../config/schema";
import { connectorResult, PUBLISH_REPORT_INSTRUCTIONS, runPublishTurn, type PublishRunner } from "./connector";
import type { PagePublisher } from "./types";

export const CONFLUENCE_TOOLS = ["atlassianUserInfo", "getAccessibleAtlassianResources", "getConfluenceSpaces", "getConfluencePage", "createConfluencePage", "updateConfluencePage"] as const;

export function ownsConfluenceUrl(url: string): boolean {
  return /^https:\/\/[a-z0-9-]+\.atlassian\.net\/wiki\/\S+$/i.test(url);
}

export function confluencePrompt(config: TackConfig, input: { file: string; title: string; existingUrl?: string | null }): string {
  const c = config.readme?.confluence ?? {};
  const site = c.site ? `Use the Atlassian site ${c.site}: call getAccessibleAtlassianResources and take the cloudId of that site.` : "Call getAccessibleAtlassianResources and take the cloudId of the only (or first) Confluence site.";
  const lines = [
    `Read the Markdown file ${input.file}. Publish its full contents to Confluence as a private page. Never share the page or change its restrictions to widen access.`,
    site,
  ];
  if (input.existingUrl) {
    lines.push(`A page already exists at ${input.existingUrl}. Find its page id from that URL, call getConfluencePage to confirm it exists, then call updateConfluencePage on it with contentFormat: "markdown", the file's Markdown as the body, and title: ${JSON.stringify(input.title)}. Keep it private. If that page cannot be found or updated, create a new page as described below instead and say so.`);
  }
  lines.push(
    c.spaceKey ? `Use the Confluence space with key ${c.spaceKey} (resolve its id via getConfluenceSpaces).` : "Use the current user's personal space: call atlassianUserInfo for the account, then getConfluenceSpaces with type personal to find that user's personal space.",
    `${input.existingUrl ? "To create a new page, call" : "Call"} createConfluencePage with the cloudId, that space, ${c.parentId ? `parentId: ${JSON.stringify(c.parentId)}, ` : ""}title: ${JSON.stringify(input.title)}, contentFormat: "markdown", isPrivate: true, status: "current", and the file's Markdown as the body.`,
    "Report PRIVATE: yes only if the page was created or updated with isPrivate: true (or is otherwise confirmed private); otherwise no or unverified.",
    PUBLISH_REPORT_INSTRUCTIONS,
  );
  return lines.join("\n");
}

export function confluencePublisher(config: TackConfig, runner?: PublishRunner): PagePublisher {
  const server = config.readme?.confluence?.mcpServer ?? "Atlassian";
  return { kind: "confluence", label: "Confluence", format: "markdown", owns: ownsConfluenceUrl, async publish(input) {
    const allowTools = ["Read", ...CONFLUENCE_TOOLS.map(t => `mcp__${server}__${t}`)];
    const text = await runPublishTurn(config, input.file, confluencePrompt(config, input), { allowTools, inheritUserMcp: true, runner });
    return connectorResult(text, { label: "Confluence", owns: ownsConfluenceUrl, file: input.file, hint: `Check that the Atlassian MCP is connected in claude (claude mcp list) and that readme.confluence.mcpServer matches its name (currently "${server}").` });
  } };
}
