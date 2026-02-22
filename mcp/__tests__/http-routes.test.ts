import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import type { Response } from "express";
import type { WorkspaceState } from "../types.js";
import { DocSessionManager } from "../doc-session-manager.js";
import { registerHttpRoutes } from "../http-routes.js";

function createTestApp() {
  const workspace: WorkspaceState = {
    target: "Test Target",
    agents: new Map([
      ["a1", { id: "a1", name: "Alice", client: "claude" as const, role: "backend" as const, status: "working" as const, joinedAt: 0, lastSeen: 0, autonomous: true }],
    ]),
    locks: new Map(),
    intents: [
      { id: "i1", agentId: "a1", agentName: "Alice", client: "claude", action: "working" as const, description: "coding", timestamp: Date.now() },
    ],
    handoffs: new Map(),
    workQueue: [],
    version: 5,
  };
  const clientAgents = new Map<string, string>();
  const docManager = new DocSessionManager();
  const sseClients = new Set<Response>();
  let ver = workspace.version;
  const bumpVersion = () => { ver++; workspace.version = ver; };

  const app = express();
  app.use(express.json());

  registerHttpRoutes({ app, workspace, clientAgents, docManager, sseClients, bumpVersion, API_PORT: 3201 });

  return { app, workspace, docManager, clientAgents, bumpVersion };
}

describe("HTTP routes", () => {
  const { app, workspace, docManager } = createTestApp();

  describe("GET /health", () => {
    it("returns status ok with counts", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.agents).toBe(1);
      expect(res.body.version).toBe(5);
    });
  });

  describe("GET /api/graph?format=widget", () => {
    it("returns widget data with agents array", async () => {
      const res = await request(app).get("/api/graph?format=widget");
      expect(res.status).toBe(200);
      expect(res.body.agents).toBeInstanceOf(Array);
      expect(res.body.agents[0].label).toBe("Alice");
      expect(res.body.target).toBe("Test Target");
    });
  });

  describe("GET /api/graph (raw)", () => {
    it("returns nodes and edges", async () => {
      const res = await request(app).get("/api/graph");
      expect(res.status).toBe(200);
      expect(res.body.nodes).toBeInstanceOf(Array);
      expect(res.body.edges).toBeInstanceOf(Array);
      expect(res.body.version).toBe(5);
    });
  });

  describe("GET /api/sessions", () => {
    it("returns empty sessions initially", async () => {
      const res = await request(app).get("/api/sessions");
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(0);
      expect(res.body.sessions).toEqual([]);
    });

    it("returns sessions after creating a doc", async () => {
      docManager.create("test.ts", "content");
      const res = await request(app).get("/api/sessions");
      expect(res.body.count).toBe(1);
      expect(res.body.sessions[0].path).toBe("test.ts");
    });
  });

  describe("GET /api/changes", () => {
    it("returns changed=false when version matches", async () => {
      const res = await request(app).get(`/api/changes?since=${workspace.version}`);
      expect(res.body.changed).toBe(false);
    });

    it("returns changed=true when behind", async () => {
      const res = await request(app).get("/api/changes?since=0");
      expect(res.body.changed).toBe(true);
      expect(res.body.target).toBe("Test Target");
    });
  });

  describe("GET /api/state", () => {
    it("returns full state snapshot", async () => {
      const res = await request(app).get("/api/state");
      expect(res.status).toBe(200);
      expect(res.body.target).toBe("Test Target");
      expect(res.body.agents).toBeInstanceOf(Array);
    });
  });

  describe("POST /api/execute", () => {
    it("returns error for missing tool", async () => {
      const res = await request(app).post("/api/execute").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("tool required");
    });

    it("returns error for unknown tool", async () => {
      const res = await request(app).post("/api/execute").send({ tool: "nope" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Unknown tool");
    });

    it("executes join_workspace via demo tools", async () => {
      const res = await request(app).post("/api/execute").send({
        tool: "join_workspace",
        arguments: { name: "TestBot", client: "terminal", role: "tester" },
        clientId: "test-client",
      });
      expect(res.status).toBe(200);
      expect(res.body.content[0].text).toContain("Joined");
    });
  });

  describe("GET / (dashboard)", () => {
    it("returns HTML", async () => {
      const res = await request(app).get("/");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.text).toContain("Stigmergy");
    });
  });

  describe("GET /api/meeting-kit/state", () => {
    it("returns meeting kit state with expected shape", async () => {
      const res = await request(app).get("/api/meeting-kit/state");
      expect(res.status).toBe(200);
      expect(res.body.status).toBeDefined();
      expect(res.body.sections).toBeInstanceOf(Array);
      expect(res.body.context).toBeDefined();
    });
  });

  // SSE endpoint (/api/events/stream) is tested via the smoke test rather
  // than supertest, since supertest can't cleanly handle never-closing streams.
});
