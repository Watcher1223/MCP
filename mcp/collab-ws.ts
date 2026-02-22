import * as http from "http";
import { WebSocketServer, WebSocket } from "ws";
import type { AwarenessEntry } from "./types.js";
import type { DocSessionManager } from "./doc-session-manager.js";
import { generateId, Logger } from "../shared/utils.js";

const log = new Logger("Stigmergy");

/** Send a JSON message to a WS client (binary Yjs updates use raw buffers). */
function wsSend(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/**
 * Handle a parsed JSON message on a /collab WebSocket.
 *
 * Protocol:
 *   -> { type: "join", path, agentId, name, role, environment }
 *   <- { type: "sync", snapshot: number[] }          (Yjs state)
 *   <- { type: "awareness", editors: [...] }
 *   -> { type: "awareness", cursor?, isTyping? }     (update own)
 *   -> { type: "leave" }
 *   -> (binary)  Yjs update
 *   <- (binary)  Yjs update (broadcast)
 */
async function handleCollabMessage(
  ws: WebSocket,
  msg: Record<string, unknown>,
  joined: boolean,
  docManager: DocSessionManager,
  wsAgentMap: WeakMap<WebSocket, { path: string; agentId: string }>,
  onSessionChange: () => void,
): Promise<boolean | undefined> {
  switch (msg.type) {
    case "join": {
      if (typeof msg.path !== "string" || msg.path.length === 0) {
        wsSend(ws, { type: "error", message: "path is required and must be a non-empty string" });
        return;
      }
      if (msg.agentId !== undefined && typeof msg.agentId !== "string") {
        wsSend(ws, { type: "error", message: "agentId must be a string" });
        return;
      }
      if (msg.name !== undefined && typeof msg.name !== "string") {
        wsSend(ws, { type: "error", message: "name must be a string" });
        return;
      }

      const path = msg.path;
      const agentId = (msg.agentId as string) || generateId();
      const name = (msg.name as string) || "Anonymous";
      const role = (msg.role as string) || "any";
      const environment = (msg.environment as string) || "unknown";

      const session = docManager.join(path, ws, { agentId, name, role, environment });
      if (!session) {
        wsSend(ws, { type: "error", message: `Doc not found: ${path}. Call create_doc first.` });
        return;
      }

      wsAgentMap.set(ws, { path, agentId });

      const snapshot = docManager.getSnapshot(path);
      if (snapshot) {
        wsSend(ws, { type: "sync", snapshot: Array.from(snapshot) });
      }

      const editors = Array.from(session.awareness.values()).map(a => ({
        name: a.name, role: a.role, environment: a.environment, color: a.color,
      }));
      Array.from(session.clients).forEach(client => {
        wsSend(client, { type: "awareness", editors });
      });

      onSessionChange();
      return true;
    }

    case "awareness": {
      if (!joined) return;
      const info = wsAgentMap.get(ws);
      if (!info) return;
      docManager.updateAwareness(info.path, info.agentId, {
        cursor: msg.cursor as AwarenessEntry["cursor"],
        isTyping: msg.isTyping as boolean | undefined,
      }, ws);
      return;
    }

    case "leave": {
      const info = wsAgentMap.get(ws);
      if (info) {
        docManager.leave(info.path, ws, info.agentId);
        onSessionChange();
      }
      return false;
    }

    default:
      wsSend(ws, { type: "error", message: `Unknown message type: ${msg.type}` });
  }
}

export interface CollabWsSetup {
  collabWss: WebSocketServer;
  broadcastSessionList: () => void;
}

/**
 * Set up the /collab WebSocket endpoint on an existing HTTP server.
 * Returns the WebSocketServer and a broadcastSessionList helper.
 */
export function setupCollabWs(
  httpServer: http.Server,
  docManager: DocSessionManager,
): CollabWsSetup {
  const wsAgentMap = new WeakMap<WebSocket, { path: string; agentId: string }>();
  const collabWss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname === "/collab") {
      collabWss.handleUpgrade(req, socket, head, (ws) => {
        collabWss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  /** Notify all /collab clients about the current session list (lightweight). */
  function broadcastSessionList(): void {
    const sessions = docManager.listSessions();
    const payload = JSON.stringify({ type: "sessions", sessions });
    Array.from(collabWss.clients).forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  }

  collabWss.on("connection", (ws) => {
    let joined = false;

    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        const info = wsAgentMap.get(ws);
        if (!info) return;
        const buf = raw instanceof Buffer ? raw : Buffer.from(raw as ArrayBuffer);
        docManager.applyUpdate(info.path, new Uint8Array(buf), ws);
        return;
      }

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        wsSend(ws, { type: "error", message: "Invalid JSON" });
        return;
      }

      handleCollabMessage(ws, msg, joined, docManager, wsAgentMap, broadcastSessionList).then((j) => {
        if (j !== undefined) joined = j;
      });
    });

    ws.on("close", () => {
      const info = wsAgentMap.get(ws);
      if (info) {
        docManager.leave(info.path, ws, info.agentId);
        broadcastSessionList();
      }
    });

    ws.on("error", (err) => {
      log.info(`WS error: ${err.message}`);
      const info = wsAgentMap.get(ws);
      if (info) {
        docManager.leave(info.path, ws, info.agentId);
      }
    });
  });

  // Ping/pong heartbeat: detect stale connections every 30s
  const wsAlive = new WeakMap<WebSocket, boolean>();
  collabWss.on("connection", (ws) => {
    wsAlive.set(ws, true);
    ws.on("pong", () => { wsAlive.set(ws, true); });
  });
  setInterval(() => {
    Array.from(collabWss.clients).forEach(ws => {
      if (wsAlive.get(ws) === false) {
        log.info("Terminating stale WS connection (no pong)");
        ws.terminate();
        return;
      }
      wsAlive.set(ws, false);
      ws.ping();
    });
  }, 30_000);

  return { collabWss, broadcastSessionList };
}
