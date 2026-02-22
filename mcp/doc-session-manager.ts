import * as Y from "yjs";
import type { WebSocket } from "ws";
import type { AwarenessEntry, DocSession, DocSessionMeta } from "./types.js";
import { now, Logger } from "../shared/utils.js";

const log = new Logger("Synapse");

export const DOC_COLOR_PALETTE = [
  "#3b82f6", "#22c55e", "#a855f7", "#f59e0b",
  "#ef4444", "#06b6d4", "#ec4899", "#14b8a6",
];

/** Deterministic color from agentId (stable across reconnects). */
export function agentColor(agentId: string): string {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = ((hash << 5) - hash + agentId.charCodeAt(i)) | 0;
  }
  return DOC_COLOR_PALETTE[Math.abs(hash) % DOC_COLOR_PALETTE.length];
}

/**
 * Manages Yjs document sessions keyed by file path.
 *
 * Responsibilities:
 * - Create / get / list doc sessions
 * - Track per-session editors + awareness
 * - Apply and broadcast Yjs updates
 * - Provide snapshots for non-WS agents
 */
export class DocSessionManager {
  private sessions: Map<string, DocSession> = new Map();

  /** Create a new doc session. Idempotent: returns existing if present. */
  create(path: string, initialContent?: string): { created: boolean; session: DocSessionMeta } {
    const existing = this.sessions.get(path);
    if (existing) {
      return { created: false, session: this.toMeta(existing) };
    }

    const doc = new Y.Doc();
    if (initialContent) {
      doc.getText("content").insert(0, initialContent);
    }

    const session: DocSession = {
      path,
      doc,
      awareness: new Map(),
      clients: new Set(),
      createdAt: now(),
      lastActivity: now(),
      updateCount: 0,
    };
    this.sessions.set(path, session);

    log.info(`Doc created: ${path}`);
    return { created: true, session: this.toMeta(session) };
  }

  get(path: string): DocSession | undefined {
    return this.sessions.get(path);
  }

  /**
   * Add a WS client to a session.
   * Returns null if the doc doesn't exist (must be created first).
   */
  join(
    path: string,
    ws: WebSocket,
    agent: { agentId: string; name: string; role: string; environment: string },
  ): DocSession | null {
    const session = this.sessions.get(path);
    if (!session) return null;

    session.clients.add(ws);
    session.awareness.set(agent.agentId, {
      agentId: agent.agentId,
      name: agent.name,
      role: agent.role,
      environment: agent.environment,
      color: agentColor(agent.agentId),
      isTyping: false,
    });
    session.lastActivity = now();

    log.info(`Doc joined: ${path} by ${agent.name}`);
    return session;
  }

  /** Remove a WS client. Cleans up awareness entry. Schedules session removal when empty. */
  leave(path: string, ws: WebSocket, agentId?: string): void {
    const session = this.sessions.get(path);
    if (!session) return;

    session.clients.delete(ws);
    if (agentId) {
      session.awareness.delete(agentId);
    }

    log.info(`Doc left: ${path} (${session.clients.size} remaining)`);

    if (session.clients.size === 0) {
      setTimeout(() => {
        const s = this.sessions.get(path);
        if (s && s.clients.size === 0) {
          this.sessions.delete(path);
          log.info(`Doc session cleaned up: ${path}`);
        }
      }, 60_000);
    }
  }

  /** Apply a Yjs update and broadcast to all other clients. */
  applyUpdate(path: string, update: Uint8Array, sender: WebSocket): void {
    const session = this.sessions.get(path);
    if (!session) return;

    Y.applyUpdate(session.doc, update);
    session.updateCount++;
    session.lastActivity = now();

    const msg = Buffer.from(update);
    Array.from(session.clients).forEach(client => {
      if (client !== sender && client.readyState === 1) {
        client.send(msg);
      }
    });
  }

  /** Update awareness for an agent and broadcast to others. */
  updateAwareness(
    path: string,
    agentId: string,
    patch: Partial<Pick<AwarenessEntry, "cursor" | "isTyping">>,
    sender: WebSocket,
  ): void {
    const session = this.sessions.get(path);
    if (!session) return;

    const entry = session.awareness.get(agentId);
    if (entry) {
      Object.assign(entry, patch);
    }
    session.lastActivity = now();

    const payload = JSON.stringify({
      type: "awareness",
      updatedBy: agentId,
      editors: this.editorList(session),
    });
    Array.from(session.clients).forEach(client => {
      if (client !== sender && client.readyState === 1) {
        client.send(payload);
      }
    });
  }

  /** Full Yjs state as a Uint8Array (for initial sync on join). */
  getSnapshot(path: string): Uint8Array | null {
    const session = this.sessions.get(path);
    if (!session) return null;
    return Y.encodeStateAsUpdate(session.doc);
  }

  /** Plain-text content of the Y.Text named "content". */
  getTextContent(path: string): string | null {
    const session = this.sessions.get(path);
    if (!session) return null;
    return session.doc.getText("content").toString();
  }

  /** Metadata list of all active sessions (for dashboard / widget). */
  listSessions(): DocSessionMeta[] {
    return Array.from(this.sessions.values()).map(s => this.toMeta(s));
  }

  private editorList(session: DocSession): { name: string; role: string; environment: string; color: string }[] {
    return Array.from(session.awareness.values()).map(a => ({
      name: a.name,
      role: a.role,
      environment: a.environment,
      color: a.color,
    }));
  }

  private toMeta(session: DocSession): DocSessionMeta {
    return {
      path: session.path,
      editors: this.editorList(session),
      lastActivity: session.lastActivity,
      updateCount: session.updateCount,
    };
  }
}
