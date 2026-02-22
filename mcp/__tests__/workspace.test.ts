import { describe, it, expect, beforeEach } from "vitest";
import { workspace, bumpVersion, setBumpHook, initDemoData } from "../workspace.js";

function resetWorkspace() {
  workspace.agents.clear();
  workspace.locks.clear();
  workspace.intents = [];
  workspace.handoffs.clear();
  workspace.workQueue = [];
  workspace.target = null;
  workspace.version = 0;
}

describe("workspace", () => {
  beforeEach(() => {
    resetWorkspace();
    setBumpHook(() => {});
  });

  describe("bumpVersion", () => {
    it("increments workspace.version by 1", () => {
      expect(workspace.version).toBe(0);
      bumpVersion();
      expect(workspace.version).toBe(1);
      bumpVersion();
      expect(workspace.version).toBe(2);
    });

    it("calls the registered bump hook", () => {
      let called = 0;
      setBumpHook(() => { called++; });
      bumpVersion();
      bumpVersion();
      expect(called).toBe(2);
    });
  });

  describe("initDemoData", () => {
    it("populates agents, locks, intents, workQueue, and target", () => {
      initDemoData();
      expect(workspace.agents.size).toBe(3);
      expect(workspace.locks.size).toBe(1);
      expect(workspace.intents.length).toBe(3);
      expect(workspace.workQueue.length).toBe(2);
      expect(workspace.target).toBe("Login Page");
      expect(workspace.version).toBe(1);
    });

    it("creates agents with expected roles", () => {
      initDemoData();
      const roles = Array.from(workspace.agents.values()).map(a => a.role);
      expect(roles).toContain("planner");
      expect(roles).toContain("backend");
      expect(roles).toContain("frontend");
    });
  });
});
