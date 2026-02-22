// Synapse MCP Server - Standard MCP Protocol Implementation
// Works with ChatGPT, Claude Desktop, Cursor, and any MCP client

import { createServer, IncomingMessage, ServerResponse } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { StateManager } from "../hub/src/state.js";
import { generateId, now, Logger } from "../shared/utils.js";
import type { Agent, Intent, Lock, Event, Blueprint, LockTarget, FilePatch, AgentRole } from "../shared/types.js";
import { worldState, WorldStateManager } from "./world-state.js";
import { cascadeEngine, CascadeEngine, APIContract } from "./cascade-engine.js";

const log = new Logger("MCP-Synapse");

// Shared state manager - single source of truth
export const state = new StateManager();

// Track connected MCP clients -> agents
const clientAgents = new Map<string, string>();

// Event subscribers for realtime streaming
const eventSubscribers = new Set<(event: Event) => void>();

// SSE clients for widget updates
const sseClients = new Set<ServerResponse>();

// WebSocket clients
const wsClients = new Set<WebSocket>();

// ========================================
// WIDGET STATE
// ========================================

interface WidgetState {
  agents: WidgetNode[];
  locks: WidgetNode[];
  intents: WidgetNode[];
  goals: WidgetNode[];
  edges: WidgetEdge[];
  recentEvents: WidgetEvent[];
  workQueue: { id: string; description: string; role: string; status: string }[];
  lastUpdate: number;
}

interface WidgetNode {
  id: string;
  type: "agent" | "lock" | "file" | "intent";
  label: string;
  status?: string;
  role?: string;
  x?: number;
  y?: number;
}

interface WidgetEdge {
  id: string;
  source: string;
  target: string;
  type: "working_on" | "depends_on" | "updated" | "owns" | "targets";
  animated?: boolean;
}

interface WidgetEvent {
  id: string;
  type: string;
  agent: string;
  description: string;
  timestamp: number;
}

let widgetState: WidgetState = {
  agents: [],
  locks: [],
  intents: [],
  goals: [],
  edges: [],
  recentEvents: [],
  workQueue: [],
  lastUpdate: now(),
};

// Patch StateManager to broadcast events
const originalEmitEvent = (state as any).emitEvent?.bind(state);
if (originalEmitEvent) {
  (state as any).emitEvent = function(type: string, agentId: string, data: Record<string, any>) {
    const event = originalEmitEvent(type, agentId, data);

    // Broadcast to SSE clients
    broadcastSSE({ type: "event", event });

    // Broadcast to WebSocket clients
    broadcastWS({ type: "event", event });

    // Update widget state
    updateWidgetState();

    return event;
  };
}

export function updateWidgetState(): void {
  const blueprint = state.getBlueprint();

  // Convert agents to nodes with force-directed layout
  const agentNodes: WidgetNode[] = blueprint.agents.map((a, i) => ({
    id: a.id,
    type: "agent" as const,
    label: a.name,
    status: "active",
    role: a.role,
    x: 80 + (i % 3) * 180,
    y: 60 + Math.floor(i / 3) * 120,
  }));

  // Convert locks to nodes
  const lockNodes: WidgetNode[] = blueprint.locks.map((l, i) => ({
    id: l.id,
    type: "lock" as const,
    label: `${l.target.type}:${l.target.path}`.slice(0, 30),
    status: "locked",
    x: 450 + (i % 2) * 120,
    y: 80 + Math.floor(i / 2) * 80,
  }));

  // Convert intents to nodes
  const intentNodes: WidgetNode[] = blueprint.intents
    .filter(i => i.status === "pending" || i.status === "active")
    .map((intent, i) => ({
      id: intent.id,
      type: "intent" as const,
      label: intent.action.slice(0, 25),
      status: intent.status,
      x: 150 + (i % 4) * 130,
      y: 280 + Math.floor(i / 4) * 70,
    }));

  // Build edges
  const edges: WidgetEdge[] = [];

  // Agent -> Lock edges (owns)
  for (const lock of blueprint.locks) {
    edges.push({
      id: `${lock.agentId}-${lock.id}`,
      source: lock.agentId,
      target: lock.id,
      type: "owns",
      animated: true,
    });
  }

  // Agent -> Intent edges (working_on)
  for (const intent of blueprint.intents) {
    if (intent.status === "active") {
      edges.push({
        id: `${intent.agentId}-${intent.id}`,
        source: intent.agentId,
        target: intent.id,
        type: "working_on",
        animated: true,
      });
    }
  }

  // Intent dependencies
  for (const intent of blueprint.intents) {
    for (const depId of intent.dependencies) {
      edges.push({
        id: `dep-${intent.id}-${depId}`,
        source: depId,
        target: intent.id,
        type: "depends_on",
      });
    }
  }

  // Recent events
  const recentEvents: WidgetEvent[] = state.getLatestEvents(10).map(e => ({
    id: e.id,
    type: e.type,
    agent: e.agentId,
    description: formatEventDescription(e),
    timestamp: e.timestamp,
  }));

  // Goals from world state
  const ws = worldState.getSnapshot();
  const goalNodes: WidgetNode[] = Object.values(ws.goals || {}).map((g: any, i: number) => ({
    id: g.id,
    type: "intent" as const,
    label: g.description,
    status: g.status,
    role: "goal",
    criteria: g.success_criteria || [],
    x: 50 + (i % 2) * 300,
    y: 380 + Math.floor(i / 2) * 60,
  }));

  // Work queue
  const workQueue = (ws.work_queue || [])
    .filter((w: any) => w.status !== "completed")
    .map((w: any) => ({
      id: w.id,
      description: w.description.slice(0, 50),
      role: w.required_role,
      status: w.status === "assigned" ? "active" : w.status,
    }));

  // Cascade engine data
  const cascadeSnapshot = cascadeEngine.getSnapshot();
  const fileSessions = cascadeSnapshot.fileSessions.map(s => ({
    path: s.path,
    editors: s.editors.map(e => e.agentName),
    pendingChanges: s.pendingChanges.length,
  }));
  const cascadeEvents = cascadeSnapshot.recentCascades.map(c => ({
    type: c.type,
    source: c.source,
    target: c.target,
    details: c.details,
  }));

  widgetState = {
    agents: agentNodes,
    locks: lockNodes,
    intents: intentNodes,
    goals: goalNodes,
    edges,
    recentEvents,
    workQueue,
    fileSessions,
    cascadeEvents,
    lastUpdate: now(),
  } as any;

  // Broadcast updated widget state
  broadcastSSE({ type: "widget_state", state: widgetState });
  broadcastWS({ type: "widget_state", state: widgetState });
}

