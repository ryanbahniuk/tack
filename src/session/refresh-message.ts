/** Synthetic opener used when restarting a supervisor on updated code or config. */
export const REFRESH_MESSAGE = "Tack has refreshed onto new code or config. Your tools and permissions may have changed. Re-run sync_projects before further investigation.";

/** Synthetic opener after `reconnect`: the laptop slept or lost its network, the
 * supervisor was restarted and agents the outage killed were relaunched. Steers
 * the supervisor back onto its existing plan rather than re-planning from scratch. */
export const RECONNECT_MESSAGE = "Tack reconnected this session after a lost network connection or sleep. Your previous turn may have been cut off, and agents that the outage killed have been restarted. Call check_agents (then wait_for_agents) to see where things stand, and carry on from where you left off. If a plan was awaiting approval, present it again.";
