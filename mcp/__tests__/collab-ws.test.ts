import { describe, it, expect, afterAll, beforeAll } from "vitest";
import * as http from "http";
import express from "express";
import { WebSocket } from "ws";
import { DocSessionManager } from "../doc-session-manager.js";
import { setupCollabWs } from "../collab-ws.js";

/**
 * Collect `count` JSON messages from a WS, resolving early when enough arrive.
 * Listener is attached immediately so no messages are missed.
 */
function collectMessages(ws: WebSocket, count: number, timeoutMs = 3000): Promise<any[]> {
  return new Promise((resolve) => {
    const msgs: any[] = [];
    const timer = setTimeout(() => resolve(msgs), timeoutMs);
    const handler = (raw: any) => {
      try { msgs.push(JSON.parse(raw.toString())); } catch { msgs.push(raw); }
      if (msgs.length >= count) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msgs);
      }
    };
    ws.on("message", handler);
  });
}

/** Connect a WS client to the test server, resolves when open. */
function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/collab`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

describe("collab-ws", () => {
  let server: http.Server;
  let docManager: DocSessionManager;
  let port: number;
  const openSockets: WebSocket[] = [];

  beforeAll(async () => {
    const app = express();
    server = http.createServer(app);
    docManager = new DocSessionManager();
    setupCollabWs(server, docManager);

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function openWs(): Promise<WebSocket> {
    const ws = await connect(port);
    openSockets.push(ws);
    return ws;
  }

  it("returns error when joining a doc that doesn't exist", async () => {
    const ws = await openWs();
    const collector = collectMessages(ws, 1);
    ws.send(JSON.stringify({ type: "join", path: "nonexistent.ts", agentId: "a1", name: "A", role: "any", environment: "test" }));
    const msgs = await collector;
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    const errMsg = msgs.find(m => m.type === "error");
    expect(errMsg).toBeDefined();
    expect(errMsg.message).toContain("Doc not found");
  });

  it("sends sync + awareness on successful join", async () => {
    docManager.create("hello.ts", "initial");
    const ws = await openWs();
    // Attach listener BEFORE sending to avoid missing fast responses
    const collector = collectMessages(ws, 3);
    ws.send(JSON.stringify({ type: "join", path: "hello.ts", agentId: "a1", name: "Alice", role: "backend", environment: "cursor" }));
    const msgs = await collector;

    const syncMsg = msgs.find(m => m.type === "sync");
    expect(syncMsg).toBeDefined();
    expect(syncMsg.snapshot).toBeInstanceOf(Array);

    const awarenessMsg = msgs.find(m => m.type === "awareness");
    expect(awarenessMsg).toBeDefined();
    expect(awarenessMsg.editors.length).toBe(1);
    expect(awarenessMsg.editors[0].name).toBe("Alice");
  });

  it("returns error for unknown message type", async () => {
    docManager.create("err.ts");
    const ws = await openWs();

    // First join successfully
    const joinCollector = collectMessages(ws, 3);
    ws.send(JSON.stringify({ type: "join", path: "err.ts", agentId: "e1", name: "E", role: "any", environment: "test" }));
    await joinCollector;

    // Then send unknown type
    const errCollector = collectMessages(ws, 1);
    ws.send(JSON.stringify({ type: "bogus" }));
    const msgs = await errCollector;

    const errMsg = msgs.find(m => m.type === "error");
    expect(errMsg).toBeDefined();
    expect(errMsg.message).toContain("Unknown message type");
  });

  it("returns error for join without path", async () => {
    const ws = await openWs();
    const collector = collectMessages(ws, 1);
    ws.send(JSON.stringify({ type: "join", agentId: "a1" }));
    const msgs = await collector;
    const errMsg = msgs.find(m => m.type === "error");
    expect(errMsg).toBeDefined();
    expect(errMsg.message).toContain("path is required");
  });

  it("handles invalid JSON gracefully", async () => {
    const ws = await openWs();
    const collector = collectMessages(ws, 1);
    ws.send("not json at all");
    const msgs = await collector;
    const errMsg = msgs.find(m => m.type === "error");
    expect(errMsg).toBeDefined();
    expect(errMsg.message).toContain("Invalid JSON");
  });
});
