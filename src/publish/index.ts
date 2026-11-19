import type { TackConfig } from "../config/schema";
import { claudeArtifactPublisher } from "./claude-artifact";
import { localPublisher } from "./local";
import type { PagePublisher } from "./types";
export function selectPublisher(config: TackConfig): PagePublisher {
  return config.readme?.publisher === "local" ? localPublisher : claudeArtifactPublisher(config);
}
