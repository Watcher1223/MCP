import type { Response } from "express";
import type { WebSocket } from "ws";
import type * as Y from "yjs";

export const DEFAULT_LOCK_TTL = 120_000; // 2 minutes

export interface Agent {
  id: string;
  name: string;
  client: "chatgpt" | "claude" | "cursor" | "vscode" | "terminal";
  role: "planner" | "backend" | "frontend" | "tester" | "any";
  status: "idle" | "working" | "waiting" | "disconnected";
  currentTask?: string;
  joinedAt: number;
  lastSeen: number;
  autonomous: boolean;
}

export interface FileLock {
  path: string;
  agentId: string;
  agentName: string;
  client: string;
  role: string;
  lockedAt: number;
  expiresAt: number;
  reason?: string;
}

export interface Intent {
  id: string;
  agentId: string;
  agentName: string;
  client: string;
  action: "working" | "completed" | "blocked" | "handoff" | "target_set";
  description: string;
  target?: string;
  timestamp: number;
}

export interface WorkItem {
  id: string;
  description: string;
  forRole: "backend" | "frontend" | "tester" | "any";
  createdBy: string;
  createdAt: number;
  assignedTo?: string;
  status: "pending" | "assigned" | "completed";
  context?: Record<string, any>;
}

export interface WorkspaceState {
  target: string | null;
  agents: Map<string, Agent>;
  locks: Map<string, FileLock>;
  intents: Intent[];
  handoffs: Map<string, string>;
  workQueue: WorkItem[];
  version: number;
}

export interface AwarenessEntry {
  agentId: string;
  name: string;
  role: string;
  environment: string;
  color: string;
  cursor?: { anchor: number; head: number };
  isTyping: boolean;
}

export interface DocSession {
  path: string;
  doc: Y.Doc;
  awareness: Map<string, AwarenessEntry>;
  clients: Set<WebSocket>;
  createdAt: number;
  lastActivity: number;
  updateCount: number;
}

export interface DocSessionMeta {
  path: string;
  editors: { name: string; role: string; environment: string; color: string }[];
  lastActivity: number;
  updateCount: number;
}

// ========================================
// MISSION CONTROL TYPES
// ========================================

export type MissionState = "idle" | "planning" | "executing" | "conflict" | "complete";

export interface Conflict {
  id: string;
  type: "lock_collision" | "merge_conflict" | "dependency_cycle" | "resource_contention";
  description: string;
  involvedAgents: string[];
  involvedFiles?: string[];
  reportedBy: string;
  reportedAt: number;
  status: "pending" | "resolved" | "escalated";
  resolution?: string;
  resolvedAt?: number;
  resolvedBy?: string;
}

export interface ApprovalGate {
  id: string;
  description: string;
  requestedBy: string;
  requestedByName: string;
  requestedAt: number;
  status: "pending" | "approved" | "rejected";
  approvedAt?: number;
  approvedBy?: string;
  rejectionReason?: string;
  context?: Record<string, unknown>;
}

// ========================================
// WAR ROOM TYPES
// ========================================

export type CardType = "command" | "info" | "task";
export type CardStatus = "pending" | "active" | "done";
export type CardColumn = "todo" | "doing" | "done";

export interface WarRoomCard {
  id: string;
  type: CardType;
  title: string;
  content: string;
  status: CardStatus;
  column: CardColumn;
  /** For 'command' type: the shell command to run */
  command?: string;
  /** For 'command' type: the output of execution */
  output?: string;
  /** Execution state for command cards */
  executing?: boolean;
  /** Category tag shown on the card */
  category?: string;
  /** Icon hint (e.g. "database", "globe", "terminal", "utensils") */
  icon?: string;
  createdAt: number;
  updatedAt: number;
}

// ========================================
// COMMAND CENTER TYPES
// ========================================

export type CCModule = "email" | "travel" | "calendar" | "terminal" | "hotels";
export type CCStatus = "idle" | "processing" | "awaiting_user" | "done";

export interface CCEmail {
  id: string;
  from: string;
  subject: string;
  preview: string;
  date: string;
  read: boolean;
  starred: boolean;
  labels: string[];
  /** Full body (optional) */
  body?: string;
}

