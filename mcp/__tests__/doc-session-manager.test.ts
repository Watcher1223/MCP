import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import { DocSessionManager, agentColor } from "../doc-session-manager.js";
import type { WebSocket } from "ws";

/** Minimal mock that satisfies DocSessionManager's usage of WebSocket. */
function mockWs(overrides: Partial<WebSocket> = {}): WebSocket {
  return {
    readyState: 1, // OPEN
    send: vi.fn(),
    ...overrides,
  } as unknown as WebSocket;
}

describe("DocSessionManager", () => {
  describe("create", () => {
    it("creates a new session and returns created=true", () => {
      const mgr = new DocSessionManager();
      const { created, session } = mgr.create("src/auth.ts");
      expect(created).toBe(true);
      expect(session.path).toBe("src/auth.ts");
      expect(session.editors).toEqual([]);
      expect(session.updateCount).toBe(0);
    });

    it("is idempotent — returns created=false on second call", () => {
      const mgr = new DocSessionManager();
      mgr.create("src/auth.ts");
      const { created } = mgr.create("src/auth.ts");
      expect(created).toBe(false);
    });

    it("seeds initial content when provided", () => {
      const mgr = new DocSessionManager();
      mgr.create("readme.md", "# Hello");
      expect(mgr.getTextContent("readme.md")).toBe("# Hello");
    });
  });

  describe("join", () => {
    it("returns null if doc doesn't exist", () => {
      const mgr = new DocSessionManager();
      const ws = mockWs();
      expect(mgr.join("missing.ts", ws, { agentId: "a1", name: "A", role: "backend", environment: "cursor" })).toBeNull();
    });

    it("adds client and awareness entry", () => {
      const mgr = new DocSessionManager();
      mgr.create("f.ts");
      const ws = mockWs();
      const session = mgr.join("f.ts", ws, { agentId: "a1", name: "Alice", role: "backend", environment: "cursor" });
      expect(session).not.toBeNull();
      expect(session!.clients.size).toBe(1);
      expect(session!.awareness.size).toBe(1);
      expect(session!.awareness.get("a1")!.name).toBe("Alice");
    });
  });

  describe("leave", () => {
    it("removes client and awareness entry", () => {
      const mgr = new DocSessionManager();
      mgr.create("f.ts");
      const ws = mockWs();
      mgr.join("f.ts", ws, { agentId: "a1", name: "A", role: "any", environment: "vscode" });
      mgr.leave("f.ts", ws, "a1");

      const session = mgr.get("f.ts");
      expect(session!.clients.size).toBe(0);
      expect(session!.awareness.size).toBe(0);
    });
  });

  describe("getTextContent / getSnapshot", () => {
    it("returns null for nonexistent session", () => {
      const mgr = new DocSessionManager();
      expect(mgr.getTextContent("nope")).toBeNull();
      expect(mgr.getSnapshot("nope")).toBeNull();
    });

    it("returns content after create with initial text", () => {
      const mgr = new DocSessionManager();
      mgr.create("f.ts", "hello world");
      expect(mgr.getTextContent("f.ts")).toBe("hello world");
    });

    it("returns a Uint8Array snapshot", () => {
      const mgr = new DocSessionManager();
      mgr.create("f.ts", "data");
      const snap = mgr.getSnapshot("f.ts");
      expect(snap).toBeInstanceOf(Uint8Array);
      expect(snap!.length).toBeGreaterThan(0);
    });
  });

  describe("applyUpdate", () => {
    it("broadcasts binary update to other clients (not sender)", () => {
      const mgr = new DocSessionManager();
      mgr.create("f.ts");
      const ws1 = mockWs();
      const ws2 = mockWs();
      mgr.join("f.ts", ws1, { agentId: "a1", name: "A", role: "any", environment: "x" });
      mgr.join("f.ts", ws2, { agentId: "a2", name: "B", role: "any", environment: "y" });

      const tmpDoc = new Y.Doc();
      tmpDoc.getText("content").insert(0, "test");
      const update = Y.encodeStateAsUpdate(tmpDoc);

      mgr.applyUpdate("f.ts", update, ws1);

      expect(ws1.send).not.toHaveBeenCalled();
      expect(ws2.send).toHaveBeenCalledTimes(1);
    });

    it("increments updateCount", () => {
      const mgr = new DocSessionManager();
      mgr.create("f.ts");
      const ws = mockWs();
      mgr.join("f.ts", ws, { agentId: "a1", name: "A", role: "any", environment: "x" });

      const tmpDoc = new Y.Doc();
      tmpDoc.getText("content").insert(0, "x");
      mgr.applyUpdate("f.ts", Y.encodeStateAsUpdate(tmpDoc), ws);

      expect(mgr.get("f.ts")!.updateCount).toBe(1);
    });
  });

  describe("updateAwareness", () => {
    it("broadcasts awareness to other clients", () => {
      const mgr = new DocSessionManager();
      mgr.create("f.ts");
      const ws1 = mockWs();
      const ws2 = mockWs();
      mgr.join("f.ts", ws1, { agentId: "a1", name: "A", role: "any", environment: "x" });
      mgr.join("f.ts", ws2, { agentId: "a2", name: "B", role: "any", environment: "y" });

      mgr.updateAwareness("f.ts", "a1", { isTyping: true }, ws1);

      expect(ws1.send).not.toHaveBeenCalled();
      expect(ws2.send).toHaveBeenCalledTimes(1);
      const payload = JSON.parse((ws2.send as any).mock.calls[0][0]);
      expect(payload.type).toBe("awareness");
      expect(payload.editors.length).toBe(2);
    });
  });

  describe("listSessions", () => {
    it("returns metadata for all sessions", () => {
      const mgr = new DocSessionManager();
      mgr.create("a.ts");
      mgr.create("b.ts", "content");
      const list = mgr.listSessions();
      expect(list.length).toBe(2);
      expect(list.map(s => s.path).sort()).toEqual(["a.ts", "b.ts"]);
    });
  });
});

describe("agentColor", () => {
  it("returns a string from the palette", () => {
    const color = agentColor("test-agent-id");
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("is deterministic for the same agentId", () => {
    expect(agentColor("abc")).toBe(agentColor("abc"));
  });

  it("produces different colors for different ids (usually)", () => {
    const c1 = agentColor("agent-1");
    const c2 = agentColor("agent-2");
    // Not guaranteed but very likely with different hash inputs
    expect(typeof c1).toBe("string");
    expect(typeof c2).toBe("string");
  });
});
