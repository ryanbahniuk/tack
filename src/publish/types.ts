export const PUBLISHER_KINDS = ["claude-artifact", "confluence", "google-doc", "local"] as const;
export type PublisherKind = (typeof PUBLISHER_KINDS)[number];
export function isPublisherKind(value: unknown): value is PublisherKind {
  return typeof value === "string" && (PUBLISHER_KINDS as readonly string[]).includes(value);
}
export interface PublishInput { file: string; title: string; description?: string; existingUrl?: string | null }
export interface PublishResult { url: string; warning?: string }
export interface PagePublisher {
  kind: PublisherKind;
  label: string;
  /** What the author step must produce for this destination. */
  format: "html" | "markdown";
  owns(url: string): boolean;
  publish(input: PublishInput): Promise<PublishResult>;
}
