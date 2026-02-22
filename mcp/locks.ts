import type { WorkspaceState } from "./types.js";
import { generateId, now, Logger } from "../shared/utils.js";

const log = new Logger("Stigmergy");

/** Evict expired locks every 5 seconds. Emits a handoff intent so agents know the path is free. */
export function startLockCleanup(
  workspace: WorkspaceState,
  bumpVersion: () => void,
): void {
  setInterval(() => {
    const ts = now();
    const expired: string[] = [];

    workspace.locks.forEach((lock, path) => {
      if (lock.expiresAt <= ts) {
        expired.push(path);
      }
    });

    for (const path of expired) {
      const lock = workspace.locks.get(path);
      if (!lock) continue;
      workspace.locks.delete(path);

      const agent = workspace.agents.get(lock.agentId);
      if (agent && agent.currentTask === path) {
        agent.status = "idle";
        agent.currentTask = undefined;
      }

      workspace.intents.push({
        id: generateId(),
        agentId: lock.agentId,
        agentName: lock.agentName,
        client: lock.client,
        action: "handoff",
        description: `Lock expired on ${path}`,
        target: undefined,
        timestamp: ts,
      });

      log.info(`Lock expired: ${path} (was held by ${lock.agentName})`);
    }

    if (workspace.intents.length > 50) {
      workspace.intents = workspace.intents.slice(-50);
    }

    if (expired.length > 0) {
      bumpVersion();
    }
  }, 5_000);
}