export interface CCFlight {
  id: string;
  airline: string;
  flightNo: string;
  from: string;
  to: string;
  departure: string;
  arrival: string;
  price: number;
  currency: string;
  stops: number;
  selected: boolean;
}

export interface CCEvent {
  id: string;
  title: string;
  date: string;
  time: string;
  duration: string;
  location?: string;
  attendees?: string[];
  color?: string;
}

export interface CCHotel {
  id: string;
  name: string;
  location: string;
  stars: number;
  pricePerNight: number;
  currency: string;
  amenities: string[];
  rating: number;
  reviewCount: number;
  image?: string;
  selected: boolean;
}

export interface CCTerminalEntry {
  id: string;
  command: string;
  output: string;
  exitCode: number;
  timestamp: number;
}

export interface CCAction {
  id: string;
  module: CCModule;
  label: string;
  description: string;
  status: "pending" | "done" | "failed";
  timestamp: number;
}

export interface CommandCenterState {
  activeModules: CCModule[];
  status: CCStatus;
  statusMessage: string;
  data: {
    emails: CCEmail[];
    flights: CCFlight[];
    hotels: CCHotel[];
    events: CCEvent[];
    terminal: CCTerminalEntry[];
  };
  actions: CCAction[];
  lastUpdated: number;
}

// ========================================
// MEETING KIT TYPES
// ========================================

export interface SearchSource {
  title: string;
  url: string;
  snippet: string;
  date?: string;
}

export interface MeetingKitSection {
  id: string;
  title: string;
  icon: string;
  agentName: string;
  status: "pending" | "working" | "done" | "error";
  content: string;
  bullets?: string[];
  /** Cited web sources (populated when Serper key is present). */
  sources?: SearchSource[];
  /** True when this section's context version matches the last run and no re-run is needed. */
  cached?: boolean;
  updatedAt: number;
}

export type MeetingTimeboxMinutes = 30 | 45 | 60;

export interface MeetingSourceEmail {
  /** Gmail message id */
  id: string;
  subject?: string;
  from?: string;
  date?: string;
  snippet?: string;
}

export interface MeetingContext {
  /** Company name or firm name (editable). */
  companyOrFirm: string;
  /** Attendees (names or emails) parsed from the email and user edits. */
  people: string[];
  /** Meeting purpose/goal (editable). */
  meetingGoal: string;
  /** Meeting date (YYYY-MM-DD preferred, but allow free-form). */
  date: string;
  /** Meeting time (free-form, e.g. \"10:00 AM\"). */
  time: string;
  /** Timezone abbreviation (e.g. \"ET\", \"PT\") or IANA if available. */
  timezone: string;
  /** Location or video meeting link. */
  locationOrLink: string;
  /** Selected timebox minutes for the agenda. */
  timeboxMinutes: MeetingTimeboxMinutes;
  /** User-provided product one-liner (often missing from email). */
  yourProductOneLiner: string;
  /** Fundraising stage (seed/Series A/...) */
  stage: string;
  /** Raise target (e.g. \"$3M\" or \"TBD\") */
  raiseTarget: string;
  /** Optional extracted/entered Zoom/Meet link. */
  meetingLink?: string;
  /** Optional email source metadata for traceability. */
  sourceEmail?: MeetingSourceEmail;
  /** Free-form assumptions/missing info items shown to the user. */
  assumptions: string[];
  /** Incremented on each edit to enable selective re-runs later. */
  version: number;
}

export interface MeetingKitState {
  status: "idle" | "preparing" | "ready";
  statusMessage: string;
  /** Current generation run id (changes per Generate Kit). */
  runId: string;
  /** Snapshot of context version used for the current run. */
  contextVersion: number;
  meeting: {
    company: string;
    people: string[];
    date: string;
    time: string;
    location: string;
    goal: string;
    emailSubject: string;
    emailFrom: string;
    emailId?: string;
  };
  context: MeetingContext;
  sections: MeetingKitSection[];
  agentFeed: { agentName: string; icon: string; message: string; timestamp: number }[];
  draftReply: string;
  /** Gmail draft id after gmail_create_draft succeeds. */
  draftId?: string;
  /** Gmail compose web link for the created draft. */
  draftWebLink?: string;
  lastUpdated: number;
}
