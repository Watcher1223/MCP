import type { WorkspaceState } from "./types.js";
import { now, Logger } from "../shared/utils.js";

const log = new Logger("Stigmergy");

const STALE_THRESHOLD_MS = 5 * 60_000; // 5 minutes -> mark disconnected
const REMOVE_THRESHOLD_MS = 15 * 60_000; // 15 minutes -> remove entirely

/**
 * Periodically check agent `lastSeen` timestamps.
 * Agents unseen for 5 min get status "disconnected".
 * Agents unseen for 15 min are removed from the workspace entirely.
 */
export function startPresenceCleanup(
  workspace: WorkspaceState,
  bumpVersion: () => void,
): void {
  setInterval(() => {
    const ts = now();
    let changed = false;

    for (const [id, agent] of workspace.agents) {
      const elapsed = ts - agent.lastSeen;

      if (elapsed >= REMOVE_THRESHOLD_MS) {
        workspace.agents.delete(id);
        log.info(`Agent removed (stale 15m): ${agent.name}`);
        changed = true;
      } else if (elapsed >= STALE_THRESHOLD_MS && agent.status !== "disconnected") {
        agent.status = "disconnected";
        agent.currentTask = undefined;
        log.info(`Agent marked disconnected (stale 5m): ${agent.name}`);
        changed = true;
      }
    }

    if (changed) bumpVersion();
  }, 30_000);
}
