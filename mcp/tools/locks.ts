import { MCPServer } from "mcp-use/server";
import { z } from "zod";
import type { WorkspaceState } from "../types.js";
import { DEFAULT_LOCK_TTL } from "../types.js";
import { generateId, now } from "../../shared/utils.js";

/** Register lock_file, unlock_file, check_locks, renew_lock tools. */
export function registerLockTools(
  server: MCPServer,
  workspace: WorkspaceState,
  clientAgents: Map<string, string>,
  bumpVersion: () => void,
): void {
  server.tool({
    name: "lock_file",
    description: "Lock a file before editing. Lock auto-expires after TTL (default 2 min). Use renew_lock to extend.",
    schema: z.object({
      path: z.string().min(1, "path is required").describe("File path to lock"),
      reason: z.string().optional().describe("What you're doing"),
      ttl: z.number().positive("ttl must be positive").optional().describe("Lock duration in ms (default 120000 = 2 min)"),
    }),
  }, async (args: any, ctx: any) => {
    const agentId = clientAgents.get(ctx?.session?.id || "");
    const agent = agentId ? workspace.agents.get(agentId) : null;

    if (!agent) {
      return { content: [{ type: "text" as const, text: "Join workspace first." }] };
    }
    agent.lastSeen = now();

    const existingLock = workspace.locks.get(args.path);
    if (existingLock && existingLock.agentId !== agentId) {
      if (existingLock.expiresAt > now()) {
        return {
          content: [{
            type: "text" as const,
            text: `LOCKED by ${existingLock.agentName} (${existingLock.client}, ${existingLock.role}). Expires in ${Math.ceil((existingLock.expiresAt - now()) / 1000)}s.`
          }]
        };
      }
    }

    const ttl = args.ttl ?? DEFAULT_LOCK_TTL;
    const ts = now();
    workspace.locks.set(args.path, {
      path: args.path,
      agentId: agent.id,
      agentName: agent.name,
      client: agent.client,
      role: agent.role,
      lockedAt: ts,
      expiresAt: ts + ttl,
      reason: args.reason,
    });

    agent.status = "working";
    agent.currentTask = args.path;
    bumpVersion();

    return {
      content: [{
        type: "text" as const,
        text: `Locked: ${args.path} (expires in ${ttl / 1000}s)`
      }]
    };
  });

  server.tool({
    name: "unlock_file",
    description: "Unlock a file when done.",
    schema: z.object({
      path: z.string().min(1, "path is required").describe("File path to unlock"),
      handoff_to: z.enum(["frontend", "backend", "tester", "any"]).optional(),
      message: z.string().optional().describe("Message for next agent"),
    }),
  }, async (args: any, ctx: any) => {
    const agentId = clientAgents.get(ctx?.session?.id || "");
    const agent = agentId ? workspace.agents.get(agentId) : null;

    if (agent) agent.lastSeen = now();

    const lock = workspace.locks.get(args.path);
    if (!lock || lock.agentId !== agentId) {
      return { content: [{ type: "text" as const, text: "Not your lock." }] };
    }

    workspace.locks.delete(args.path);

    if (agent) {
      agent.status = "idle";
      agent.currentTask = undefined;
    }

    if (args.handoff_to || args.message) {
      workspace.intents.push({
        id: generateId(),
        agentId: agentId || "unknown",
        agentName: agent?.name || "Unknown",
        client: agent?.client || "unknown",
        action: "handoff",
        description: args.message || `${args.path} ready`,
        target: args.handoff_to,
        timestamp: now(),
      });

      if (args.handoff_to) {
        workspace.handoffs.set(args.path, args.handoff_to);
      }
    }

    bumpVersion();
    return {
      content: [{
        type: "text" as const,
        text: `Unlocked: ${args.path}${args.handoff_to ? ` -> ${args.handoff_to}` : ''}`
      }]
    };
  });

  server.tool({
    name: "check_locks",
    description: "Check locked files with holder identity and time remaining.",
    schema: z.object({}),
  }, async () => {
    const ts = now();
    const locks = Array.from(workspace.locks.values());
    if (locks.length === 0) {
      return { content: [{ type: "text" as const, text: "No locks." }] };
    }
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(locks.map(l => ({
          path: l.path,
          holder: `${l.agentName} (${l.client}, ${l.role})`,
          reason: l.reason || null,
          expiresIn: l.expiresAt > ts ? `${Math.ceil((l.expiresAt - ts) / 1000)}s` : "EXPIRED",
        })), null, 2)
      }]
    };
  });

  server.tool({
    name: "renew_lock",
    description: "Extend an existing lock's TTL. Only the holder can renew.",
    schema: z.object({
      path: z.string().min(1, "path is required").describe("File path of the lock to renew"),
      ttl: z.number().positive("ttl must be positive").optional().describe("New TTL in ms (default 120000 = 2 min)"),
    }),
  }, async (args: any, ctx: any) => {
    const agentId = clientAgents.get(ctx?.session?.id || "");
    const lock = workspace.locks.get(args.path);

    if (!lock) {
      return { content: [{ type: "text" as const, text: `No lock on ${args.path}.` }] };
    }
    if (lock.agentId !== agentId) {
      return { content: [{ type: "text" as const, text: `Not your lock. Held by ${lock.agentName}.` }] };
    }

    const ttl = args.ttl ?? DEFAULT_LOCK_TTL;
    lock.expiresAt = now() + ttl;
    bumpVersion();

    return {
      content: [{
        type: "text" as const,
        text: `Renewed: ${args.path} (expires in ${ttl / 1000}s)`
      }]
    };
  });
}