function formatEventDescription(event: Event): string {
  const agent = state.getAgent(event.agentId);
  const agentName = agent?.name || event.agentId.slice(0, 8);

  switch (event.type) {
    case "agent_connected":
      return `${agentName} joined as ${event.data.agent?.role || "agent"}`;
    case "agent_disconnected":
      return `${agentName} disconnected`;
    case "intent_broadcast":
      return `${agentName} plans: ${event.data.intent?.action || "unknown"}`;
    case "intent_completed":
      return `${agentName} completed: ${event.data.intent?.action || "task"}`;
    case "lock_acquired":
      return `${agentName} locked ${event.data.lock?.target?.path || "resource"}`;
    case "lock_released":
      return `${agentName} released ${event.data.target || "resource"}`;
    case "file_created":
      return `${agentName} created ${event.data.path}`;
    case "file_modified":
      return `${agentName} modified ${event.data.path}`;
    default:
      return `${agentName}: ${event.type}`;
  }
}

function broadcastSSE(data: any): void {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(msg);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

function broadcastWS(data: any): void {
  const msg = JSON.stringify(data);
  for (const client of wsClients) {
    try {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    } catch (e) {
      wsClients.delete(client);
    }
  }
}

// ========================================
// AGENT HELPERS
// ========================================

function getRoleCapabilities(role: AgentRole): string[] {
  switch (role) {
    case "planner":
      return ["planning", "coordination", "review", "task-decomposition"];
    case "coder":
      return ["implementation", "file-editing", "refactoring", "debugging"];
    case "tester":
      return ["testing", "validation", "error-detection", "coverage"];
    case "refactor":
      return ["refactoring", "optimization", "cleanup"];
    case "observer":
      return ["monitoring", "reporting"];
    default:
      return [];
  }
}

function autoRegisterAgent(clientId: string, metadata?: { name?: string; role?: AgentRole; environment?: string }): Agent {
  const existingAgentId = clientAgents.get(clientId);
  if (existingAgentId) {
    const agent = state.getAgent(existingAgentId);
    if (agent) return agent;
  }

  let role: AgentRole = metadata?.role || "coder";
  const env = metadata?.environment?.toLowerCase() || "";

  if (env.includes("chatgpt") || env.includes("browser")) {
    role = "planner";
  } else if (env.includes("cursor")) {
    role = "coder";
  } else if (env.includes("vscode")) {
    role = "coder";
  } else if (env.includes("test")) {
    role = "tester";
  }

  const name = metadata?.name || `${role}-${generateId().slice(0, 6)}`;

  const agent = state.registerAgent({
    id: generateId(),
    name,
    type: "realtime",
    role,
    capabilities: getRoleCapabilities(role),
  });

  clientAgents.set(clientId, agent.id);
  log.info(`Auto-registered agent: ${name} (${role}) for client ${clientId}`);

  return agent;
}

// ========================================
// MCP TOOL DEFINITIONS
// ========================================

interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

const tools: MCPTool[] = [
  {
    name: "register_agent",
    description: "Register yourself as a collaboration agent. Call this first to join the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name for this agent" },
        role: {
          type: "string",
          enum: ["planner", "coder", "tester", "refactor", "observer"],
          description: "Agent's role in the team"
        },
        capabilities: {
          type: "array",
          items: { type: "string" },
          description: "List of capabilities"
        },
      },
      required: ["name", "role"],
    },
  },
  {
    name: "heartbeat",
    description: "Send heartbeat to maintain active status",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "declare_intent",
    description: "Announce what you plan to do. Other agents will see this and can coordinate.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "What you intend to do (e.g., 'implement POST /api/todos')" },
        targets: {
          type: "array",
          items: { type: "string" },
          description: "Files or resources you'll work on"
        },
        description: { type: "string", description: "Detailed description of the work" },
        priority: { type: "number", default: 0, description: "Priority level" },
        dependencies: {
          type: "array",
          items: { type: "string" },
          description: "IDs of intents this depends on"
        },
      },
      required: ["action", "targets", "description"],
    },
  },
  {
    name: "acquire_lock",
    description: "Lock a file or resource before editing. Prevents conflicts with other agents.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["file", "function", "class", "module", "semantic"],
          description: "Type of resource to lock"
        },
        path: { type: "string", description: "Path or identifier of the resource" },
        identifier: { type: "string", description: "Specific identifier within the resource" },
        ttl: { type: "number", default: 30000, description: "Lock duration in milliseconds" },
        intent: { type: "string", description: "Description of why you need this lock" },
      },
      required: ["type", "path"],
    },
  },
  {
    name: "release_lock",
    description: "Release a lock after completing work",
    inputSchema: {
      type: "object",
      properties: {
        lockId: { type: "string", description: "ID of the lock to release" },
      },
      required: ["lockId"],
    },
  },
  {
    name: "publish_update",
    description: "Publish a file change to the collaboration. Other agents will automatically react.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        operation: {
          type: "string",
          enum: ["create", "modify", "delete", "rename"],
          description: "Operation type"
        },
        content: { type: "string", description: "New file content" },
        summary: { type: "string", description: "Human-readable summary of changes" },
        lockId: { type: "string", description: "Lock ID if you have one" },
      },
      required: ["path", "operation", "summary"],
    },
  },
  {
    name: "subscribe_changes",
    description: "Get real-time updates when other agents make changes. Returns recent events.",
    inputSchema: {
      type: "object",
      properties: {
        sinceCursor: { type: "number", default: 0, description: "Get events after this cursor" },
        limit: { type: "number", default: 20, description: "Max events to return" },
      },
    },
  },
  {
    name: "list_agents",
    description: "List all connected agents and their status",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_graph_state",
    description: "Get the full collaboration graph state for visualization",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "spawn_role_agent",
    description: "Spawn a specialized agent role to help with the current task",
    inputSchema: {
      type: "object",
      properties: {
        role: {
          type: "string",
          enum: ["planner", "coder", "tester"],
          description: "The role to spawn"
        },
        task: { type: "string", description: "Initial task for this agent" },
      },
      required: ["role", "task"],
    },
  },
  {
    name: "complete_intent",
    description: "Mark an intent as completed",
    inputSchema: {
      type: "object",
      properties: {
        intentId: { type: "string", description: "ID of the intent to complete" },
      },
      required: ["intentId"],
    },
  },
  {
    name: "get_pending_work",
    description: "Get intents and changes you should react to based on your role",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "react_to_change",
    description: "React to another agent's change. Use this to coordinate automatically.",
    inputSchema: {
      type: "object",
      properties: {
        sourceEventType: { type: "string", description: "Type of event you're reacting to" },
        sourcePath: { type: "string", description: "Path that changed" },
        yourAction: { type: "string", description: "What you're doing in response" },
        affectedPaths: {
          type: "array",
          items: { type: "string" },
          description: "Files you'll modify"
        },
      },
      required: ["sourceEventType", "yourAction", "affectedPaths"],
    },
  },
  // ========================================
  // WORLD STATE TOOLS
  // ========================================
  {
    name: "read_world_state",
    description: "Read the shared world state. Call this BEFORE acting to understand current project reality.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "update_world_state",
    description: "Update the shared world state after completing work. Patch format: {files: {path: {...}}, endpoints: {...}, etc}",
    inputSchema: {
      type: "object",
      properties: {
        patch: {
          type: "object",
          description: "Partial update to world state entities",
        },
      },
      required: ["patch"],
    },
  },
  {
    name: "assert_fact",
    description: "Assert a fact about the project state with confidence level.",
    inputSchema: {
      type: "object",
      properties: {
        assertion: { type: "string", description: "The fact being asserted" },
        confidence: { type: "number", description: "Confidence 0-1" },
        source: {
          type: "string",
          enum: ["test", "runtime", "static", "assumption"],
          description: "Source of this assertion"
        },
      },
      required: ["assertion", "confidence"],
    },
  },
  {
    name: "report_failure",
    description: "Report a failure in the system. Triggers automatic fix work assignment.",
    inputSchema: {
      type: "object",
      properties: {
        area: { type: "string", description: "What area is failing" },
        reason: { type: "string", description: "Why it's failing" },
      },
      required: ["area", "reason"],
    },
  },
  {
    name: "propose_goal",
    description: "Propose a new goal for the system to achieve. Triggers autonomous work chain.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "What should be achieved" },
        success_criteria: {
          type: "array",
          items: { type: "string" },
          description: "List of criteria that must be true when goal is satisfied"
        },
      },
      required: ["description", "success_criteria"],
    },
  },
  {
    name: "evaluate_goal",
    description: "Evaluate progress toward a goal. Returns satisfaction status and missing criteria.",
    inputSchema: {
      type: "object",
      properties: {
        goal_id: { type: "string", description: "ID of goal to evaluate" },
      },
      required: ["goal_id"],
    },
  },
  {
    name: "assign_work",
    description: "Request work assignment from the queue based on your role. Returns next task.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "complete_work",
    description: "Mark assigned work as completed. Triggers goal re-evaluation.",
    inputSchema: {
      type: "object",
      properties: {
        work_id: { type: "string", description: "ID of completed work item" },
      },
      required: ["work_id"],
    },
  },
  // ========================================
  // CASCADE & COLLABORATION TOOLS
  // ========================================
  {
    name: "register_api_contract",
    description: "Register or update an API endpoint contract. When schema changes, frontend bindings are automatically notified.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint: { type: "string", description: "API endpoint path (e.g., /api/users)" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], description: "HTTP method" },
        request_fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string" },
              required: { type: "boolean" },
            },
          },
          description: "Request body schema fields",
        },
        response_fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string" },
              required: { type: "boolean" },
            },
          },
          description: "Response body schema fields",
        },
      },
      required: ["endpoint", "method"],
    },
  },
  {
    name: "bind_frontend_component",
    description: "Bind a frontend component to an API endpoint. Component will be notified when endpoint schema changes.",
    inputSchema: {
      type: "object",
      properties: {
        component_name: { type: "string", description: "Frontend component name" },
        endpoint: { type: "string", description: "API endpoint to bind to (e.g., POST:/api/users)" },
        fields: { type: "array", items: { type: "string" }, description: "Fields this component uses" },
      },
      required: ["component_name", "endpoint"],
    },
  },
  {
    name: "join_file_session",
    description: "Join a collaborative editing session for a file. Multiple agents can edit the same file with automatic conflict resolution.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to edit" },
      },
      required: ["path"],
    },
  },
  {
    name: "propose_file_change",
    description: "Propose a change to a file in a collaborative session. Conflicts are automatically merged when possible.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        start_line: { type: "number", description: "Start line of change" },
        end_line: { type: "number", description: "End line of change" },
        new_content: { type: "string", description: "New content for this range" },
      },
      required: ["path", "start_line", "end_line", "new_content"],
    },
  },
  {
    name: "get_cascade_status",
    description: "Get current cascade engine status: API contracts, frontend bindings, active file sessions, and recent cascade events.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_outdated_components",
    description: "Get frontend components that need updating due to API changes.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "run_integration_test",
    description: "Trigger an integration test run. Results cascade to world state.",
    inputSchema: {
      type: "object",
      properties: {
        test_name: { type: "string", description: "Name of test to run" },
        endpoint: { type: "string", description: "Endpoint being tested" },
      },
      required: ["test_name"],
    },
  },
];

