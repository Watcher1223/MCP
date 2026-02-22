import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Response } from "express";
import type { WorkspaceState } from "../types.js";
import { DocSessionManager } from "../doc-session-manager.js";
import { registerHttpRoutes } from "../http-routes.js";
import { extractContextFromEmail } from "../tools/meeting-prep.js";
import { meetingKit } from "../workspace.js";

// ── extractContextFromEmail unit tests ────────────────────────────────────────

describe("extractContextFromEmail", () => {
  it("extracts company from subject 'Intro call with Sequoia Capital'", () => {
    const result = extractContextFromEmail({
      subject: "Intro call with Sequoia Capital",
      from: "partner@sequoia.com",
      dateHeader: "",
      bodyText: "",
    });
    expect(result.companyOrFirm).toBe("Sequoia Capital");
  });

  it("extracts company from body when subject has no match", () => {
    const result = extractContextFromEmail({
      subject: "Meeting tomorrow",
      from: "someone@acme.com",
      dateHeader: "",
      bodyText: "Looking forward to meeting with Acme Ventures team.",
    });
    expect(result.companyOrFirm).toContain("Acme Ventures");
  });

  it("populates assumptions when company is not found", () => {
    const result = extractContextFromEmail({
      subject: "Let's chat",
      from: "someone@example.com",
      dateHeader: "",
      bodyText: "Hey, want to connect sometime?",
    });
    expect(result.companyOrFirm).toBe("");
    expect(result.assumptions.some(a => a.toLowerCase().includes("company"))).toBe(true);
  });

  it("detects date and time from body text", () => {
    const result = extractContextFromEmail({
      subject: "Meeting",
      from: "partner@vc.com",
      dateHeader: "",
      bodyText: "Let's meet on Mar 15 at 2:00 PM ET.",
    });
    expect(result.date).toContain("Mar 15");
    expect(result.time).toContain("2:00");
    expect(result.timezone).toBe("ET");
  });

  it("extracts Zoom link as locationOrLink", () => {
    const result = extractContextFromEmail({
      subject: "Meeting",
      from: "partner@vc.com",
      dateHeader: "",
      bodyText: "Join us at https://zoom.us/j/123456789 for the call.",
    });
    expect(result.locationOrLink).toContain("zoom.us");
  });

  it("extracts Calendly booking link for YC interview", () => {
    const result = extractContextFromEmail({
      subject: "YC Interview — Book your slot",
      from: "Lisa Wang <lisa@ycombinator.com>",
      dateHeader: "",
      bodyText: "Congratulations! Book your YC interview here: https://calendly.com/yc-interviews/30min",
    });
    expect(result.locationOrLink).toContain("calendly.com");
    expect(result.meetingLink).toContain("calendly.com");
  });

  it("extracts YC application schedule link", () => {
    const result = extractContextFromEmail({
      subject: "YC Interview Invite",
      from: "team@ycombinator.com",
      dateHeader: "",
      bodyText: "Schedule your interview: https://application.ycombinator.com/schedule/abc123",
    });
    expect(result.locationOrLink).toContain("ycombinator.com");
    expect(result.meetingLink).toContain("ycombinator.com");
  });

  it("detects 45-minute timebox", () => {
    const result = extractContextFromEmail({
      subject: "Meeting",
      from: "partner@vc.com",
      dateHeader: "",
      bodyText: "We'll have 45 minutes to chat.",
    });
    expect(result.timeboxMinutes).toBe(45);
  });

  it("detects seed fundraising goal", () => {
    const result = extractContextFromEmail({
      subject: "Seed round intro",
      from: "partner@vc.com",
      dateHeader: "",
      bodyText: "Excited to discuss your seed raise.",
    });
    expect(result.meetingGoal).toBe("Fundraising intro");
  });

  it("detects diligence goal", () => {
    const result = extractContextFromEmail({
      subject: "Diligence call",
      from: "partner@vc.com",
      dateHeader: "",
      bodyText: "We'd like to conduct diligence on your company.",
    });
    expect(result.meetingGoal).toBe("Diligence meeting");
  });

  it("defaults to 30-minute timebox when none is specified", () => {
    const result = extractContextFromEmail({
      subject: "Quick sync",
      from: "someone@vc.com",
      dateHeader: "",
      bodyText: "Just a quick chat.",
    });
    expect(result.timeboxMinutes).toBe(30);
  });

  it("adds missing date/time to assumptions", () => {
    const result = extractContextFromEmail({
      subject: "Meeting",
      from: "partner@vc.com",
      dateHeader: "",
      bodyText: "No date or time mentioned here.",
    });
    expect(result.assumptions.some(a => a.toLowerCase().includes("date"))).toBe(true);
    expect(result.assumptions.some(a => a.toLowerCase().includes("time"))).toBe(true);
  });
});

