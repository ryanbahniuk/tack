import type { TackConfig } from "../config/schema";
import { getSession, getSessionPr, setSessionPrFixEnabled, setSessionPrFixEnabledForPr } from "../db";
import { triggerPrWatch } from "../prwatch/watch";

/**
 * Turn PR auto-fix on or off. Without `prId` this is the session switch (what hold
 * and unhold drive); with it, only that PR's own switch moves and the session flag
 * is left alone, so effective auto-fix is still `session && pr`. Enabling nudges the
 * watcher (just that PR's status when targeted) so waiting feedback is picked up
 * now rather than next interval.
 */
export async function setPrFix(sessionId: string, enabled: boolean, config: TackConfig, { prId }: { prId?: string } = {}): Promise<void> {
  if (!getSession(sessionId)) throw new Error(`Unknown session ${sessionId}`);
  if (prId) {
    const pr = getSessionPr(prId);
    if (!pr || pr.session_id !== sessionId) throw new Error(`PR ${prId} is not in session ${sessionId}`);
    setSessionPrFixEnabledForPr(prId, enabled);
  } else {
    setSessionPrFixEnabled(sessionId, enabled);
  }
  if (!enabled) return;
  try { await (prId ? triggerPrWatch(sessionId, config, undefined, { prId }) : triggerPrWatch(sessionId, config)); }
  catch { /* watcher retries on its next tick */ }
}