// ========================================
// TOOL EXECUTION
// ========================================

async function executeTool(name: string, args: any, clientId: string): Promise<any> {
  const agentId = clientAgents.get(clientId);

  switch (name) {
    case "register_agent": {
      const agent = state.registerAgent({
        id: generateId(),
        name: args.name,
        type: "realtime",
        role: args.role,
        capabilities: args.capabilities || getRoleCapabilities(args.role),
      });
      clientAgents.set(clientId, agent.id);
      updateWidgetState();
      return {
        content: [
          {
            type: "text",
            text: `Registered as ${agent.name} (${agent.role}). Agent ID: ${agent.id}. You are now part of the collaboration.`,
          },
        ],
      };
    }

    case "heartbeat": {
      if (agentId) {
        state.updateAgentHeartbeat(agentId);
      }
      return { content: [{ type: "text", text: "ok" }] };
    }

    case "declare_intent": {
      let effectiveAgentId = agentId;
      if (!effectiveAgentId) {
        const agent = autoRegisterAgent(clientId, { role: "coder" });
        effectiveAgentId = agent.id;
      }

      const intent = state.createIntent(effectiveAgentId, {
        agentId: effectiveAgentId,
        action: args.action,
        targets: args.targets || [],
        description: args.description,
        priority: args.priority || 0,
        status: "pending",
        dependencies: args.dependencies || [],
      });

      updateWidgetState();
      return {
        content: [
          {
            type: "text",
            text: `Intent declared: "${args.action}" targeting ${(args.targets || []).join(", ")}. Intent ID: ${intent.id}`,
          },
        ],
      };
    }

    case "acquire_lock": {
      if (!agentId) {
        return { content: [{ type: "text", text: "Error: Not registered. Call register_agent first." }] };
      }

      const target: LockTarget = {
        type: args.type,
        path: args.path,
        identifier: args.identifier,
      };

      const result = state.requestLock(agentId, target, args.ttl || 30000, args.intent);

      if (result.success) {
        updateWidgetState();
        return {
          content: [
            {
              type: "text",
              text: `Lock acquired on ${args.path}. Lock ID: ${result.lockId}. You have ${(args.ttl || 30000) / 1000}s to complete your work.`,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Lock denied: ${result.reason}. ${result.suggestedAction || ""}`,
            },
          ],
        };
      }
    }

    case "release_lock": {
      if (!agentId) {
        return { content: [{ type: "text", text: "Error: Not registered." }] };
      }

      const success = state.releaseLock(args.lockId, agentId);
      updateWidgetState();
      return {
        content: [{ type: "text", text: success ? "Lock released." : "Failed to release lock." }],
      };
    }

    case "publish_update": {
      if (!agentId) {
        return { content: [{ type: "text", text: "Error: Not registered." }] };
      }

      const patch: FilePatch = {
        path: args.path,
        operation: args.operation,
        content: args.content,
      };

      const result = state.applyFilePatch(agentId, patch, args.lockId);

      if (result.success) {
        updateWidgetState();
        return {
          content: [
            {
              type: "text",
              text: `Published: ${args.summary} (${args.path} v${result.version})`,
            },
          ],
        };
      } else {
        return { content: [{ type: "text", text: `Failed: ${result.reason}` }] };
      }
    }

    case "subscribe_changes": {
      const events = state.getEventsSince(args.sinceCursor || 0, args.limit || 20);
      const formatted = events.map(e => ({
        cursor: e.cursor,
        type: e.type,
        agent: state.getAgent(e.agentId)?.name || e.agentId.slice(0, 8),
        description: formatEventDescription(e),
        timestamp: new Date(e.timestamp).toISOString(),
        data: e.data,
      }));

      const cursor = events.length > 0 ? events[events.length - 1].cursor : (args.sinceCursor || 0);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              events: formatted,
              cursor,
              agentCount: state.getAllAgents().length,
              activeLocks: state.getAllLocks().length,
              pendingIntents: state.getActiveIntents().length,
            }, null, 2),
          },
        ],
      };
    }

    case "list_agents": {
      const agents = state.getAllAgents();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              agents: agents.map(a => ({
                id: a.id,
                name: a.name,
                role: a.role,
                capabilities: a.capabilities,
                activeFor: Math.round((now() - a.connectedAt) / 1000) + "s",
              })),
              total: agents.length,
            }, null, 2),
          },
        ],
      };
    }

    case "get_graph_state": {
      updateWidgetState();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              nodes: [...widgetState.agents, ...widgetState.locks, ...widgetState.intents],
              edges: widgetState.edges,
              events: widgetState.recentEvents,
              stats: {
                agents: widgetState.agents.length,
                locks: widgetState.locks.length,
                intents: widgetState.intents.length,
                edges: widgetState.edges.length,
              },
            }, null, 2),
          },
        ],
      };
    }

    case "spawn_role_agent": {
      const spawnedId = generateId();
      const name = `${args.role}-${spawnedId.slice(0, 6)}`;

      const agent = state.registerAgent({
        id: spawnedId,
        name,
        type: "realtime",
        role: args.role,
        capabilities: getRoleCapabilities(args.role),
      });

      state.createIntent(agent.id, {
        agentId: agent.id,
        action: args.task,
        targets: [],
        description: `Spawned to: ${args.task}`,
        priority: 5,
        status: "pending",
        dependencies: [],
      });

      updateWidgetState();
      return {
        content: [
          {
            type: "text",
            text: `Spawned ${name} with task: "${args.task}". Agent will coordinate via Synapse.`,
          },
        ],
      };
    }

    case "complete_intent": {
      const updated = state.updateIntent(args.intentId, { status: "completed" });
      updateWidgetState();
      if (updated) {
        return { content: [{ type: "text", text: `Intent completed: ${updated.action}` }] };
      } else {
        return { content: [{ type: "text", text: "Intent not found." }] };
      }
    }

    case "get_pending_work": {
      const agent = agentId ? state.getAgent(agentId) : undefined;
      const allIntents = state.getActiveIntents();
      const recentEvents = state.getLatestEvents(20);

      let relevantWork: any[] = [];

      if (agent?.role === "coder") {
        relevantWork = allIntents
          .filter(i => {
            const owner = state.getAgent(i.agentId);
            return owner?.role === "planner" && i.status === "pending";
          })
          .map(i => ({
            type: "intent",
            id: i.id,
            action: i.action,
            targets: i.targets,
            from: state.getAgent(i.agentId)?.name,
          }));

        const fileChanges = recentEvents
          .filter(e => e.type.startsWith("file_"))
          .map(e => ({
            type: "file_change",
            path: e.data.path,
            operation: e.data.operation,
            by: state.getAgent(e.agentId)?.name,
          }));
        relevantWork = [...relevantWork, ...fileChanges];

      } else if (agent?.role === "tester") {
        relevantWork = recentEvents
          .filter(e => {
            const owner = state.getAgent(e.agentId);
            return owner?.role === "coder" && e.type.startsWith("file_");
          })
          .map(e => ({
            type: "needs_test",
            path: e.data.path,
            by: state.getAgent(e.agentId)?.name,
          }));
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              yourRole: agent?.role || "unknown",
              pendingWork: relevantWork,
              count: relevantWork.length,
            }, null, 2),
          },
        ],
      };
    }

    case "react_to_change": {
      if (!agentId) {
        return { content: [{ type: "text", text: "Error: Not registered." }] };
      }

      const intent = state.createIntent(agentId, {
        agentId,
        action: `React: ${args.yourAction}`,
        targets: args.affectedPaths,
        description: `Reacting to ${args.sourceEventType} on ${args.sourcePath || "system"}`,
        priority: 3,
        status: "active",
        dependencies: [],
      });

      updateWidgetState();
      return {
        content: [
          {
            type: "text",
            text: `Reaction recorded. Modify ${args.affectedPaths.join(", ")} and call publish_update when done.`,
          },
        ],
      };
    }

    // ========================================
    // WORLD STATE TOOL HANDLERS
    // ========================================

    case "read_world_state": {
      const snapshot = worldState.getSnapshot();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(snapshot, null, 2),
          },
        ],
      };
    }

    case "update_world_state": {
      worldState.applyPatch(args.patch);
      updateWidgetState();
      return {
        content: [{ type: "text", text: "World state updated." }],
      };
    }

    case "assert_fact": {
      if (!agentId) {
        return { content: [{ type: "text", text: "Error: Not registered." }] };
      }
      const obs = worldState.assertFact(
        agentId,
        args.assertion,
        args.confidence,
        args.source || "assumption"
      );
      return {
        content: [
          {
            type: "text",
            text: `Fact asserted: "${args.assertion}" (confidence: ${args.confidence})`,
          },
        ],
      };
    }

    case "report_failure": {
      if (!agentId) {
        return { content: [{ type: "text", text: "Error: Not registered." }] };
      }
      worldState.reportFailure(args.area, args.reason, agentId);
      updateWidgetState();
      return {
        content: [
          {
            type: "text",
            text: `Failure reported: ${args.area}. Fix work enqueued.`,
          },
        ],
      };
    }

    case "propose_goal": {
      const goal = worldState.proposeGoal(args.description, args.success_criteria);
      updateWidgetState();
      return {
        content: [
          {
            type: "text",
            text: `Goal proposed: "${args.description}" (ID: ${goal.id}). Work chain initiated.`,
          },
        ],
      };
    }

    case "evaluate_goal": {
      const result = worldState.evaluateGoal(args.goal_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              satisfied: result.satisfied,
              progress: Math.round(result.progress * 100) + "%",
              missing: result.missing,
            }, null, 2),
          },
        ],
      };
    }

    case "assign_work": {
      if (!agentId) {
        return { content: [{ type: "text", text: "Error: Not registered." }] };
      }
      const agent = state.getAgent(agentId);
      const work = worldState.assignWork(agentId, agent?.role || "coder");
      if (work) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                work_id: work.id,
                description: work.description,
                goal_id: work.goal_id,
                priority: work.priority,
              }, null, 2),
            },
          ],
        };
      } else {
        return {
          content: [{ type: "text", text: "No work available for your role." }],
        };
      }
    }

    case "complete_work": {
      const success = worldState.completeWork(args.work_id);
      updateWidgetState();
      return {
        content: [
          {
            type: "text",
            text: success ? "Work completed. Goal re-evaluated." : "Work not found.",
          },
        ],
      };
    }

    // ========================================
    // CASCADE & COLLABORATION HANDLERS
    // ========================================

    case "register_api_contract": {
      const contract: APIContract = {
        endpoint: args.endpoint,
        method: args.method,
        requestSchema: args.request_fields || [],
        responseSchema: args.response_fields || [],
        version: 1,
        lastUpdated: now(),
      };
      cascadeEngine.registerContract(contract);
      updateWidgetState();

      return {
        content: [
          {
            type: "text",
            text: `API contract registered: ${args.method} ${args.endpoint}. Frontend bindings will auto-update on schema changes.`,
          },
        ],
      };
    }

    case "bind_frontend_component": {
      const binding = cascadeEngine.bindFrontend(
        generateId(),
        args.component_name,
        args.endpoint,
        args.fields || []
      );
      updateWidgetState();

      return {
        content: [
          {
            type: "text",
            text: `Frontend component '${args.component_name}' bound to ${args.endpoint}. Will receive cascade updates.`,
          },
        ],
      };
    }

    case "join_file_session": {
      if (!agentId) {
        return { content: [{ type: "text", text: "Error: Not registered." }] };
      }
      const agent = state.getAgent(agentId);
      const session = cascadeEngine.joinFile(args.path, agentId, agent?.name || "Unknown");
      updateWidgetState();

      const editors = session.editors.map(e => e.agentName).join(", ");
      return {
        content: [
          {
            type: "text",
            text: `Joined collaborative session for ${args.path}. Current editors: ${editors}. Conflicts will be auto-merged.`,
          },
        ],
      };
    }

    case "propose_file_change": {
      if (!agentId) {
        return { content: [{ type: "text", text: "Error: Not registered." }] };
      }

      const result = cascadeEngine.proposeChange(
        args.path,
        agentId,
        [args.start_line, args.end_line],
        args.new_content
      );
      updateWidgetState();

      if (result.accepted) {
        return {
          content: [
            {
              type: "text",
              text: result.merged
                ? `Change accepted and merged with concurrent edit. Result: ${result.merged.slice(0, 100)}...`
                : `Change accepted for lines ${args.start_line}-${args.end_line}.`,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Change rejected: ${result.conflict}. Please resolve manually or wait.`,
            },
          ],
        };
      }
    }

    case "get_cascade_status": {
      const snapshot = cascadeEngine.getSnapshot();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              api_contracts: snapshot.contracts.length,
              frontend_bindings: snapshot.bindings.length,
              active_file_sessions: snapshot.fileSessions.map(s => ({
                path: s.path,
                editors: s.editors.map(e => e.agentName),
                pending_changes: s.pendingChanges.length,
              })),
              recent_cascades: snapshot.recentCascades.map(c => ({
                type: c.type,
                details: c.details,
              })),
            }, null, 2),
          },
        ],
      };
    }

    case "get_outdated_components": {
      const outdated = cascadeEngine.getOutdatedBindings();
      return {
        content: [
          {
            type: "text",
            text: outdated.length > 0
              ? `Components needing update:\n${outdated.map(b => `- ${b.componentName} (bound to ${b.boundEndpoint})`).join("\n")}`
              : "All frontend components are up to date.",
          },
        ],
      };
    }

    case "run_integration_test": {
      // Simulate running a test and updating world state
      const testResult = Math.random() > 0.2; // 80% pass rate for demo
      const testName = args.test_name;
      const endpoint = args.endpoint || "unknown";

      worldState.applyPatch({
        tests: {
          [testName]: {
            name: testName,
            covers: [endpoint],
            passing: testResult,
          },
        },
      });

      if (!testResult) {
        worldState.reportFailure(endpoint, `Integration test '${testName}' failed`, agentId || "system");
      }

      updateWidgetState();

      return {
        content: [
          {
            type: "text",
            text: testResult
              ? `✓ Integration test '${testName}' PASSED. World state updated.`
              : `✗ Integration test '${testName}' FAILED. Fix work auto-queued.`,
          },
        ],
      };
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
}

