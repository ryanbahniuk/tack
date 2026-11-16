import type { TackConfig } from "../config/schema";
import { getSession, setSessionPrFixEnabled } from "../db";
import { triggerPrWatch } from "../prwatch/watch";

export async function setPrFix(sessionId: string, enabled: boolean, config: TackConfig): Promise<void> {
  if (!getSession(sessionId)) throw new Error(`Unknown session ${sessionId}`);
  setSessionPrFixEnabled(sessionId, enabled);
  if (enabled) try { await triggerPrWatch(sessionId, config); } catch { /* watcher retries on its next tick */ }
}
