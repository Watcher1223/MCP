import { MCPServer } from "mcp-use/server";
import { z } from "zod";
import type { WorkspaceState, Conflict, ApprovalGate } from "../types.js";
import { generateId, now, Logger } from "../../shared/utils.js";
import { conflicts, approvalGates, computeMissionState } from "../workspace.js";

const log = new Logger("Stigmergy");

/** Register mission control tools: request_approval, report_conflict, get_mission_state, resolve_conflict */
export function registerMissionTools(
  server: MCPServer,
  workspace: WorkspaceState,
  clientAgents: Map<string, string>,
  bumpVersion: () => void,
): void {
  server.tool({
    name: "request_approval",
    description: "Request human approval before proceeding with a critical action. Widget shows Approve/Reject buttons.",
    schema: z.object({
      description: z.string().min(1, "description is required").describe("What needs approval (e.g., 'Deploy to production')"),
      context: z.record(z.string(), z.unknown()).optional().describe("Additional context for the approval request"),
    }),
  }, async (args: any, ctx: any) => {
    const agentId = clientAgents.get(ctx?.session?.id || "");
    const agent = agentId ? workspace.agents.get(agentId) : null;

    if (agent) agent.lastSeen = now();

    const gate: ApprovalGate = {
      id: generateId(),
      description: args.description,
      requestedBy: agentId || "unknown",
      requestedByName: agent?.name || "Unknown Agent",
      requestedAt: now(),
      status: "pending",
      context: args.context,
    };

    approvalGates.push(gate);

    // Keep only last 20 approval gates
    if (approvalGates.length > 20) {
      approvalGates.splice(0, approvalGates.length - 20);
    }

    workspace.intents.push({
      id: generateId(),
      agentId: agentId || "unknown",
      agentName: agent?.name || "Unknown",
      client: agent?.client || "unknown",
      action: "blocked",
      description: `⏳ Awaiting approval: ${args.description}`,
      timestamp: now(),
    });

    bumpVersion();
    log.info(`Approval requested: ${args.description}`);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          gate_id: gate.id,
          status: "pending",
          message: "Approval request created. Waiting for human response via Mission Control widget.",
        }, null, 2)
      }]
    };
  });

  server.tool({
    name: "report_conflict",
    description: "Report a conflict that requires human intervention (e.g., lock collision, merge conflict).",
    schema: z.object({
      type: z.enum(["lock_collision", "merge_conflict", "dependency_cycle", "resource_contention"]).describe("Type of conflict"),
      description: z.string().min(1, "description is required").describe("Describe the conflict"),
      involved_agents: z.array(z.string()).optional().describe("Agent IDs involved in the conflict"),
      involved_files: z.array(z.string()).optional().describe("File paths involved"),
    }),
  }, async (args: any, ctx: any) => {
    const agentId = clientAgents.get(ctx?.session?.id || "");
    const agent = agentId ? workspace.agents.get(agentId) : null;

    if (agent) agent.lastSeen = now();

    const conflict: Conflict = {
      id: generateId(),
      type: args.type,
      description: args.description,
      involvedAgents: args.involved_agents || [agentId || "unknown"],
      involvedFiles: args.involved_files,
      reportedBy: agentId || "unknown",
      reportedAt: now(),
      status: "pending",
    };

    conflicts.push(conflict);

    // Keep only last 20 conflicts
    if (conflicts.length > 20) {
      conflicts.splice(0, conflicts.length - 20);
    }

    workspace.intents.push({
      id: generateId(),
      agentId: agentId || "unknown",
      agentName: agent?.name || "Unknown",
      client: agent?.client || "unknown",
      action: "blocked",
      description: `⚠️ Conflict: ${args.description}`,
      timestamp: now(),
    });

    bumpVersion();
    log.info(`Conflict reported: ${args.type} - ${args.description}`);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          conflict_id: conflict.id,
          type: conflict.type,
          status: "pending",
          message: "Conflict reported. Awaiting resolution via Mission Control widget.",
        }, null, 2)
      }]
    };
  });

  server.tool({
    name: "get_mission_state",
    description: "Get current mission state including conflicts, approvals, and overall status.",
    schema: z.object({}),
  }, async () => {
    const state = computeMissionState();
    const pendingConflicts = conflicts.filter(c => c.status === "pending");
    const pendingApprovals = approvalGates.filter(a => a.status === "pending");
    const agents = Array.from(workspace.agents.values());

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          missionState: state,
          target: workspace.target,
          agents: agents.map(a => ({
            name: a.name,
            client: a.client,
            role: a.role,
            status: a.status,
            currentTask: a.currentTask,
          })),
          pendingConflicts: pendingConflicts.map(c => ({
            id: c.id,
            type: c.type,
            description: c.description,
            involvedFiles: c.involvedFiles,
          })),
          pendingApprovals: pendingApprovals.map(a => ({
            id: a.id,
            description: a.description,
            requestedByName: a.requestedByName,
          })),
          workProgress: {
            total: workspace.workQueue.length,
            completed: workspace.workQueue.filter(w => w.status === "completed").length,
            inProgress: workspace.workQueue.filter(w => w.status === "assigned").length,
            pending: workspace.workQueue.filter(w => w.status === "pending").length,
          },
        }, null, 2)
      }]
    };
  });

  server.tool({
    name: "force_unlock",
    description: "Force unlock a file (admin action). Use when a lock holder is unresponsive.",
    schema: z.object({
      path: z.string().min(1, "path is required").describe("File path to force unlock"),
      reason: z.string().optional().describe("Reason for force unlock"),
    }),
  }, async (args: any, ctx: any) => {
    const agentId = clientAgents.get(ctx?.session?.id || "");
    const agent = agentId ? workspace.agents.get(agentId) : null;

    const lock = workspace.locks.get(args.path);
    if (!lock) {
      return { content: [{ type: "text" as const, text: `No lock on ${args.path}` }] };
    }

    const previousHolder = lock.agentName;
    workspace.locks.delete(args.path);

    // Find and resolve any related conflict
    const relatedConflict = conflicts.find(c =>
      c.status === "pending" &&
      c.type === "lock_collision" &&
      c.involvedFiles?.includes(args.path)
    );
    if (relatedConflict) {
      relatedConflict.status = "resolved";
      relatedConflict.resolution = args.reason || "Force unlocked by admin";
      relatedConflict.resolvedAt = now();
      relatedConflict.resolvedBy = agent?.name || "Admin";
    }

    workspace.intents.push({
      id: generateId(),
      agentId: agentId || "admin",
      agentName: agent?.name || "Admin",
      client: agent?.client || "chatgpt",
      action: "working",
      description: `🔓 Force unlocked ${args.path} (was held by ${previousHolder})`,
      timestamp: now(),
    });

    bumpVersion();
    log.info(`Force unlock: ${args.path} (was ${previousHolder})`);

    return {
      content: [{
        type: "text" as const,
        text: `Force unlocked ${args.path}. Previous holder: ${previousHolder}. ${relatedConflict ? "Related conflict resolved." : ""}`
      }]
    };
  });

  server.tool({
    name: "approve_gate",
    description: "Approve or reject an approval gate (human decision).",
    schema: z.object({
      gate_id: z.string().min(1, "gate_id is required").describe("Approval gate ID"),
      approved: z.boolean().describe("true to approve, false to reject"),
      reason: z.string().optional().describe("Reason for rejection (if rejected)"),
    }),
  }, async (args: any, ctx: any) => {
    const agentId = clientAgents.get(ctx?.session?.id || "");
    const agent = agentId ? workspace.agents.get(agentId) : null;

    const gate = approvalGates.find(g => g.id === args.gate_id);
    if (!gate) {
      return { content: [{ type: "text" as const, text: "Approval gate not found." }] };
    }
    if (gate.status !== "pending") {
      return { content: [{ type: "text" as const, text: `Gate already ${gate.status}.` }] };
    }

    gate.status = args.approved ? "approved" : "rejected";
    gate.approvedAt = now();
    gate.approvedBy = agent?.name || "Human";
    if (!args.approved) {
      gate.rejectionReason = args.reason || "Rejected";
    }

    workspace.intents.push({
      id: generateId(),
      agentId: agentId || "human",
      agentName: agent?.name || "Human",
      client: agent?.client || "chatgpt",
      action: args.approved ? "completed" : "blocked",
      description: args.approved
        ? `✅ Approved: ${gate.description}`
        : `❌ Rejected: ${gate.description} - ${args.reason || "No reason given"}`,
      timestamp: now(),
    });

    bumpVersion();
    log.info(`Gate ${args.gate_id}: ${args.approved ? "approved" : "rejected"}`);

    return {
      content: [{
        type: "text" as const,
        text: args.approved
          ? `Approved: ${gate.description}`
          : `Rejected: ${gate.description}. Reason: ${args.reason || "No reason given"}`
      }]
    };
  });

  server.tool({
    name: "resolve_conflict",
    description: "Mark a conflict as resolved with a resolution description.",
    schema: z.object({
      conflict_id: z.string().min(1, "conflict_id is required").describe("Conflict ID"),
      resolution: z.string().min(1, "resolution is required").describe("How the conflict was resolved"),
    }),
  }, async (args: any, ctx: any) => {
    const agentId = clientAgents.get(ctx?.session?.id || "");
    const agent = agentId ? workspace.agents.get(agentId) : null;

    const conflict = conflicts.find(c => c.id === args.conflict_id);
    if (!conflict) {
      return { content: [{ type: "text" as const, text: "Conflict not found." }] };
    }
    if (conflict.status !== "pending") {
      return { content: [{ type: "text" as const, text: `Conflict already ${conflict.status}.` }] };
    }

    conflict.status = "resolved";
    conflict.resolution = args.resolution;
    conflict.resolvedAt = now();
    conflict.resolvedBy = agent?.name || "Human";

    workspace.intents.push({
      id: generateId(),
      agentId: agentId || "human",
      agentName: agent?.name || "Human",
      client: agent?.client || "chatgpt",
      action: "completed",
      description: `🔧 Resolved: ${conflict.description} - ${args.resolution}`,
      timestamp: now(),
    });

    bumpVersion();
    log.info(`Conflict ${args.conflict_id} resolved: ${args.resolution}`);

    return {
      content: [{
        type: "text" as const,
        text: `Conflict resolved: ${args.resolution}`
      }]
    };
  });
}
