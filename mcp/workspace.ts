import type { Response } from "express";
import type { WorkspaceState, Agent, MissionState, Conflict, ApprovalGate, WarRoomCard, CommandCenterState, MeetingKitState } from "./types.js";
import { DEFAULT_LOCK_TTL } from "./types.js";
import { now, Logger } from "../shared/utils.js";

const log = new Logger("Stigmergy");

export const workspace: WorkspaceState = {
  target: null,
  agents: new Map(),
  locks: new Map(),
  intents: [],
  handoffs: new Map(),
  workQueue: [],
  version: 0,
};

// Mission Control state
export let missionState: MissionState = "idle";
export const conflicts: Conflict[] = [];
export const approvalGates: ApprovalGate[] = [];

// War Room cards
export const warRoomCards = new Map<string, WarRoomCard>();

// Command Center state
export const commandCenter: CommandCenterState = {
  activeModules: [],
  status: "idle",
  statusMessage: "Ready",
  data: { emails: [], flights: [], hotels: [], events: [], terminal: [] },
  actions: [],
  lastUpdated: now(),
};

// Meeting Kit state
export const meetingKit: MeetingKitState = {
  status: "idle",
  statusMessage: "Ready",
  runId: "",
  contextVersion: 0,
  meeting: { company: "", people: [], date: "", time: "", location: "", goal: "", emailSubject: "", emailFrom: "", emailId: undefined },
  context: {
    companyOrFirm: "",
    people: [],
    meetingGoal: "",
    date: "",
    time: "",
    timezone: "",
    locationOrLink: "",
    timeboxMinutes: 30,
    yourProductOneLiner: "",
    stage: "",
    raiseTarget: "",
    meetingLink: undefined,
    sourceEmail: undefined,
    assumptions: [],
    version: 0,
  },
  sections: [],
  agentFeed: [],
  draftReply: "",
  draftId: undefined,
  draftWebLink: undefined,
  lastUpdated: now(),
};

export function setMissionState(state: MissionState): void {
  missionState = state;
}

export function getMissionState(): MissionState {
  return missionState;
}

/** Compute mission state based on workspace activity */
export function computeMissionState(): MissionState {
  // Check for pending conflicts first - highest priority
  const pendingConflicts = conflicts.filter(c => c.status === "pending");
  if (pendingConflicts.length > 0) {
    return "conflict";
  }

  // Check for pending approval gates
  const pendingApprovals = approvalGates.filter(a => a.status === "pending");
  if (pendingApprovals.length > 0) {
    return "conflict"; // Approvals also show as conflict state
  }

  const agents = Array.from(workspace.agents.values());
  const workItems = workspace.workQueue;

  // No agents = idle
  if (agents.length === 0) {
    return "idle";
  }

  // Check if all work is complete
  const allWorkDone = workItems.length > 0 && workItems.every(w => w.status === "completed");
  if (allWorkDone) {
    return "complete";
  }

  // Check if any agent is actively working
  const anyWorking = agents.some(a => a.status === "working");
  if (anyWorking) {
    return "executing";
  }

  // Agents present but no work or waiting = planning
  if (workspace.target) {
    return "executing";
  }

  return "planning";
}

export const clientAgents = new Map<string, string>();

export const sseClients = new Set<Response>();

let bumpHook: (() => void) | null = null;

/** Register a callback invoked after every version bump (e.g. SSE broadcast). */
export function setBumpHook(fn: () => void): void {
  bumpHook = fn;
}

const MAX_INTENTS = 50;

/** Increment workspace version and notify listeners (SSE, etc.). */
export function bumpVersion(): void {
  workspace.version++;
  if (workspace.intents.length > MAX_INTENTS) {
    workspace.intents = workspace.intents.slice(-MAX_INTENTS);
  }
  bumpHook?.();
}

/** Populate workspace with demo data for visualization on first load. */
export function initDemoData(): void {
  const demoAgents: Agent[] = [
    {
      id: "demo-chatgpt",
      name: "ChatGPT Planner",
      client: "chatgpt",
      role: "planner",
      status: "idle",
      joinedAt: now() - 60000,
      lastSeen: now(),
      autonomous: true,
    },
    {
      id: "demo-claude",
      name: "Claude Backend",
      client: "claude",
      role: "backend",
      status: "working",
      currentTask: "src/api/auth.ts",
      joinedAt: now() - 45000,
      lastSeen: now(),
      autonomous: true,
    },
    {
      id: "demo-cursor",
      name: "Cursor Frontend",
      client: "cursor",
      role: "frontend",
      status: "waiting",
      joinedAt: now() - 30000,
      lastSeen: now(),
      autonomous: true,
    },
  ];

  demoAgents.forEach(a => workspace.agents.set(a.id, a));

  workspace.target = "Login Page";

  const lockTs = now() - 10000;
  workspace.locks.set("src/api/auth.ts", {
    path: "src/api/auth.ts",
    agentId: "demo-claude",
    agentName: "Claude Backend",
    client: "claude",
    role: "backend",
    lockedAt: lockTs,
    expiresAt: lockTs + DEFAULT_LOCK_TTL,
    reason: "Implementing /api/login endpoint",
  });

  workspace.workQueue = [
    {
      id: "work-1",
      description: "Create POST /api/login endpoint with JWT auth",
      forRole: "backend",
      createdBy: "ChatGPT Planner",
      createdAt: now() - 50000,
      assignedTo: "demo-claude",
      status: "assigned",
      context: { target: "Login Page" },
    },
    {
      id: "work-2",
      description: "Build login form UI with email/password fields",
      forRole: "frontend",
      createdBy: "ChatGPT Planner",
      createdAt: now() - 50000,
      status: "pending",
      context: { target: "Login Page", depends_on: "backend" },
    },
  ];

  workspace.intents = [
    {
      id: "intent-1",
      agentId: "demo-chatgpt",
      agentName: "ChatGPT Planner",
      client: "chatgpt",
      action: "target_set",
      description: "Target: Login Page",
      timestamp: now() - 55000,
    },
    {
      id: "intent-2",
      agentId: "demo-claude",
      agentName: "Claude Backend",
      client: "claude",
      action: "working",
      description: "Implementing JWT authentication for /api/login",
      timestamp: now() - 20000,
    },
    {
      id: "intent-3",
      agentId: "demo-cursor",
      agentName: "Cursor Frontend",
      client: "cursor",
      action: "working",
      description: "Waiting for backend API to be ready...",
      timestamp: now() - 5000,
    },
  ];

  workspace.version = 1;
  log.info("Demo data initialized");
}
