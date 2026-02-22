import { MCPServer } from "mcp-use/server";
import { z } from "zod";
import type { WorkspaceState, Agent } from "../types.js";
import { generateId, now, Logger } from "../../shared/utils.js";

const log = new Logger("Stigmergy");

const STALE_WORK_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Re-queues work items stuck in "assigned" for longer than STALE_WORK_MS.
 * Prevents items from being permanently lost when an agent disconnects.
 */
export function startWorkCleanup(
  workspace: WorkspaceState,
  bumpVersion: () => void,
  intervalMs = 60_000,
): NodeJS.Timeout {
  return setInterval(() => {
    const cutoff = now() - STALE_WORK_MS;
    for (const item of workspace.workQueue) {
      if (item.status !== "assigned") continue;
      if (!item.context?.assignedAt || item.context.assignedAt < cutoff) {
        log.info(`Work re-queued (stale ${Math.round(STALE_WORK_MS / 60_000)}m): "${item.description.slice(0, 60)}..."`);
        item.status = "pending";
        item.assignedTo = undefined;
        bumpVersion();
      }
    }
  }, intervalMs);
}

/** Register join_workspace, list_agents, set_target, get_target, poll_work, claim_work, complete_work tools. */
export function registerCoordinationTools(
  server: MCPServer,
  workspace: WorkspaceState,
  clientAgents: Map<string, string>,
  bumpVersion: () => void,
): void {
  server.tool({
    name: "join_workspace",
    description: "Join the shared workspace. Call this FIRST to start collaborating.",
    schema: z.object({
      name: z.string().min(1, "name is required").describe("Your display name (e.g., 'Claude Backend', 'Cursor Frontend')"),
      client: z.enum(["chatgpt", "claude", "cursor", "vscode", "terminal"]).describe("Which client you're in"),
      role: z.enum(["planner", "backend", "frontend", "tester", "any"]).describe("Your role in the team"),
      autonomous: z.boolean().optional().describe("Auto-pickup work when available (default: true)"),
    }),
  }, async (args: any, ctx: any) => {
    const agent: Agent = {
      id: generateId(),
      name: args.name,
      client: args.client,
      role: args.role,
      status: "idle",
      joinedAt: now(),
      lastSeen: now(),
      autonomous: args.autonomous !== false,
    };

    workspace.agents.set(agent.id, agent);
    const clientId = ctx?.session?.id || generateId();
    clientAgents.set(clientId, agent.id);
    bumpVersion();

    log.info(`Agent joined: ${args.name} (${args.role})`);

    const pendingWork = workspace.workQueue.find(w =>
      w.status === "pending" && (w.forRole === args.role || w.forRole === "any" || args.role === "any")
    );

    const lockedFiles = Array.from(workspace.locks.values()).map(l => ({
      path: l.path,
      locked_by: `${l.agentName} (${l.client})`,
      reason: l.reason,
    }));

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          welcome: `You are ${args.name} (${args.role}) in the workspace.`,
          your_id: agent.id,
          autonomous: agent.autonomous,
          current_target: workspace.target,
          pending_work_for_you: pendingWork ? {
            id: pendingWork.id,
            description: pendingWork.description,
            context: pendingWork.context,
          } : null,
          locked_files: lockedFiles,
          agents_online: Array.from(workspace.agents.values()).map(a => ({
            name: a.name,
            role: a.role,
            status: a.status,
          })),
        }, null, 2)
      }]
    };
  });

  server.tool({
    name: "list_agents",
    description: "See all connected agents and their current status",
    schema: z.object({}),
  }, async () => {
    const agents = Array.from(workspace.agents.values());
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          total: agents.length,
          agents: agents.map(a => ({
            name: a.name,
            client: a.client,
            role: a.role,
            status: a.status,
            autonomous: a.autonomous,
            working_on: a.currentTask || "nothing",
          })),
        }, null, 2)
      }]
    };
  });

  server.tool({
    name: "set_target",
    description: "Set the current target/goal. This creates work items for backend/frontend agents to auto-pickup.",
    schema: z.object({
      target: z.string().min(1, "target is required").describe("What should be built (e.g., 'Login page')"),
      backend_task: z.string().optional().describe("Specific task for backend agent"),
      frontend_task: z.string().optional().describe("Specific task for frontend agent"),
    }),
  }, async (args: any, ctx: any) => {
    const agentId = clientAgents.get(ctx?.session?.id || "");
    const agent = agentId ? workspace.agents.get(agentId) : null;

    if (agent) agent.lastSeen = now();
    workspace.target = args.target;

    const backendTask = args.backend_task ?? `Implement backend for ${args.target} (auth, API)`;
    const frontendTask = args.frontend_task ?? `Build frontend for ${args.target}`;

    workspace.workQueue.push({
      id: generateId(),
      description: backendTask,
      forRole: "backend",
      createdBy: agent?.name || "planner",
      createdAt: now(),
      status: "pending",
      context: { target: args.target },
    });
    workspace.workQueue.push({
      id: generateId(),
      description: frontendTask,
      forRole: "frontend",
      createdBy: agent?.name || "planner",
      createdAt: now(),
      status: "pending",
      context: { target: args.target, depends_on: "backend" },
    });

    workspace.intents.push({
      id: generateId(),
      agentId: agentId || "unknown",
      agentName: agent?.name || "Planner",
      client: agent?.client || "chatgpt",
      action: "target_set",
      description: `Target: ${args.target}`,
      timestamp: now(),
    });

    bumpVersion();
    log.info(`Target set: ${args.target}`);

    return {
      content: [{
        type: "text" as const,
        text: `Target: "${args.target}". Backend + frontend tasks queued. Autonomous agents will pick up automatically.`
      }]
    };
  });

  server.tool({
    name: "get_target",
    description: "Get the current target/goal",
    schema: z.object({}),
  }, async () => {
    return {
      content: [{
        type: "text" as const,
        text: workspace.target
          ? `Current target: "${workspace.target}"`
          : "No target set."
      }]
    };
  });

  server.tool({
    name: "poll_work",
    description: "Poll for work assigned to your role. Call this periodically if autonomous. Returns work to do or null.",
    schema: z.object({
      role: z.enum(["backend", "frontend", "tester", "any"]).describe("Your role"),
    }),
  }, async (args: any, ctx: any) => {
    const agentId = clientAgents.get(ctx?.session?.id || "");
    const agent = agentId ? workspace.agents.get(agentId) : null;

    if (agent) {
      agent.lastSeen = now();
    }

    const work = workspace.workQueue.find(w => {
      if (w.status !== "pending") return false;
      if (w.forRole !== args.role && w.forRole !== "any" && args.role !== "any") return false;
      if (w.context?.depends_on === "backend") {
        const backendDone = workspace.workQueue.some(b =>
          b.forRole === "backend" && b.status === "completed"
        ) || workspace.intents.some(i => i.action === "handoff" && i.target === "frontend");
        return backendDone;
      }
      return true;
    });

    if (!work) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ work: null, message: "No work available. Keep polling." }, null, 2)
        }]
      };
    }

    // Auto-assign if the agent registered as autonomous, OR if no session agent was found
    // (handles reconnects / session-ID drift where the agent record exists but can't be located).
    // This ensures poll_work always advances and never returns the same item twice.
    const shouldAutoAssign = agent ? agent.autonomous : true;
    if (shouldAutoAssign) {
      work.status = "assigned";
      if (!work.context) work.context = {};
      work.context.assignedAt = now();
      if (agent) {
        work.assignedTo = agent.id;
        agent.status = "working";
        agent.currentTask = work.description;
      }
      bumpVersion();
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          work: {
            id: work.id,
            description: work.description,
            context: work.context,
            auto_assigned: shouldAutoAssign,
          },
          message: "Work assigned. Research this topic, then call update_meeting_section followed by complete_work.",
        }, null, 2)
      }]
    };
  });

  server.tool({
    name: "complete_work",
    description: "Mark your current work as complete. Triggers handoff to next role.",
    schema: z.object({
      work_id: z.string().min(1, "work_id is required").describe("Work item ID"),
      result: z.string().min(1, "result is required").describe("What you produced (e.g., 'Created /api/login endpoint')"),
      handoff_context: z.record(z.string(), z.unknown()).optional().describe("Context for next agent (e.g., API specs)"),
    }),
  }, async (args: any, ctx: any) => {
    const agentId = clientAgents.get(ctx?.session?.id || "");
    const agent = agentId ? workspace.agents.get(agentId) : null;

    if (agent) agent.lastSeen = now();

    const work = workspace.workQueue.find(w => w.id === args.work_id);
    if (!work) {
      return { content: [{ type: "text" as const, text: "Work item not found." }] };
    }

    work.status = "completed";

    if (agent) {
      agent.status = "idle";
      agent.currentTask = undefined;
    }

    workspace.intents.push({
      id: generateId(),
      agentId: agentId || "unknown",
      agentName: agent?.name || "Unknown",
      client: agent?.client || "unknown",
      action: "completed",
      description: args.result,
      timestamp: now(),
    });

    const nextRole = work.forRole === "backend" ? "frontend" :
                     work.forRole === "frontend" ? "tester" : null;

    if (nextRole) {
      const nextWork = workspace.workQueue.find(w =>
        w.status === "pending" && w.forRole === nextRole
      );
      if (nextWork && args.handoff_context) {
        nextWork.context = { ...nextWork.context, ...args.handoff_context };
      }

      workspace.intents.push({
        id: generateId(),
        agentId: agentId || "unknown",
        agentName: agent?.name || "Unknown",
        client: agent?.client || "unknown",
        action: "handoff",
        description: `${args.result} - Ready for ${nextRole}`,
        target: nextRole,
        timestamp: now(),
      });
    }

    bumpVersion();
    log.info(`Work completed: ${args.result}`);

    return {
      content: [{
        type: "text" as const,
        text: `Completed: ${args.result}${nextRole ? `. Handoff to ${nextRole} triggered.` : ''}`
      }]
    };
  });

  server.tool({
    name: "claim_work",
    description: "Manually claim a work item (for non-autonomous agents)",
    schema: z.object({
      work_id: z.string().min(1, "work_id is required").describe("Work item ID from poll_work"),
    }),
  }, async (args: any, ctx: any) => {
    const agentId = clientAgents.get(ctx?.session?.id || "");
    const agent = agentId ? workspace.agents.get(agentId) : null;

    if (!agent) {
      return { content: [{ type: "text" as const, text: "Join workspace first." }] };
    }
    agent.lastSeen = now();

    const work = workspace.workQueue.find(w => w.id === args.work_id);
    if (!work) {
      return { content: [{ type: "text" as const, text: "Work item not found." }] };
    }
    if (work.status !== "pending") {
      return { content: [{ type: "text" as const, text: `Work already ${work.status}.` }] };
    }

    const roleOk = work.forRole === agent.role || work.forRole === "any" || agent.role === "any";
    if (!roleOk) {
      return { content: [{ type: "text" as const, text: "Work is not for your role." }] };
    }

    if (work.context?.depends_on === "backend") {
      const backendDone = workspace.workQueue.some(b =>
        b.forRole === "backend" && b.status === "completed"
      ) || workspace.intents.some(i => i.action === "handoff" && i.target === "frontend");
      if (!backendDone) {
        return { content: [{ type: "text" as const, text: "Backend must complete first. Poll again later." }] };
      }
    }

    work.status = "assigned";
    work.assignedTo = agent.id;
    if (!work.context) work.context = {};
    work.context.assignedAt = now();
    agent.status = "working";
    agent.currentTask = work.description;
    bumpVersion();

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          work: { id: work.id, description: work.description, context: work.context },
          message: "Work claimed. Start working.",
        }, null, 2)
      }]
    };
  });
}
