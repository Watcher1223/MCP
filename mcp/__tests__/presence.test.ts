import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WorkspaceState, Agent } from "../types.js";
import { startPresenceCleanup } from "../presence.js";

function makeWorkspace(): WorkspaceState {
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

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "a1",
    name: "Alice",
    client: "cursor",
    role: "backend",
    status: "idle",
    joinedAt: Date.now(),
    lastSeen: Date.now(),
    autonomous: true,
    ...overrides,
  };
}

describe("startPresenceCleanup", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("marks agents disconnected after 5 minutes of inactivity", () => {
    const ws = makeWorkspace();
    const agent = makeAgent({ lastSeen: Date.now() - 6 * 60_000 });
    ws.agents.set(agent.id, agent);
    const bump = vi.fn();

    startPresenceCleanup(ws, bump);
    vi.advanceTimersByTime(30_000);

    expect(agent.status).toBe("disconnected");
    expect(agent.currentTask).toBeUndefined();
    expect(bump).toHaveBeenCalledOnce();
  });

  it("removes agents entirely after 15 minutes of inactivity", () => {
    const ws = makeWorkspace();
    const agent = makeAgent({ lastSeen: Date.now() - 16 * 60_000 });
    ws.agents.set(agent.id, agent);
    const bump = vi.fn();

    startPresenceCleanup(ws, bump);
    vi.advanceTimersByTime(30_000);

    expect(ws.agents.has(agent.id)).toBe(false);
    expect(bump).toHaveBeenCalledOnce();
  });

  it("does not touch recently seen agents", () => {
    const ws = makeWorkspace();
    const agent = makeAgent({ lastSeen: Date.now(), status: "working" });
    ws.agents.set(agent.id, agent);
    const bump = vi.fn();

    startPresenceCleanup(ws, bump);
    vi.advanceTimersByTime(30_000);

    expect(agent.status).toBe("working");
    expect(ws.agents.has(agent.id)).toBe(true);
    expect(bump).not.toHaveBeenCalled();
  });
});
