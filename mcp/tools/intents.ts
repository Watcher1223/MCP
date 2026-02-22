import { MCPServer } from "mcp-use/server";
import { z } from "zod";
import type { WorkspaceState } from "../types.js";
import { generateId, now } from "../../shared/utils.js";

/** Register post_intent, read_intents, get_context, subscribe_changes tools. */
export function registerIntentTools(
  server: MCPServer,
  workspace: WorkspaceState,
  clientAgents: Map<string, string>,
  bumpVersion: () => void,
): void {
  server.tool({
    name: "post_intent",
    description: "Post a status update",
    schema: z.object({
      action: z.enum(["working", "completed", "blocked", "handoff"]),
      description: z.string().min(1, "description is required"),
    }),
  }, async (args: any, ctx: any) => {
    const agentId = clientAgents.get(ctx?.session?.id || "");
    const agent = agentId ? workspace.agents.get(agentId) : null;

    if (agent) agent.lastSeen = now();

    workspace.intents.push({
      id: generateId(),
      agentId: agentId || "unknown",
      agentName: agent?.name || "Unknown",
      client: agent?.client || "unknown",
      action: args.action,
      description: args.description,
      timestamp: now(),
    });

    if (workspace.intents.length > 50) {
      workspace.intents = workspace.intents.slice(-50);
    }

    bumpVersion();
    return {
      content: [{
        type: "text" as const,
        text: `Posted: ${args.description}`
      }]
    };
  });

  server.tool({
    name: "read_intents",
    description: "Read recent activity",
    schema: z.object({
      limit: z.number().int().positive().max(100).optional(),
    }),
  }, async (args: any) => {
    const recent = workspace.intents.slice(-(args.limit || 10));
    if (recent.length === 0) {
      return { content: [{ type: "text" as const, text: "No activity yet." }] };
    }
    return {
      content: [{
        type: "text" as const,
        text: recent.map(i => `[${i.action}] ${i.agentName}: ${i.description}`).join("\n")
      }]
    };
  });

  server.tool({
    name: "get_context",
    description: "Get full workspace state",
    schema: z.object({}),
  }, async () => {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          target: workspace.target,
          agents: Array.from(workspace.agents.values()).map(a => ({
            name: a.name,
            role: a.role,
            status: a.status,
            autonomous: a.autonomous,
          })),
          locks: Array.from(workspace.locks.values()).map(l => ({
            file: l.path,
            by: l.agentName,
          })),
          work_queue: workspace.workQueue.map(w => ({
            id: w.id,
            description: w.description,
            forRole: w.forRole,
            status: w.status,
          })),
          recent_activity: workspace.intents.slice(-5).map(i => ({
            action: i.action,
            from: i.agentName,
            msg: i.description,
          })),
          version: workspace.version,
        }, null, 2)
      }]
    };
  });

  server.tool({
    name: "subscribe_changes",
    description: "Get changes since a version number. Use for polling.",
    schema: z.object({
      since_version: z.number().optional().describe("Last known version"),
      sinceCursor: z.number().optional().describe("Alias for since_version (compat)"),
    }),
  }, async (args: any) => {
    const since = args.since_version ?? args.sinceCursor ?? 0;
    if (workspace.version <= since) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ changed: false, version: workspace.version }, null, 2)
        }]
      };
    }

    const limit = 10;
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          changed: true,
          version: workspace.version,
          target: workspace.target,
          agents: Array.from(workspace.agents.values()).map(a => ({
            id: a.id,
            name: a.name,
            role: a.role,
            status: a.status,
          })),
          locks: Array.from(workspace.locks.values()),
          intents: workspace.intents.slice(-limit),
          work_queue: workspace.workQueue,
        }, null, 2)
      }]
    };
  });
}