// ========================================
// WIDGET HTML
// ========================================

const WIDGET_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SYNAPSE - Shared Cognition</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #050508;
      --surface: #0c0c12;
      --surface2: #14141f;
      --border: #1f1f2e;
      --text: #e4e4ed;
      --text-dim: #6b6b80;
      --planner: #a855f7;
      --coder: #3b82f6;
      --tester: #22c55e;
      --goal-pending: #f59e0b;
      --goal-progress: #3b82f6;
      --goal-satisfied: #22c55e;
      --glow: 0 0 40px;
    }
    body {
      font-family: 'Inter', -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      overflow: hidden;
    }
    .container {
      display: grid;
      grid-template-columns: 280px 1fr 300px;
      grid-template-rows: auto 1fr auto;
      height: 100vh;
      gap: 1px;
      background: var(--border);
    }
    .header {
      grid-column: 1 / -1;
      background: var(--surface);
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .logo {
      width: 36px;
      height: 36px;
      background: linear-gradient(135deg, var(--planner), var(--coder));
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 18px;
    }
    .title {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.5px;
    }
    .subtitle {
      font-size: 11px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .status-pill {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      background: var(--surface2);
      border-radius: 100px;
      font-size: 12px;
      font-weight: 500;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--goal-satisfied);
      animation: pulse-dot 2s infinite;
    }
    @keyframes pulse-dot {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .sidebar {
      background: var(--surface);
      padding: 20px;
      overflow-y: auto;
    }
    .section-title {
      font-size: 10px;
      font-weight: 600;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 1.5px;
      margin-bottom: 12px;
    }
    .agent-card {
      background: var(--surface2);
      border-radius: 12px;
      padding: 14px;
      margin-bottom: 10px;
      border: 1px solid var(--border);
      transition: all 0.3s ease;
    }
    .agent-card:hover {
      border-color: var(--coder);
      transform: translateX(4px);
    }
    .agent-card.planner { border-left: 3px solid var(--planner); }
    .agent-card.coder { border-left: 3px solid var(--coder); }
    .agent-card.tester { border-left: 3px solid var(--tester); }
    .agent-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;
    }
    .agent-name {
      font-weight: 600;
      font-size: 13px;
    }
    .agent-role {
      font-size: 10px;
      padding: 3px 8px;
      border-radius: 100px;
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 0.5px;
    }
    .agent-role.planner { background: rgba(168, 85, 247, 0.2); color: var(--planner); }
    .agent-role.coder { background: rgba(59, 130, 246, 0.2); color: var(--coder); }
    .agent-role.tester { background: rgba(34, 197, 94, 0.2); color: var(--tester); }
    .agent-status {
      font-size: 11px;
      color: var(--text-dim);
    }
    .main {
      background: var(--bg);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px;
      position: relative;
      overflow: hidden;
    }
    .goal-display {
      text-align: center;
      position: relative;
      z-index: 10;
    }
    .goal-ring {
      width: 200px;
      height: 200px;
      border-radius: 50%;
      border: 4px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      position: relative;
      transition: all 0.5s ease;
    }
    .goal-ring::before {
      content: '';
      position: absolute;
      inset: -4px;
      border-radius: 50%;
      border: 4px solid transparent;
      border-top-color: var(--goal-progress);
      animation: spin 2s linear infinite;
    }
    .goal-ring.satisfied {
      border-color: var(--goal-satisfied);
      box-shadow: var(--glow) rgba(34, 197, 94, 0.3);
    }
    .goal-ring.satisfied::before {
      border-color: var(--goal-satisfied);
      animation: none;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .goal-percent {
      font-size: 48px;
      font-weight: 800;
      letter-spacing: -2px;
    }
    .goal-percent.satisfied { color: var(--goal-satisfied); }
    .goal-label {
      font-size: 14px;
      color: var(--text-dim);
      margin-bottom: 8px;
    }
    .goal-title {
      font-size: 22px;
      font-weight: 700;
      margin-bottom: 8px;
      max-width: 400px;
    }
    .goal-criteria {
      display: flex;
      gap: 8px;
      justify-content: center;
      flex-wrap: wrap;
      margin-top: 16px;
    }
    .criterion {
      padding: 6px 12px;
      background: var(--surface);
      border-radius: 100px;
      font-size: 11px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .criterion.done { color: var(--goal-satisfied); }
    .criterion .check {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
    }
    .criterion.done .check {
      background: var(--goal-satisfied);
      color: white;
    }
    .work-panel {
      background: var(--surface);
      padding: 20px;
      overflow-y: auto;
    }
    .work-item {
      background: var(--surface2);
      border-radius: 10px;
      padding: 12px;
      margin-bottom: 8px;
      border: 1px solid var(--border);
      font-size: 12px;
    }
    .work-item.active {
      border-color: var(--coder);
      animation: work-pulse 1.5s infinite;
    }
    .work-item.completed {
      opacity: 0.5;
      text-decoration: line-through;
    }
    @keyframes work-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.4); }
      50% { box-shadow: 0 0 0 8px rgba(59, 130, 246, 0); }
    }
    .work-header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .work-role {
      font-size: 9px;
      padding: 2px 6px;
      border-radius: 4px;
      text-transform: uppercase;
      font-weight: 600;
    }
    .work-role.planner { background: rgba(168, 85, 247, 0.2); color: var(--planner); }
    .work-role.coder, .work-role.fixer { background: rgba(59, 130, 246, 0.2); color: var(--coder); }
    .work-role.tester { background: rgba(34, 197, 94, 0.2); color: var(--tester); }
    .work-desc { color: var(--text-dim); }
    .footer {
      grid-column: 1 / -1;
      background: var(--surface);
      padding: 12px 24px;
      display: flex;
      gap: 12px;
      overflow-x: auto;
    }
    .event-chip {
      flex-shrink: 0;
      padding: 8px 14px;
      background: var(--surface2);
      border-radius: 8px;
      font-size: 11px;
      display: flex;
      align-items: center;
      gap: 8px;
      animation: slide-in 0.3s ease;
    }
    @keyframes slide-in {
      from { transform: translateX(-20px); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
    .event-time {
      color: var(--text-dim);
      font-size: 10px;
    }
    .empty-state {
      text-align: center;
      color: var(--text-dim);
    }
    .empty-state h3 {
      font-size: 18px;
      margin-bottom: 8px;
      color: var(--text);
    }
    .bg-grid {
      position: absolute;
      inset: 0;
      background-image:
        linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px);
      background-size: 40px 40px;
      pointer-events: none;
    }
    .bg-glow {
      position: absolute;
      width: 400px;
      height: 400px;
      border-radius: 50%;
      filter: blur(100px);
      opacity: 0.15;
      pointer-events: none;
    }
    .bg-glow.purple { background: var(--planner); top: 20%; left: 30%; }
    .bg-glow.blue { background: var(--coder); bottom: 20%; right: 30%; }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div class="brand">
        <div class="logo">S</div>
        <div>
          <div class="title">SYNAPSE</div>
          <div class="subtitle">Shared Cognition Runtime</div>
        </div>
      </div>
      <div class="status-pill">
        <div class="status-dot" id="status-dot"></div>
        <span id="status-text">Connected</span>
      </div>
    </header>

    <aside class="sidebar">
      <div class="section-title">Active Agents</div>
      <div id="agents-list">
        <div class="empty-state">
          <p>No agents connected</p>
        </div>
      </div>
    </aside>

    <main class="main">
      <div class="bg-grid"></div>
      <div class="bg-glow purple"></div>
      <div class="bg-glow blue"></div>

      <div class="goal-display" id="goal-display">
        <div class="goal-ring" id="goal-ring">
          <span class="goal-percent" id="goal-percent">0%</span>
        </div>
        <div class="goal-label">CURRENT GOAL</div>
        <div class="goal-title" id="goal-title">Awaiting goal...</div>
        <div class="goal-criteria" id="goal-criteria"></div>
      </div>
    </main>

    <aside class="work-panel">
      <div class="section-title">Work Queue</div>
      <div id="work-list">
        <div class="empty-state">
          <p>No pending work</p>
        </div>
      </div>
    </aside>

    <footer class="footer" id="events"></footer>
  </div>

  <script>
    let state = { agents: [], goals: [], workQueue: [], recentEvents: [] };

    function render() {
      // Agents
      const agentsEl = document.getElementById('agents-list');
      if (state.agents.length === 0) {
        agentsEl.innerHTML = '<div class="empty-state"><p>No agents connected</p></div>';
      } else {
        agentsEl.innerHTML = state.agents.map(a =>
          '<div class="agent-card ' + (a.role || '') + '">' +
            '<div class="agent-header">' +
              '<span class="agent-name">' + a.label + '</span>' +
              '<span class="agent-role ' + (a.role || '') + '">' + (a.role || 'agent') + '</span>' +
            '</div>' +
            '<div class="agent-status">Active</div>' +
          '</div>'
        ).join('');
      }

      // Goal
      const goalDisplay = document.getElementById('goal-display');
      const goalRing = document.getElementById('goal-ring');
      const goalPercent = document.getElementById('goal-percent');
      const goalTitle = document.getElementById('goal-title');
      const goalCriteria = document.getElementById('goal-criteria');

      if (state.goals.length > 0) {
        const goal = state.goals[0];
        const status = goal.status || 'pending';
        const isSatisfied = status === 'satisfied';
        const progress = isSatisfied ? 100 : (status === 'converging' ? 66 : (status === 'in_progress' ? 33 : 0));

        goalRing.className = 'goal-ring' + (isSatisfied ? ' satisfied' : '');
        goalPercent.textContent = progress + '%';
        goalPercent.className = 'goal-percent' + (isSatisfied ? ' satisfied' : '');
        goalTitle.textContent = goal.label || 'Working...';

        if (goal.criteria) {
          goalCriteria.innerHTML = goal.criteria.map((c, i) =>
            '<div class="criterion' + (i < progress/33 ? ' done' : '') + '">' +
              '<span class="check">' + (i < progress/33 ? '✓' : '') + '</span>' +
              c +
            '</div>'
          ).join('');
        }
      } else {
        goalPercent.textContent = '—';
        goalTitle.textContent = 'Awaiting goal...';
        goalCriteria.innerHTML = '';
      }

      // Work Queue
      const workEl = document.getElementById('work-list');
      if (state.workQueue.length === 0) {
        workEl.innerHTML = '<div class="empty-state"><p>No pending work</p></div>';
      } else {
        workEl.innerHTML = state.workQueue.slice(0, 8).map(w =>
          '<div class="work-item ' + w.status + '">' +
            '<div class="work-header">' +
              '<span class="work-role ' + w.role + '">' + w.role + '</span>' +
            '</div>' +
            '<div class="work-desc">' + w.description + '</div>' +
          '</div>'
        ).join('');
      }

      // Events
      const eventsEl = document.getElementById('events');
      eventsEl.innerHTML = state.recentEvents.slice(-6).reverse().map(e =>
        '<div class="event-chip">' +
          '<span>' + e.description + '</span>' +
        '</div>'
      ).join('');
    }

    function updateState(newState) {
      if (!newState) return;
      state.agents = newState.agents || [];
      state.goals = newState.goals || [];
      state.workQueue = newState.workQueue || [];
      state.recentEvents = newState.recentEvents || [];
      render();
    }

    function connect() {
      const statusDot = document.getElementById('status-dot');
      const statusText = document.getElementById('status-text');
      statusText.textContent = 'Connecting...';
      statusDot.style.background = '#f59e0b';

      const es = new EventSource('/events');
      es.onopen = () => {
        statusText.textContent = 'Connected';
        statusDot.style.background = '#22c55e';
      };
      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'widget_state') {
            updateState(data.state);
          }
        } catch (err) {}
      };
      es.onerror = () => {
        statusText.textContent = 'Disconnected';
        statusDot.style.background = '#ef4444';
        es.close();
        setTimeout(connect, 2000);
      };
    }

    connect();
    fetch('/api/graph').then(r => r.json()).then(updateState).catch(() => {});
  </script>
