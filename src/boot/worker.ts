import { bootSession, unbootSession } from "./index";
import type { TackConfig } from "../config/schema";

declare const self: { onmessage: ((event: MessageEvent<any>) => void) | null; postMessage: (data: unknown) => void };

// Shell steps can take arbitrarily long; the dashboard must keep rendering while
// a worker runs the synchronous boot operation.
self.onmessage = (event: MessageEvent<{ config: TackConfig; session: string; action: "boot" | "unboot"; agents: Record<string, string>; projects?: string[]; steal?: boolean }>) => {
  const { config, session, action, agents, projects, steal } = event.data;
  try {
    const results = action === "boot"
      ? bootSession(config, session, { agents, projects, steal, onProgress: message => self.postMessage({ progress: message }) })
      : unbootSession(config, session, { projects });
    self.postMessage({ results });
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
