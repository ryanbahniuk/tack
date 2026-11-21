import type { TackConfig } from "../config/schema";
import { claudeArtifactPublisher } from "./claude-artifact";
import { confluencePublisher } from "./confluence";
import { googleDocPublisher } from "./google-doc";
import { localPublisher } from "./local";
import { PUBLISHER_KINDS, type PagePublisher, type PublisherKind } from "./types";

export function publisherFor(config: TackConfig, kind: PublisherKind): PagePublisher {
  switch (kind) {
    case "local": return localPublisher;
    case "confluence": return confluencePublisher(config);
    case "google-doc": return googleDocPublisher(config);
    case "claude-artifact": return claudeArtifactPublisher(config);
  }
}

/** An explicit override wins; otherwise the configured default. */
export function selectPublisher(config: TackConfig, override?: PublisherKind): PagePublisher {
  return publisherFor(config, override ?? config.readme?.publisher ?? "claude-artifact");
}

/** The publisher whose destination owns `url`, if any. */
export function publisherOwning(config: TackConfig, url: string | null | undefined): PagePublisher | undefined {
  if (!url) return undefined;
  return PUBLISHER_KINDS.map(kind => publisherFor(config, kind)).find(p => p.owns(url));
}

/**
 * The destination a README run publishes to: an override, else (on refresh) the
 * destination that owns the session's current URL, else the config default.
 */
export function selectReadmePublisher(config: TackConfig, currentUrl: string | null | undefined, override?: PublisherKind): PagePublisher {
  if (override) return selectPublisher(config, override);
  return publisherOwning(config, currentUrl) ?? selectPublisher(config);
}

export { PUBLISHER_KINDS, isPublisherKind, type PagePublisher, type PublisherKind } from "./types";