</body>
</html>`;

// ========================================
// HTTP + WEBSOCKET SERVER
// ========================================

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Widget HTML
  if (url.pathname === "/" || url.pathname === "/widget") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(WIDGET_HTML);
    return;
  }

  // SSE endpoint for realtime updates
  if (url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    sseClients.add(res);

    // Send initial state
    res.write(`data: ${JSON.stringify({ type: "widget_state", state: widgetState })}\n\n`);

    req.on("close", () => {
      sseClients.delete(res);
    });
    return;
  }

  // Graph state API
  if (url.pathname === "/api/graph" && req.method === "GET") {
    updateWidgetState();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(widgetState));
    return;
  }

  // MCP tools list
  if (url.pathname === "/mcp/tools" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tools }));
    return;
  }

  // MCP tool execution
  if (url.pathname === "/mcp/execute" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      try {
        const { tool, arguments: args, clientId } = JSON.parse(body);
        const result = await executeTool(tool, args || {}, clientId || generateId());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Standard MCP JSON-RPC endpoint
  if (url.pathname === "/mcp" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      try {
        const rpc = JSON.parse(body);
        const clientId = rpc.clientId || req.headers["x-client-id"] || generateId();

        let result: any;

        switch (rpc.method) {
          case "initialize":
            result = {
              protocolVersion: "2024-11-05",
              serverInfo: { name: "synapse", version: "2.0.0" },
              capabilities: { tools: {} },
            };
            break;

          case "tools/list":
            result = { tools };
            break;

          case "tools/call":
            result = await executeTool(rpc.params.name, rpc.params.arguments || {}, clientId as string);
            break;

          case "resources/list":
            result = {
              resources: [
                {
                  uri: "synapse://widget/graph",
                  name: "Collaboration Graph",
                  description: "Live visualization of agent collaboration",
                  mimeType: "text/html",
                },
              ],
            };
            break;

          case "resources/read":
            if (rpc.params.uri === "synapse://widget/graph") {
              result = {
                contents: [
                  {
                    uri: "synapse://widget/graph",
                    mimeType: "text/html",
                    text: WIDGET_HTML,
                  },
                ],
              };
            }
            break;

          default:
            result = { error: `Unknown method: ${rpc.method}` };
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result,
        }));
      } catch (e: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: e.message },
        }));
      }
    });
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// WebSocket for realtime
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws: WebSocket) => {
  const clientId = generateId();
  wsClients.add(ws);
  log.info(`WebSocket client connected: ${clientId}`);

  // Send initial state
  ws.send(JSON.stringify({ type: "widget_state", state: widgetState }));

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "tool_call") {
        const result = await executeTool(msg.tool, msg.arguments || {}, clientId);
        ws.send(JSON.stringify({ type: "tool_result", id: msg.id, result }));
      } else if (msg.type === "subscribe") {
        // Already subscribed via WebSocket
        ws.send(JSON.stringify({ type: "subscribed" }));
      }
    } catch (e: any) {
      ws.send(JSON.stringify({ type: "error", message: e.message }));
    }
  });

  ws.on("close", () => {
    wsClients.delete(ws);
    // Unregister agent if connected
    const agentId = clientAgents.get(clientId);
    if (agentId) {
      state.unregisterAgent(agentId);
      clientAgents.delete(clientId);
      updateWidgetState();
    }
    log.info(`WebSocket client disconnected: ${clientId}`);
  });
});

// Export for external use
export { httpServer, wss, tools, executeTool, WIDGET_HTML, widgetState };

// Start if run directly
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = parseInt(process.env.PORT || "3200");

  httpServer.listen(port, () => {
    log.info(`
╔═══════════════════════════════════════════════════════════════╗
║                    SYNAPSE MCP SERVER                         ║
╠═══════════════════════════════════════════════════════════════╣
║  HTTP:      http://localhost:${port}                             ║
║  WebSocket: ws://localhost:${port}                               ║
║  Widget:    http://localhost:${port}/widget                      ║
║  MCP:       http://localhost:${port}/mcp                         ║
╠═══════════════════════════════════════════════════════════════╣
║  Connect from ChatGPT, Claude Desktop, Cursor, or VSCode      ║
╠═══════════════════════════════════════════════════════════════╣
║  Available Tools:                                             ║
║    register_agent, declare_intent, acquire_lock,              ║
║    release_lock, publish_update, subscribe_changes,           ║
║    spawn_role_agent, get_graph_state, list_agents             ║
╚═══════════════════════════════════════════════════════════════╝
`);
    updateWidgetState();
  });
}
