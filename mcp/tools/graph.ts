import { MCPServer } from "mcp-use/server";
import { z } from "zod";
import type { WorkspaceState } from "../types.js";
import type { DocSessionManager } from "../doc-session-manager.js";
import { now } from "../../shared/utils.js";

/** Canonical list of all Stigmergy tools (52 total). */
const ALL_STIGMERGY_TOOLS = [
  "check_email", "google_login", "google_auth_callback", "read_gmail", "read_calendar", "add_calendar_event", "gmail_create_draft", "gmail_send_reply",
  "activate_module", "sync_context", "find_options", "find_hotels", "plan_trip", "cc_execute_action", "get_workspace",
  "prepare_meeting", "get_meeting_kit", "update_meeting_section",
  "upsert_card", "execute_action", "move_card", "list_cards", "clear_board",
  "request_approval", "report_conflict", "get_mission_state", "force_unlock", "approve_gate", "resolve_conflict",
  "join_workspace", "list_agents", "set_target", "get_target", "poll_work", "complete_work", "claim_work",
  "lock_file", "unlock_file", "check_locks", "renew_lock",
  "post_intent", "read_intents", "get_context", "subscribe_changes",
  "create_doc", "list_sessions", "get_doc_content",
  "get_graph", "get_graph_widget",
  "stigmergy-dashboard", "mission-control", "war-room", "command-center", "meeting-kit",
] as const;

/** Register list_all_tools — returns full tool count and names. Call first so it appears in truncated tool lists. */
export function registerListAllTools(server: MCPServer): void {
  server.tool({
    name: "list_all_tools",
    description: "List every Stigmergy tool and total count. Use when user asks how many tools exist or wants a full list.",
    schema: z.object({}),
  }, async () => ({
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        total: ALL_STIGMERGY_TOOLS.length,
        tools: [...ALL_STIGMERGY_TOOLS],
        note: "ChatGPT may only show ~21 tools in its UI; all tools are available for use.",
      }, null, 2),
    }],
  }));
}

/** Build widget-format graph data (used by dashboard SSE, HTTP API, and MCP tool). */
export function buildWidgetGraphData(workspace: WorkspaceState, docManager: DocSessionManager) {
  const ts = now();
  const agents = Array.from(workspace.agents.values()).map((a, i) => ({
    id: a.id,
    type: "agent" as const,
    label: a.name,
    status: a.status,
    role: a.role,
    currentTask: a.currentTask,
    x: 50 + i * 120,
    y: 50,
  }));
  const locks = Array.from(workspace.locks.values()).map((l, i) => ({
    id: `lock:${l.path}`,
    type: "lock" as const,
    label: `${l.path} • ${l.agentName} (${l.client}, ${l.role})`,
    status: "held",
    expiresIn: l.expiresAt > ts ? `${Math.ceil((l.expiresAt - ts) / 1000)}s` : "EXPIRED",
    x: 100 + i * 100,
    y: 150,
  }));
  const intents = workspace.intents.slice(-10).map((i, idx) => ({
    id: i.id,
    type: "intent" as const,
    label: i.description,
    status: i.action,
    x: 150 + (idx % 3) * 120,
    y: 220 + Math.floor(idx / 3) * 50,
  }));
  const edges = Array.from(workspace.locks.entries()).map(([path, l]) => ({
    id: `e-${path}`,
    source: l.agentId,
    target: `lock:${path}`,
    type: "owns" as const,
  }));
  const recentEvents = workspace.intents.slice(-5).map(i => ({
    id: i.id,
    type: i.action,
    agent: i.agentName,
    description: i.description,
    timestamp: i.timestamp,
  }));
  const docSessions = docManager.listSessions().map((s, i) => ({
    id: `doc:${s.path}`,
    type: "doc" as const,
    label: s.path,
    editors: s.editors,
    updateCount: s.updateCount,
    lastActivity: s.lastActivity,
    x: 50 + i * 140,
    y: 300,
  }));
  const workQueue = workspace.workQueue.map(w => ({
    id: w.id,
    description: w.description,
    forRole: w.forRole,
    assignedTo: w.assignedTo,
    status: w.status,
  }));
  return { agents, locks, intents, edges, recentEvents, docSessions, workQueue, target: workspace.target, lastUpdate: workspace.version };
}

/** Build raw graph data (nodes + edges) for visualization tools. */
export function buildGraphData(workspace: WorkspaceState) {
  const nodes: any[] = [];
  const edges: any[] = [];

  workspace.agents.forEach(a => {
    nodes.push({
      id: a.id,
      type: "agent",
      label: a.name,
      role: a.role,
      status: a.status,
      client: a.client,
    });
  });

  if (workspace.target) {
    nodes.push({ id: "target", type: "target", label: workspace.target });
  }

  workspace.workQueue.forEach(w => {
    nodes.push({
      id: w.id,
      type: "work",
      label: w.description,
      forRole: w.forRole,
      status: w.status,
    });
    if (w.assignedTo) {
      edges.push({ source: w.assignedTo, target: w.id, type: "assigned" });
    }
  });

  workspace.locks.forEach(l => {
    nodes.push({ id: `file:${l.path}`, type: "file", label: l.path, locked: true });
    edges.push({ source: l.agentId, target: `file:${l.path}`, type: "lock" });
  });

  return { nodes, edges };
}

/** Register get_graph and get_graph_widget MCP tools. */
export function registerGraphTools(
  server: MCPServer,
  workspace: WorkspaceState,
  docManager: DocSessionManager,
): void {
  server.tool({
    name: "get_graph",
    description: "Get graph data for dashboard visualization",
    schema: z.object({}),
  }, async () => {
    const { nodes, edges } = buildGraphData(workspace);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ nodes, edges, version: workspace.version }, null, 2)
      }]
    };
  });

  server.tool({
    name: "get_graph_widget",
    description: "Get graph in widget format (agents, locks, intents, recentEvents) for dashboard",
    schema: z.object({}),
  }, async () => {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(buildWidgetGraphData(workspace, docManager), null, 2)
      }]
    };
  });
}
