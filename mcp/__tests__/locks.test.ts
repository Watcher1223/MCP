import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startLockCleanup } from "../locks.js";
import type { WorkspaceState } from "../types.js";

function createTestWorkspace(): WorkspaceState {
  return {
    target: null,
    agents: new Map(),
    locks: new Map(),
    intents: [],
    handoffs: new Map(),
    workQueue: [],
    version: 0,
  };
}

describe("startLockCleanup", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("evicts expired locks after 5s interval", () => {
    const ws = createTestWorkspace();
    const bumpVersion = vi.fn();

    const expiredAt = Date.now() - 1000;
    ws.locks.set("src/old.ts", {
      path: "src/old.ts",
      agentId: "a1",
      agentName: "Agent",
      client: "cursor",
      role: "backend",
      lockedAt: expiredAt - 120_000,
      expiresAt: expiredAt,
    });

    startLockCleanup(ws, bumpVersion);

    expect(ws.locks.size).toBe(1);
    vi.advanceTimersByTime(5_000);
    expect(ws.locks.size).toBe(0);
    expect(bumpVersion).toHaveBeenCalledTimes(1);
  });

  it("emits a handoff intent for each expired lock", () => {
    const ws = createTestWorkspace();
    const bumpVersion = vi.fn();

    ws.locks.set("a.ts", {
      path: "a.ts",
      agentId: "a1",
      agentName: "Alice",
      client: "claude",
      role: "backend",
      lockedAt: 0,
      expiresAt: Date.now() - 1,
    });
    ws.locks.set("b.ts", {
      path: "b.ts",
      agentId: "a2",
      agentName: "Bob",
      client: "cursor",
      role: "frontend",
      lockedAt: 0,
      expiresAt: Date.now() - 1,
    });

    startLockCleanup(ws, bumpVersion);
    vi.advanceTimersByTime(5_000);

    expect(ws.intents.length).toBe(2);
    expect(ws.intents[0].action).toBe("handoff");
    expect(ws.intents[0].description).toContain("a.ts");
    expect(ws.intents[1].description).toContain("b.ts");
  });

  it("sets agent status to idle when their lock expires", () => {
    const ws = createTestWorkspace();
    const bumpVersion = vi.fn();

    ws.agents.set("a1", {
      id: "a1",
      name: "Alice",
      client: "claude",
      role: "backend",
      status: "working",
      currentTask: "src/x.ts",
      joinedAt: 0,
      lastSeen: 0,
      autonomous: true,
    });

    ws.locks.set("src/x.ts", {
      path: "src/x.ts",
      agentId: "a1",
      agentName: "Alice",
      client: "claude",
      role: "backend",
      lockedAt: 0,
      expiresAt: Date.now() - 1,
    });

    startLockCleanup(ws, bumpVersion);
    vi.advanceTimersByTime(5_000);

    const agent = ws.agents.get("a1")!;
    expect(agent.status).toBe("idle");
    expect(agent.currentTask).toBeUndefined();
  });

  it("does NOT evict non-expired locks", () => {
    const ws = createTestWorkspace();
    const bumpVersion = vi.fn();

    ws.locks.set("alive.ts", {
      path: "alive.ts",
      agentId: "a1",
      agentName: "Agent",
      client: "cursor",
      role: "any",
      lockedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });

    startLockCleanup(ws, bumpVersion);
    vi.advanceTimersByTime(5_000);

    expect(ws.locks.size).toBe(1);
    expect(bumpVersion).not.toHaveBeenCalled();
  });
});