// ── Meeting Kit API integration tests ─────────────────────────────────────────

function createTestApp() {
  const workspace: WorkspaceState = {
    target: null,
    agents: new Map(),
    locks: new Map(),
    intents: [],
    handoffs: new Map(),
    workQueue: [],
    version: 0,
  };
  const clientAgents = new Map<string, string>();
  const docManager = new DocSessionManager();
  const sseClients = new Set<Response>();
  let ver = 0;
  const bumpVersion = () => { ver++; workspace.version = ver; };

  const app = express();
  app.use(express.json());
  registerHttpRoutes({ app, workspace, clientAgents, docManager, sseClients, bumpVersion, API_PORT: 3201 });

  return { app };
}

describe("Meeting Kit REST API (via buildDemoTools)", () => {
  const { app } = createTestApp();

  beforeEach(() => {
    // Reset shared meetingKit state before each test
    meetingKit.status = "idle";
    meetingKit.statusMessage = "Ready";
    meetingKit.sections = [];
    meetingKit.agentFeed = [];
    meetingKit.draftReply = "";
    meetingKit.context.companyOrFirm = "";
    meetingKit.context.version = 0;
  });

  it("GET /api/meeting-kit/state returns idle state initially", async () => {
    const res = await request(app).get("/api/meeting-kit/state");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("idle");
    expect(res.body.sections).toBeInstanceOf(Array);
    expect(res.body.context).toBeDefined();
  });

  it("update_meeting_context sets company and increments version", async () => {
    const res = await request(app).post("/api/execute").send({
      tool: "update_meeting_context",
      arguments: { companyOrFirm: "Acme VC", meetingGoal: "Seed funding" },
    });
    expect(res.status).toBe(200);

    const state = await request(app).get("/api/meeting-kit/state");
    expect(state.body.context.companyOrFirm).toBe("Acme VC");
    expect(state.body.context.meetingGoal).toBe("Seed funding");
    expect(state.body.context.version).toBe(1);
  });

  it("update_meeting_context parses people_csv", async () => {
    await request(app).post("/api/execute").send({
      tool: "update_meeting_context",
      arguments: { people_csv: "Alice, Bob, Carol" },
    });
    const state = await request(app).get("/api/meeting-kit/state");
    expect(state.body.context.people).toEqual(["Alice", "Bob", "Carol"]);
  });

  it("generate_meeting_kit errors when companyOrFirm is empty", async () => {
    const res = await request(app).post("/api/execute").send({
      tool: "generate_meeting_kit",
      arguments: {},
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body.content[0].text);
    expect(parsed.error).toBeDefined();
  });

  it("generate_meeting_kit sets status to ready after context is set", async () => {
    await request(app).post("/api/execute").send({
      tool: "update_meeting_context",
      arguments: { companyOrFirm: "Demo Ventures" },
    });
    const res = await request(app).post("/api/execute").send({
      tool: "generate_meeting_kit",
      arguments: {},
    });
    expect(res.status).toBe(200);
    expect(res.body.content[0].text).toContain("Demo Ventures");

    const state = await request(app).get("/api/meeting-kit/state");
    expect(state.body.status).toBe("ready");
  });

  it("get_meeting_kit returns current state via /api/execute", async () => {
    meetingKit.context.companyOrFirm = "TestCo";
    const res = await request(app).post("/api/execute").send({
      tool: "get_meeting_kit",
      arguments: {},
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body.content[0].text);
    expect(parsed.context.companyOrFirm).toBe("TestCo");
  });

  it("extract_meeting_context sets emailId and status to preparing", async () => {
    const res = await request(app).post("/api/execute").send({
      tool: "extract_meeting_context",
      arguments: { email_id: "msg123", companyOrFirm: "Bolt Ventures" },
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.companyOrFirm).toBe("Bolt Ventures");

    const state = await request(app).get("/api/meeting-kit/state");
    expect(state.body.meeting.emailId).toBe("msg123");
    expect(state.body.status).toBe("preparing");
  });
});

// ── Phase 5: gmail_create_draft ────────────────────────────────────────────────

describe("gmail_create_draft (demo mode via buildDemoTools)", () => {
  const { app } = createTestApp();

  beforeEach(() => {
    meetingKit.status = "ready";
    meetingKit.draftId = undefined;
    meetingKit.draftWebLink = undefined;
    meetingKit.draftReply = "Hi there,\n\nLooking forward to the meeting.\n\nBest,";
    meetingKit.meeting.emailFrom = "partner@sequoia.com";
    meetingKit.meeting.emailSubject = "Intro call next week";
    meetingKit.meeting.company = "Sequoia Capital";
    meetingKit.context.companyOrFirm = "Sequoia Capital";
  });

  it("returns error when Gmail OAuth is not connected", async () => {
    const res = await request(app).post("/api/execute").send({
      tool: "gmail_create_draft",
      arguments: {},
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body.content[0].text);
    expect(parsed.error).toBeDefined();
    expect(parsed.error).toContain("Gmail OAuth not connected");
  });

  it("includes to and subject in the error response", async () => {
    const res = await request(app).post("/api/execute").send({
      tool: "gmail_create_draft",
      arguments: { to: "other@vc.com", subject: "Custom subject" },
    });
    const parsed = JSON.parse(res.body.content[0].text);
    expect(parsed.error).toContain("Gmail OAuth not connected");
    expect(parsed.to).toBe("other@vc.com");
    expect(parsed.subject).toBe("Custom subject");
  });
});

// ── Phase 6: rerun_meeting_kit ─────────────────────────────────────────────────

describe("rerun_meeting_kit (demo mode via buildDemoTools)", () => {
  const { app } = createTestApp();

  beforeEach(() => {
    meetingKit.status = "ready";
    meetingKit.context.companyOrFirm = "Demo Ventures";
    // Seed two sections
    meetingKit.sections = [
      { id: "news", title: "Recent News", icon: "🗞", agentName: "News", status: "done", content: "Old news content", bullets: [], updatedAt: 0 },
      { id: "thesis", title: "Thesis", icon: "🧩", agentName: "Thesis", status: "error", content: "Error: timeout", bullets: [], updatedAt: 0 },
    ];
  });

  it("returns error when no section_ids provided", async () => {
    const res = await request(app).post("/api/execute").send({
      tool: "rerun_meeting_kit",
      arguments: { section_ids: [] },
    });
    expect(res.status).toBe(200);
    expect(res.body.content[0].text).toContain("Provide at least one");
  });

  it("re-runs a section and updates its content + status", async () => {
    const res = await request(app).post("/api/execute").send({
      tool: "rerun_meeting_kit",
      arguments: { section_ids: ["news"] },
    });
    expect(res.status).toBe(200);
    expect(res.body.content[0].text).toContain("news");

    const state = await request(app).get("/api/meeting-kit/state");
    const newsSection = state.body.sections.find((s: any) => s.id === "news");
    expect(newsSection).toBeDefined();
    expect(newsSection.status).toBe("done");
    expect(newsSection.content).toContain("Re-ran section: news");
    expect(newsSection.cached).toBe(false);
  });

  it("re-runs multiple sections in one call", async () => {
    const res = await request(app).post("/api/execute").send({
      tool: "rerun_meeting_kit",
      arguments: { section_ids: ["news", "thesis"] },
    });
    expect(res.status).toBe(200);
    expect(res.body.content[0].text).toContain("2 section");

    const state = await request(app).get("/api/meeting-kit/state");
    const thesis = state.body.sections.find((s: any) => s.id === "thesis");
    expect(thesis.status).toBe("done");
    expect(thesis.cached).toBe(false);
  });

  it("GET /api/meeting-kit/state exposes draftId and draftWebLink fields", async () => {
    meetingKit.draftId = "test-draft-abc";
    meetingKit.draftWebLink = "https://mail.google.com/mail/#drafts/test-draft-abc";
    const state = await request(app).get("/api/meeting-kit/state");
    expect(state.body.draftId).toBe("test-draft-abc");
    expect(state.body.draftWebLink).toContain("test-draft-abc");
  });
});
