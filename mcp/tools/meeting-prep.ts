import { MCPServer } from "mcp-use/server";
import { z } from "zod";
import { generateId, now, Logger } from "../../shared/utils.js";
import { meetingKit, workspace, commandCenter } from "../workspace.js";
import type { MeetingContext, MeetingKitSection, MeetingTimeboxMinutes } from "../types.js";
import type { SearchResult } from "./search.js";
import { searchWeb, isSearchAvailable } from "./search.js";
import { gmail } from "@googleapis/gmail";
import { OAuth2Client } from "google-auth-library";
import { getTokenForContext, extractTextFromGmailPayload } from "./google-integration.js";

const log = new Logger("MeetingPrep");

function normalizePeople(input: string): string[] {
  return input
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function detectMeetingLink(text: string): string | null {
  // Video calls: Zoom, Meet, Teams
  const videoRe = /https?:\/\/(?:[^\s)\]"]*(?:zoom\.us\/j|meet\.google\.com|teams\.microsoft\.com\/l\/meetup-join)[^\s)\]"]*)/i;
  const videoMatch = text.match(videoRe);
  if (videoMatch) return videoMatch[0];

  // Scheduling/booking: Calendly, YC, Cal.com, etc.
  const bookingRe = /https?:\/\/(?:[^\s)\]"]*(?:calendly\.com|cal\.com|application\.ycombinator\.com\/schedules?|book\.(?:stripe|cal)|acuityscheduling\.com|doodle\.com)[^\s)\]"]*)/i;
  const bookingMatch = text.match(bookingRe);
  if (bookingMatch) return bookingMatch[0];

  // Generic scheduling link patterns (e.g. "book your interview", "schedule a call")
  const genericRe = /https?:\/\/[^\s)\]"]*(?:book|schedule|booking|appointment)[^\s)\]"]*/i;
  const genericMatch = text.match(genericRe);
  if (genericMatch) return genericMatch[0];

  return null;
}

function detectTimezone(text: string): string {
  const m = text.match(/\b(ET|EST|EDT|PT|PST|PDT|CT|CST|CDT|MT|MST|MDT|UTC|GMT)\b/i);
  return m ? m[1].toUpperCase() : "";
}

function detectTimebox(text: string): MeetingTimeboxMinutes {
  const m = text.match(/\b(30|45|60)\s*(min|mins|minutes)\b/i);
  if (!m) return 30;
  const n = parseInt(m[1], 10);
  return (n === 45 ? 45 : n === 60 ? 60 : 30);
}

/**
 * Best-effort extraction of meeting fields from an email.
 * This is intentionally heuristic (hackathon scope) and always returns editable fields + assumptions.
 */
export function extractContextFromEmail(params: {
  subject: string;
  from: string;
  dateHeader: string;
  bodyText: string;
}): Omit<MeetingContext, "version" | "sourceEmail"> {
  const { subject, from, dateHeader, bodyText } = params;
  const assumptions: string[] = [];
  const joined = [subject, from, dateHeader, bodyText].filter(Boolean).join("\n");

  // Company/firm: try subject patterns like "Meeting with Acme Ventures"
  let company = "";
  const subjMatch = subject.match(/(?:meeting|intro|call)\s+(?:with|w\/)\s+(.+?)(?:\s+-|\s+\(|$)/i);
  if (subjMatch) company = subjMatch[1].trim();
  if (!company) {
    const firmMatch = joined.match(/\b([A-Z][A-Za-z0-9&.\- ]{2,40}\s(?:Ventures|Capital|Partners|VC|Holdings|Investments))\b/);
    if (firmMatch) company = firmMatch[1].trim();
  }
  if (!company) assumptions.push("Company/Firm not found — please fill it in.");

  // People: parse from header name-ish + simple "with X and Y"
  const people: string[] = [];
  const fromName = from.replace(/<.*?>/g, "").replace(/".*?"/g, "").trim();
  if (fromName && !fromName.includes("@")) people.push(fromName);
  const withMatch = bodyText.match(/\bwith\s+([A-Z][A-Za-z.\- ]{2,40})(?:\s+and\s+([A-Z][A-Za-z.\- ]{2,40}))?/);
  if (withMatch?.[1]) people.push(withMatch[1].trim());
  if (withMatch?.[2]) people.push(withMatch[2].trim());
  const uniqPeople = Array.from(new Set(people)).slice(0, 8);
  if (uniqPeople.length === 0) assumptions.push("Attendees missing — add names if you know them.");

  // Goal
  let goal = "";
  if (joined.match(/\b(seed|series\s*a|series\s*b|fundraise|fundraising|raise)\b/i)) goal = "Fundraising intro";
  else if (joined.match(/\bpartner(shi)?p\b/i)) goal = "Partnership discussion";
  else if (joined.match(/\bdiligence\b/i)) goal = "Diligence meeting";
  else goal = "Investor meeting";

  // Link/location
  const link = detectMeetingLink(joined) || "";
  const locationOrLink = link || (joined.match(/\b(at|location):\s*(.+)\b/i)?.[2]?.trim() || "");
  if (!locationOrLink) assumptions.push("Location / Zoom link missing — add it if available.");

  // Date/time: keep simple (free-form). Prefer explicit patterns like "Mar 3" and "10am"
  let date = "";
  const dateMatch = joined.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\.?\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?\b/i);
  if (dateMatch) date = dateMatch[0].trim();
  let time = "";
  const timeMatch = joined.match(/\b(\d{1,2}:\d{2}\s*(AM|PM)|\d{1,2}\s*(AM|PM))\b/i);
  if (timeMatch) time = timeMatch[0].trim();
  if (!date) assumptions.push("Meeting date missing/unclear — please confirm.");
  if (!time) assumptions.push("Meeting time missing/unclear — please confirm.");

  const timezone = detectTimezone(joined);
  if (!timezone) assumptions.push("Timezone missing — set ET/PT/etc.");

  const timeboxMinutes = detectTimebox(joined);

  return {
    companyOrFirm: company,
    people: uniqPeople,
    meetingGoal: goal,
    date,
    time,
    timezone,
    locationOrLink,
    timeboxMinutes,
    yourProductOneLiner: "",
    stage: "",
    raiseTarget: "",
    meetingLink: link || undefined,
    assumptions,
  };
}

function applyContextToMeetingKit(ctx: MeetingContext): void {
  meetingKit.context = ctx;
  meetingKit.meeting.company = ctx.companyOrFirm;
  meetingKit.meeting.people = ctx.people;
  meetingKit.meeting.goal = ctx.meetingGoal;
  meetingKit.meeting.date = ctx.date || "TBD";
  meetingKit.meeting.time = ctx.time || "TBD";
  meetingKit.meeting.location = ctx.locationOrLink || "TBD";
  meetingKit.lastUpdated = now();
}

function buildDefaultMeetingContext(): MeetingContext {
  return {
    companyOrFirm: "",
    people: [],
    meetingGoal: "",
    date: "",
    time: "",
    timezone: "",
    locationOrLink: "",
    timeboxMinutes: 30,
    yourProductOneLiner: "",
    stage: "",
    raiseTarget: "",
    meetingLink: undefined,
    sourceEmail: undefined,
    assumptions: [],
    version: 0,
  };
}

type AgentSpec = {
  id: string;
  name: string;
  icon: string;
  client: "chatgpt" | "claude" | "cursor";
  role: "planner" | "backend" | "frontend" | "any";
};

function ensureSection(id: string, title: string, icon: string, agentName: string): MeetingKitSection {
  const existing = meetingKit.sections.find(s => s.id === id);
  if (existing) return existing;
  const sec: MeetingKitSection = {
    id,
    title,
    icon,
    agentName,
    status: "pending",
    content: "",
    bullets: [],
    updatedAt: now(),
  };
  meetingKit.sections.push(sec);
  return sec;
}

function postFeed(agent: AgentSpec, message: string, bumpVersion: () => void): void {
  meetingKit.agentFeed.push({ agentName: agent.name, icon: agent.icon, message, timestamp: now() });
  workspace.intents.push({
    id: generateId(),
    agentId: agent.id,
    agentName: agent.name,
    client: agent.client,
    action: "working",
    description: `[run:${meetingKit.runId}] ${message}`,
    timestamp: now(),
  });
  meetingKit.lastUpdated = now();
  bumpVersion();
}

function markAgentStatus(agentId: string, status: "idle" | "working", task: string | undefined, bumpVersion: () => void): void {
  const a = workspace.agents.get(agentId);
  if (!a) return;
  a.status = status === "working" ? "working" : "idle";
  a.currentTask = task;
  a.lastSeen = now();
  bumpVersion();
}

async function runAgentSection(params: {
  agent: AgentSpec;
  sectionId: string;
  sectionTitle: string;
  sectionIcon: string;
  context: MeetingContext;
  bumpVersion: () => void;
  work: () => Promise<{ content: string; bullets?: string[]; sources?: SearchResult[] }>;
}): Promise<void> {
  const { agent, sectionId, sectionTitle, sectionIcon, bumpVersion, work } = params;

  const sec = ensureSection(sectionId, sectionTitle, sectionIcon, agent.name);
  sec.status = "working";
  sec.updatedAt = now();
  bumpVersion();

  postFeed(agent, `Working on ${sectionTitle}...`, bumpVersion);
  markAgentStatus(agent.id, "working", sectionTitle, bumpVersion);

  try {
    const result = await work();
    sec.content = result.content;
    if (result.bullets) sec.bullets = result.bullets;
    sec.sources = result.sources ?? [];
    sec.status = "done";
  } catch (e: any) {
    sec.content = `Error: ${e?.message ?? "unknown"}`;
    sec.sources = [];
    sec.status = "error";
    log.error(`runAgentSection failed for ${sectionTitle}: ${e?.message}`);
  }
  sec.updatedAt = now();

  workspace.intents.push({
    id: generateId(),
    agentId: agent.id,
    agentName: agent.name,
    client: agent.client,
    action: "completed",
    description: `[run:${meetingKit.runId}] Completed ${sectionTitle}`,
    timestamp: now(),
  });
  markAgentStatus(agent.id, "idle", undefined, bumpVersion);
  meetingKit.lastUpdated = now();
  bumpVersion();
}

/** Register Meeting Prep tools */
export function registerMeetingPrepTools(
  server: MCPServer,
  bumpVersion: () => void,
): void {

  // ── extract_meeting_context: Build editable context from a Gmail email ──
  server.tool({
    name: "extract_meeting_context",
    description: "Extract investor meeting context from a selected Gmail email into editable fields (company/people/goal/date/time/link/timebox/etc). Use this after the user selects an investor meeting email.",
    schema: z.object({
      email_id: z.string().min(1).describe("Gmail message id for the investor meeting email"),
      your_product: z.string().optional().describe("Optional 1-line product description to prefill"),
      stage: z.string().optional().describe("Optional stage (seed/Series A/etc.)"),
      raise_target: z.string().optional().describe("Optional raise target (e.g. '$3M')"),
      timebox_minutes: z.union([z.literal(30), z.literal(45), z.literal(60)]).optional().describe("Optional timebox override"),
    }),
  }, async (args: any, ctx: any) => {
    const token = getTokenForContext(ctx);
    if (!token) {
      return { content: [{ type: "text" as const, text: "Not authenticated to Gmail. Use google_login / Connect Google first." }], isError: true };
    }

    const auth = new OAuth2Client();
    auth.setCredentials({ access_token: token.accessToken });
    const gmailClient = gmail({ version: "v1", auth });

    const detail = await gmailClient.users.messages.get({
      userId: "me",
      id: args.email_id,
      format: "full",
    });

    const headers = detail.data.payload?.headers || [];
    const subject = headers.find(h => h.name === "Subject")?.value || "(no subject)";
    const from = headers.find(h => h.name === "From")?.value || "unknown";
    const dateHeader = headers.find(h => h.name === "Date")?.value || "";
    const snippet = detail.data.snippet || "";
    const bodyText = extractTextFromGmailPayload(detail.data.payload);

    const base = extractContextFromEmail({ subject, from, dateHeader, bodyText });
    const next: MeetingContext = {
      ...buildDefaultMeetingContext(),
      ...base,
      yourProductOneLiner: args.your_product || "",
      stage: args.stage || "",
      raiseTarget: args.raise_target || "",
      timeboxMinutes: (args.timebox_minutes || base.timeboxMinutes) as MeetingTimeboxMinutes,
      sourceEmail: { id: args.email_id, subject, from, date: dateHeader, snippet },
      version: (meetingKit.context?.version || 0) + 1,
    };

    meetingKit.status = meetingKit.status === "idle" ? "preparing" : meetingKit.status;
    meetingKit.statusMessage = "Meeting context extracted. Review and edit fields.";
    meetingKit.meeting.emailSubject = subject;
    meetingKit.meeting.emailFrom = from;
    meetingKit.meeting.emailId = args.email_id;
    applyContextToMeetingKit(next);

    // Also enrich Command Center email entry if present
    const idx = commandCenter.data.emails.findIndex(e => e.id === args.email_id);
    if (idx >= 0) {
      commandCenter.data.emails[idx] = { ...commandCenter.data.emails[idx], body: bodyText };
      commandCenter.lastUpdated = now();
    }

    bumpVersion();
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          ok: true,
          email_id: args.email_id,
          companyOrFirm: next.companyOrFirm,
          meetingLink: next.meetingLink,
          locationOrLink: next.locationOrLink,
          assumptions: next.assumptions,
          message: "Meeting context extracted. Open the Meeting Kit widget to edit fields and generate the kit.",
        }, null, 2),
      }],
    };
  });

  // ── update_meeting_context: Patch editable fields from the UI ──
  server.tool({
    name: "update_meeting_context",
    description: "Update meeting context fields (editable). Call this when the user edits company/goal/timebox/pitch/etc in the Meeting Kit widget.",
    schema: z.object({
      companyOrFirm: z.string().optional(),
      people_csv: z.string().optional().describe("Comma-separated people list"),
      meetingGoal: z.string().optional(),
      date: z.string().optional(),
      time: z.string().optional(),
      timezone: z.string().optional(),
      locationOrLink: z.string().optional(),
      timeboxMinutes: z.union([z.literal(30), z.literal(45), z.literal(60)]).optional(),
      yourProductOneLiner: z.string().optional(),
      stage: z.string().optional(),
      raiseTarget: z.string().optional(),
    }),
  }, async (args: any) => {
    const current = meetingKit.context || buildDefaultMeetingContext();
    const updated: MeetingContext = {
      ...current,
      companyOrFirm: args.companyOrFirm ?? current.companyOrFirm,
      people: args.people_csv != null ? normalizePeople(args.people_csv) : current.people,
      meetingGoal: args.meetingGoal ?? current.meetingGoal,
      date: args.date ?? current.date,
      time: args.time ?? current.time,
      timezone: args.timezone ?? current.timezone,
      locationOrLink: args.locationOrLink ?? current.locationOrLink,
      timeboxMinutes: (args.timeboxMinutes ?? current.timeboxMinutes) as MeetingTimeboxMinutes,
      yourProductOneLiner: args.yourProductOneLiner ?? current.yourProductOneLiner,
      stage: args.stage ?? current.stage,
      raiseTarget: args.raiseTarget ?? current.raiseTarget,
      version: current.version + 1,
    };

    // Clear assumptions if user is filling fields
    updated.assumptions = updated.assumptions.filter(a => a.toLowerCase().includes("missing"));

    applyContextToMeetingKit(updated);
    meetingKit.statusMessage = "Meeting context updated.";
    bumpVersion();
    return { content: [{ type: "text" as const, text: "Meeting context updated." }] };
  });

  // ── generate_meeting_kit: Parallel agent run using current meetingKit.context ──
  server.tool({
    name: "generate_meeting_kit",
    description: "Generate the full Meeting Kit using the current meeting context. Runs multiple specialist agents in parallel and streams updates into the Meeting Kit widget.",
    schema: z.object({}),
  }, async () => {
    const ctx = meetingKit.context;
    if (!ctx || !ctx.companyOrFirm) {
      return {
        content: [{ type: "text" as const, text: "Missing meeting context. First select an email and run extract_meeting_context (or fill in Company / Firm in the Meeting Kit)." }],
        isError: true,
      };
    }

    const runId = generateId().slice(0, 8);
    meetingKit.runId = runId;
    meetingKit.contextVersion = ctx.version || 0;
    meetingKit.status = "preparing";
    meetingKit.statusMessage = "Spawning agents...";
    meetingKit.sections = [];
    meetingKit.agentFeed = [];
    meetingKit.draftReply = "";
    meetingKit.draftId = undefined;
    meetingKit.draftWebLink = undefined;
    meetingKit.lastUpdated = now();

    // Mirror context into meeting header for widget
    applyContextToMeetingKit(ctx);

    const agents: AgentSpec[] = [
      { id: `mk-coord-${runId}`, name: "🧠 Coordinator", icon: "🧠", client: "chatgpt", role: "planner" },
      { id: `mk-news-${runId}`, name: "🗞 News Agent", icon: "🗞", client: "claude", role: "backend" },
      { id: `mk-thesis-${runId}`, name: "🧩 Thesis Agent", icon: "🧩", client: "claude", role: "backend" },
      { id: `mk-comp-${runId}`, name: "🥊 Competitive Agent", icon: "🥊", client: "cursor", role: "frontend" },
      { id: `mk-narr-${runId}`, name: "📝 Narrative Agent", icon: "📝", client: "chatgpt", role: "any" },
      { id: `mk-agenda-${runId}`, name: "📋 Agenda Agent", icon: "📋", client: "chatgpt", role: "any" },
      { id: `mk-email-${runId}`, name: "✉️ Email Draft Agent", icon: "✉️", client: "chatgpt", role: "any" },
    ];

    // Create/overwrite agent entries in workspace for Mission Control telemetry
    const ts = now();
    for (const a of agents) {
      workspace.agents.set(a.id, {
        id: a.id,
        name: a.name,
        client: a.client,
        role: a.role,
        status: "working",
        currentTask: "Starting...",
        joinedAt: ts,
        lastSeen: ts,
        autonomous: true,
      });
    }
    workspace.target = `Meeting Kit: ${ctx.companyOrFirm}`;
    workspace.intents.push({
      id: generateId(),
      agentId: agents[0].id,
      agentName: agents[0].name,
      client: agents[0].client,
      action: "target_set",
      description: `[run:${runId}] Generating Meeting Kit for ${ctx.companyOrFirm}`,
      timestamp: ts,
    });
    bumpVersion();

    postFeed(agents[0], `Extracted context for ${ctx.companyOrFirm}. Launching agents in parallel...`, bumpVersion);

    const company = ctx.companyOrFirm;
    const product = ctx.yourProductOneLiner || "our product";
    const goal = ctx.meetingGoal || "investor meeting";
    const timebox = ctx.timeboxMinutes || 30;

    // Seed sections (so UI shows placeholders immediately)
    ensureSection("snapshot", "Company Snapshot", "🏢", agents[0].name);
    ensureSection("news", "Recent News", "🗞", agents[1].name);
    ensureSection("thesis", "Investor Thesis & Fit", "🧩", agents[2].name);
    ensureSection("competitors", "Competitive Landscape", "🥊", agents[3].name);
    ensureSection("talking_points", "Talking Points", "🎯", agents[4].name);
    ensureSection("agenda", `${timebox}-Minute Agenda`, "📋", agents[5].name);
    ensureSection("questions", "Questions to Ask", "❓", agents[5].name);
    ensureSection("risks", "Risks / Red Flags", "⚠️", agents[0].name);
    ensureSection("reply", "Draft Reply Email", "✉️", agents[6].name);
    bumpVersion();

    // Push research work items for Claude (or any backend agent) to pick up via poll_work.
    // These supplement the server-side Serper results — a connected Claude instance will
    // overwrite these sections with real LLM research by calling update_meeting_section.
    workspace.workQueue = workspace.workQueue.filter(w => w.context?.kit_target !== "meeting-kit");
    [
      {
        id: generateId(),
        description: `Research recent news for ${company}: funding rounds, notable investments, product launches, leadership changes in the last 12 months. Then call update_meeting_section with section_id "news" and your findings.`,
        forRole: "backend" as const,
        createdBy: agents[0].name,
        createdAt: now(),
        status: "pending" as const,
        context: { section: "news", company, runId, kit_target: "meeting-kit" },
      },
      {
        id: generateId(),
        description: `Research ${company}'s investment thesis: typical stage and check size, sector focus areas, portfolio themes, and why they might care about "${product}". Then call update_meeting_section with section_id "thesis" and your findings.`,
        forRole: "backend" as const,
        createdBy: agents[0].name,
        createdAt: now(),
        status: "pending" as const,
        context: { section: "thesis", company, product, runId, kit_target: "meeting-kit" },
      },
      {
        id: generateId(),
        description: `Research 5-8 competitors and adjacent solutions to "${product}". Include differentiation wedge and positioning angle. Then call update_meeting_section with section_id "competitors" and your findings.`,
        forRole: "backend" as const,
        createdBy: agents[0].name,
        createdAt: now(),
        status: "pending" as const,
        context: { section: "competitors", company, product, runId, kit_target: "meeting-kit" },
      },
    ].forEach(item => workspace.workQueue.push(item));
    bumpVersion();

    // Parallel execution
    const tasks = [
      runAgentSection({
        agent: agents[0],
        sectionId: "snapshot",
        sectionTitle: "Company Snapshot",
        sectionIcon: "🏢",
        context: ctx,
        bumpVersion,
        work: async () => ({
          content: `${company} — prep for: ${goal}.`,
          bullets: [
            `Company/Firm: ${company}`,
            `When: ${ctx.date || "TBD"} ${ctx.time || ""} ${ctx.timezone || ""}`.trim(),
            `Where: ${ctx.locationOrLink || "TBD"}`,
            `Attendees: ${(ctx.people && ctx.people.length) ? ctx.people.join(", ") : "TBD"}`,
            `Your pitch: ${ctx.yourProductOneLiner || "TBD"}`,
          ],
        }),
      }),
      runAgentSection({
        agent: agents[1],
        sectionId: "news",
        sectionTitle: "Recent News",
        sectionIcon: "🗞",
        context: ctx,
        bumpVersion,
        work: async () => {
          if (isSearchAvailable()) {
            const results = await searchWeb(
              `"${company}" funding OR investment OR launch news ${new Date().getFullYear()}`,
              5,
            );
            if (results.length > 0) {
              return {
                content: `Found ${results.length} recent item${results.length !== 1 ? "s" : ""} about ${company}.`,
                bullets: results.map(r => r.title),
                sources: results,
              };
            }
          }
          return {
            content: `No live search results available for ${company}. Research these areas manually:`,
            bullets: [
              "[Research needed] Latest funding / fund announcements",
              "[Research needed] Recent notable investments or acquisitions",
              "[Research needed] Leadership / partner changes",
              "[Research needed] Public thesis posts / interviews",
              "[Research needed] Any controversies or headwinds",
            ],
          };
        },
      }),
      runAgentSection({
        agent: agents[2],
        sectionId: "thesis",
        sectionTitle: "Investor Thesis & Fit",
        sectionIcon: "🧩",
        context: ctx,
        bumpVersion,
        work: async () => {
          if (isSearchAvailable()) {
            const results = await searchWeb(
              `"${company}" investment thesis OR portfolio OR focus areas`,
              5,
            );
            if (results.length > 0) {
              return {
                content: `Thesis intelligence for ${company} from ${results.length} source${results.length !== 1 ? "s" : ""}.`,
                bullets: results.map(r => r.snippet || r.title).filter(Boolean),
                sources: results,
              };
            }
          }
          return {
            content: `No live search results for ${company} thesis. Research these areas:`,
            bullets: [
              "[Research needed] What they typically invest in (stage, check size, sectors)",
              `[Research needed] Fit hypothesis: how ${product} aligns with their focus`,
              "[Research needed] Questions they'll ask: traction, GTM, market size, team",
              "[Research needed] Decision process: who decides + typical next steps",
            ],
          };
        },
      }),
      runAgentSection({
        agent: agents[3],
        sectionId: "competitors",
        sectionTitle: "Competitive Landscape",
        sectionIcon: "🥊",
        context: ctx,
        bumpVersion,
        work: async () => {
          if (isSearchAvailable()) {
            const results = await searchWeb(
              `${product} competitors OR alternatives OR "vs" site:crunchbase.com OR site:producthunt.com`,
              5,
            );
            if (results.length > 0) {
              return {
                content: `Competitive map for ${product} — ${results.length} source${results.length !== 1 ? "s" : ""} found.`,
                bullets: results.map(r => r.title || r.snippet).filter(Boolean),
                sources: results,
              };
            }
          }
          return {
            content: `No live search results for ${product} competitors. Research these areas:`,
            bullets: [
              "[Research needed] Key competitor #1 — why users choose them",
              "[Research needed] Key competitor #2 — main differentiator",
              "[Research needed] Key competitor #3 — pricing wedge",
              "[Research needed] Adjacent solutions (build vs buy)",
              "[Research needed] Your wedge: 1–2 sharp differentiation bullets",
            ],
          };
        },
      }),
      runAgentSection({
        agent: agents[4],
        sectionId: "talking_points",
        sectionTitle: "Talking Points",
        sectionIcon: "🎯",
        context: ctx,
        bumpVersion,
        work: async () => ({
          content: `Pitch framework — customize for ${company}:`,
          bullets: [
            "30s: Problem → Insight → Solution",
            "2m: Add traction + why now + wedge",
            "5m: Market + GTM + business model + ask",
            "Objections: why you win vs incumbents",
            "Objections: why now / why you / defensibility",
          ],
        }),
      }),
      runAgentSection({
        agent: agents[5],
        sectionId: "agenda",
        sectionTitle: `${timebox}-Minute Agenda`,
        sectionIcon: "📋",
        context: ctx,
        bumpVersion,
        work: async () => ({
          content: `Suggested ${timebox}-minute agenda — adjust to your meeting:`,
          bullets: timebox === 30 ? [
            "0–3: Intros + goal alignment",
            "3–10: 2–5 min pitch + top traction proof",
            "10–18: Product walkthrough + wedge",
            "18–25: Q&A + diligence topics",
            "25–30: Next steps + timeline",
          ] : timebox === 45 ? [
            "0–5: Intros + goal",
            "5–15: Pitch + traction",
            "15–25: Demo / product deep dive",
            "25–35: Market + competition + GTM",
            "35–42: Q&A",
            "42–45: Next steps",
          ] : [
            "0–5: Intros + goal",
            "5–20: Pitch + demo",
            "20–35: Market + GTM + competition",
            "35–50: Q&A / diligence",
            "50–60: Next steps",
          ],
        }),
      }).then(async () => {
        // Questions piggyback from Agenda agent
        await runAgentSection({
          agent: agents[5],
          sectionId: "questions",
          sectionTitle: "Questions to Ask",
          sectionIcon: "❓",
          context: ctx,
          bumpVersion,
          work: async () => ({
            content: `Suggested questions for ${company} — pick the most relevant:`,
            bullets: [
              "What does a great outcome look like after this call?",
              "What are the top 2–3 risks you’re underwriting here?",
              "Who else needs conviction for the next step?",
              "What’s your typical timeline from intro → decision?",
              "What diligence artifacts matter most (deck, metrics, refs)?",
              "What comparable companies do you reference in this space?",
              "What would make you excited to re-engage in 2 weeks?",
              "If you pass, what would be the most likely reason?",
              "What’s the best next step if there’s mutual interest?",
              "Can you share how you support portfolio post-investment?",
            ],
          }),
        });
      }),
      runAgentSection({
        agent: agents[0],
        sectionId: "risks",
        sectionTitle: "Risks / Red Flags",
        sectionIcon: "⚠️",
        context: ctx,
        bumpVersion,
        work: async () => ({
          content: `Common risks to prepare for — tailor responses to your situation:`,
          bullets: [
            "Unclear wedge → be crisp on differentiation + why now",
            "GTM uncertainty → show ICP, pipeline, and channel focus",
            "Competitive pressure → explain switching costs / moat",
            "Market size skepticism → top-down + bottom-up framing",
            "Execution risk → team strengths + milestones",
          ],
        }),
      }),
      runAgentSection({
        agent: agents[6],
        sectionId: "reply",
        sectionTitle: "Draft Reply Email",
        sectionIcon: "✉️",
        context: ctx,
        bumpVersion,
        work: async () => {
          const hi = (ctx.people && ctx.people.length) ? `Hi ${ctx.people[0]},` : "Hi there,";
          const when = (ctx.date || ctx.time || ctx.timezone) ? `${ctx.date || ""} ${ctx.time || ""} ${ctx.timezone || ""}`.trim() : "the scheduled time";
          const loc = ctx.locationOrLink ? `Location/link: ${ctx.locationOrLink}` : "Could you confirm the Zoom link/location?";
          const body = [
            hi,
            "",
            `Looking forward to our conversation with ${company} on ${when}.`,
            "",
            `I’ll come prepared to discuss ${goal.toLowerCase()} and share a quick overview of ${product}.`,
            "",
            loc,
            "",
            "Best,",
          ].join("\n");
          meetingKit.draftReply = body;
          return { content: body };
        },
      }),
    ];

    await Promise.allSettled(tasks);
    meetingKit.status = "ready";
    meetingKit.statusMessage = `Meeting Kit ready. Run ${runId}.`;
    meetingKit.lastUpdated = now();
    bumpVersion();

    postFeed(agents[0], "All sections complete. Ready for review.", bumpVersion);
    return {
      content: [{
        type: "text" as const,
        text: [
          `Generated Meeting Kit for ${company}.`,
          ``,
          `3 research tasks are now queued for Claude (News, Investor Thesis & Fit, Competitive Landscape).`,
          `If Claude is connected to this MCP server it will pick them up automatically via poll_work.`,
          `If Claude is not connected, the sections already contain Serper/placeholder content — no action needed.`,
          ``,
          `Open the Meeting Kit widget to watch sections fill in live.`,
        ].join("\n"),
      }],
    };
  });

  // ── prepare_meeting: DEPRECATED — kept as no-op to avoid ChatGPT routing to it ──
  // Use extract_meeting_context → update_meeting_context → generate_meeting_kit instead.
  server.tool({
    name: "prepare_meeting",
    description: "DEPRECATED. Do not use. Instead: (1) call extract_meeting_context with an email id, (2) call update_meeting_context to edit fields, (3) call generate_meeting_kit to run all agents. Then show the meeting-kit widget.",
    schema: z.object({
      company: z.string().optional(),
      people: z.array(z.string()).optional(),
      date: z.string().optional(),
      time: z.string().optional(),
      location: z.string().optional(),
      goal: z.string().optional(),
      your_product: z.string().optional(),
      email_subject: z.string().optional(),
      email_from: z.string().optional(),
    }),
  }, async (args: any) => {
    // Redirect to the proper flow: seed context from args then hand off.
    const company = (args.company as string) || "";
    if (company) {
      meetingKit.context = {
        ...meetingKit.context,
        companyOrFirm: company,
        people: args.people || meetingKit.context.people,
        meetingGoal: args.goal || meetingKit.context.meetingGoal || "Investor meeting",
        date: args.date || meetingKit.context.date,
        time: args.time || meetingKit.context.time,
        locationOrLink: args.location || meetingKit.context.locationOrLink,
        yourProductOneLiner: args.your_product || meetingKit.context.yourProductOneLiner,
        version: meetingKit.context.version + 1,
      };
      meetingKit.meeting.emailSubject = args.email_subject || "";
      meetingKit.meeting.emailFrom = args.email_from || "";
      applyContextToMeetingKit(meetingKit.context);
      bumpVersion();
    }
    return {
      content: [{
        type: "text" as const,
        text: `Context pre-filled for ${company || "meeting"}. NEXT: Call generate_meeting_kit to run agents, then call the meeting-kit tool to display the widget.`,
      }],
    };
  });

  // ── get_meeting_kit: Returns full state for widget rendering ──
  server.tool({
    name: "get_meeting_kit",
    description: "Get the full Meeting Kit state for widget rendering. The meeting-kit widget calls this via callTool to display sections, agent feed, and meeting details.",
    schema: z.object({}),
  }, async () => {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(meetingKit),
      }],
    };
  });

  // ── update_section: Update a specific section with real research ──
  server.tool({
    name: "update_meeting_section",
    description: "Update a specific section of the Meeting Kit with new content. Use this when you've researched something and want to fill in real data (e.g., actual news, real competitor list, etc.). Pass agent_name so your activity shows in the Agent feed.",
    schema: z.object({
      section_id: z.string().describe("Section ID: snapshot, news, thesis, competitors, talking_points, agenda, questions, reply"),
      content: z.string().describe("New content text for the section"),
      bullets: z.array(z.string()).optional().describe("New bullet points"),
      agent_name: z.string().optional().describe("Your display name (e.g. 'Claude Code') — shows in Agent Activity feed"),
    }),
  }, async (args: any) => {
    const section = meetingKit.sections.find(s => s.id === args.section_id);
    if (!section) {
      return { content: [{ type: "text" as const, text: `Section ${args.section_id} not found.` }] };
    }
    section.content = args.content;
    if (args.bullets) section.bullets = args.bullets;
    // Always mark done so error/pending states clear when real content arrives (e.g. from Claude)
    section.status = "done";
    section.cached = false;
    section.updatedAt = now();
    meetingKit.lastUpdated = now();
    // Show real agent activity in the feed (not just virtual server-side agents)
    if (args.agent_name) {
      meetingKit.agentFeed.push({
        agentName: args.agent_name,
        icon: "🤖",
        message: `Updated "${section.title}" with research`,
        timestamp: now(),
      });
    }
    bumpVersion();
    log.info(`Updated section: ${section.title}`);
    return { content: [{ type: "text" as const, text: `Updated "${section.title}" with new content.` }] };
  });

  // ── rerun_meeting_kit: Re-run one or more specific sections ──
  server.tool({
    name: "rerun_meeting_kit",
    description: "Re-run one or more specific sections of the Meeting Kit (e.g. after editing context or when a section errored). Use this instead of regenerating the whole kit. Valid section IDs: snapshot, news, thesis, competitors, talking_points, agenda, questions, risks, reply.",
    schema: z.object({
      section_ids: z.array(z.string()).describe("One or more section IDs to re-run."),
    }),
  }, async (args: any) => {
    const ctx = meetingKit.context;
    const sectionIds: string[] = args.section_ids || [];

    if (!ctx?.companyOrFirm) {
      return { content: [{ type: "text" as const, text: "No meeting context set. Call extract_meeting_context first." }] };
    }

    if (sectionIds.length === 0) {
      return { content: [{ type: "text" as const, text: "Provide at least one section_id to re-run." }] };
    }

    const company = ctx.companyOrFirm;
    const product = ctx.yourProductOneLiner || "our product";
    const goal = ctx.meetingGoal || "investor meeting";
    const timebox = ctx.timeboxMinutes || 30;

    // Build a minimal agent spec for each re-run
    const agentFor = (icon: string, name: string, client: AgentSpec["client"], role: AgentSpec["role"]): AgentSpec => ({
      id: `mk-rerun-${generateId().slice(0, 6)}`,
      name,
      icon,
      client,
      role,
    });

    const tasks: Promise<void>[] = [];

    for (const id of sectionIds) {
      switch (id) {
        case "snapshot": {
          const agent = agentFor("🏢", "🧠 Coordinator", "chatgpt", "planner");
          tasks.push(runAgentSection({
            agent, sectionId: "snapshot", sectionTitle: "Company Snapshot", sectionIcon: "🏢",
            context: ctx, bumpVersion,
            work: async () => ({
              content: `${company} — ${goal} on ${ctx.date || "TBD"} at ${ctx.time || "TBD"} ${ctx.timezone || ""}`.trim(),
              bullets: [
                `Company/Firm: ${company}`,
                `When: ${ctx.date || "TBD"} ${ctx.time || ""} ${ctx.timezone || ""}`.trim(),
                `Where: ${ctx.locationOrLink || "TBD"}`,
                `Attendees: ${(ctx.people && ctx.people.length) ? ctx.people.join(", ") : "TBD"}`,
                `Your pitch: ${ctx.yourProductOneLiner || "TBD"}`,
              ],
            }),
          }));
          break;
        }
        case "news": {
          const agent = agentFor("🗞", "🗞 News Agent", "claude", "backend");
          tasks.push(runAgentSection({
            agent, sectionId: "news", sectionTitle: "Recent News", sectionIcon: "🗞",
            context: ctx, bumpVersion,
            work: async () => {
              if (isSearchAvailable()) {
                const results = await searchWeb(`"${company}" funding OR investment OR launch news ${new Date().getFullYear()}`, 5);
                if (results.length > 0) return { content: `Found ${results.length} recent items about ${company}.`, bullets: results.map(r => r.title), sources: results };
              }
              return { content: `Recent news for ${company}.`, bullets: ["Latest funding / fund announcements", "Recent notable investments or acquisitions", "Leadership / partner changes", "Public thesis posts / interviews", "Any controversies or headwinds"] };
            },
          }));
          break;
        }
        case "thesis": {
          const agent = agentFor("🧩", "🧩 Thesis Agent", "claude", "backend");
          tasks.push(runAgentSection({
            agent, sectionId: "thesis", sectionTitle: "Investor Thesis & Fit", sectionIcon: "🧩",
            context: ctx, bumpVersion,
            work: async () => {
              if (isSearchAvailable()) {
                const results = await searchWeb(`"${company}" investment thesis OR portfolio OR focus areas`, 5);
                if (results.length > 0) return { content: `Thesis intelligence for ${company}.`, bullets: results.map(r => r.snippet || r.title).filter(Boolean), sources: results };
              }
              return { content: `Why ${company} might care about ${product}.`, bullets: ["What they typically invest in (stage, check size, sectors)", `Fit hypothesis: how ${product} aligns with their likely focus`, "Questions they'll ask: traction, GTM, market size, team", "Decision process: who decides + typical next steps"] };
            },
          }));
          break;
        }
        case "competitors": {
          const agent = agentFor("🥊", "🥊 Competitive Agent", "cursor", "frontend");
          tasks.push(runAgentSection({
            agent, sectionId: "competitors", sectionTitle: "Competitive Landscape", sectionIcon: "🥊",
            context: ctx, bumpVersion,
            work: async () => {
              if (isSearchAvailable()) {
                const results = await searchWeb(`${product} competitors OR alternatives OR "vs" site:crunchbase.com OR site:producthunt.com`, 5);
                if (results.length > 0) return { content: `Competitive map for ${product}.`, bullets: results.map(r => r.title || r.snippet).filter(Boolean), sources: results };
              }
              return { content: `Competitive map for ${product}.`, bullets: ["Competitor A — why users choose them", "Competitor B — key differentiator", "Competitor C — pricing wedge", "Adjacent solutions (build vs buy)", "Your wedge: 1–2 sharp differentiation bullets"] };
            },
          }));
          break;
        }
        case "talking_points": {
          const agent = agentFor("🎯", "📝 Narrative Agent", "chatgpt", "any");
          tasks.push(runAgentSection({
            agent, sectionId: "talking_points", sectionTitle: "Talking Points", sectionIcon: "🎯",
            context: ctx, bumpVersion,
            work: async () => ({ content: `Pitch narrative versions for ${company}.`, bullets: ["30s: Problem → Insight → Solution", "2m: Add traction + why now + wedge", "5m: Market + GTM + business model + ask", "Objections: why you win vs incumbents", "Objections: why now / why you / defensibility"] }),
          }));
          break;
        }
        case "agenda": {
          const agent = agentFor("📋", "📋 Agenda Agent", "chatgpt", "any");
          const bullets = timebox === 30
            ? ["0–3: Intros + goal alignment", "3–10: 2–5 min pitch + top traction proof", "10–18: Product walkthrough + wedge", "18–25: Q&A + diligence topics", "25–30: Next steps + timeline"]
            : timebox === 45
            ? ["0–5: Intros + goal", "5–15: Pitch + traction", "15–25: Demo / product deep dive", "25–35: Market + competition + GTM", "35–42: Q&A", "42–45: Next steps"]
            : ["0–5: Intros + goal", "5–20: Pitch + demo", "20–35: Market + GTM + competition", "35–50: Q&A / diligence", "50–60: Next steps"];
          tasks.push(runAgentSection({ agent, sectionId: "agenda", sectionTitle: `${timebox}-Minute Agenda`, sectionIcon: "📋", context: ctx, bumpVersion, work: async () => ({ content: `Timeboxed agenda for a ${timebox}-minute meeting.`, bullets }) }));
          break;
        }
        case "questions": {
          const agent = agentFor("❓", "📋 Agenda Agent", "chatgpt", "any");
          tasks.push(runAgentSection({ agent, sectionId: "questions", sectionTitle: "Questions to Ask", sectionIcon: "❓", context: ctx, bumpVersion, work: async () => ({ content: `Smart questions to ask ${company}.`, bullets: ["What does a great outcome look like after this call?", "What are the top 2–3 risks you're underwriting here?", "Who else needs conviction for the next step?", "What's your typical timeline from intro → decision?", "What diligence artifacts matter most?", "What comparable companies do you reference?", "What would make you excited to re-engage in 2 weeks?", "If you pass, what would be the most likely reason?", "What's the best next step if there's mutual interest?", "How do you support portfolio post-investment?"] }) }));
          break;
        }
        case "risks": {
          const agent = agentFor("⚠️", "🧠 Coordinator", "chatgpt", "planner");
          tasks.push(runAgentSection({ agent, sectionId: "risks", sectionTitle: "Risks / Red Flags", sectionIcon: "⚠️", context: ctx, bumpVersion, work: async () => ({ content: `Risks to be prepared for (and how to answer).`, bullets: ["Unclear wedge → be crisp on differentiation + why now", "GTM uncertainty → show ICP, pipeline, and channel focus", "Competitive pressure → explain switching costs / moat", "Market size skepticism → top-down + bottom-up framing", "Execution risk → team strengths + milestones"] }) }));
          break;
        }
        case "reply": {
          const agent = agentFor("✉️", "✉️ Email Draft Agent", "chatgpt", "any");
          tasks.push(runAgentSection({
            agent, sectionId: "reply", sectionTitle: "Draft Reply Email", sectionIcon: "✉️",
            context: ctx, bumpVersion,
            work: async () => {
              const hi = (ctx.people && ctx.people.length) ? `Hi ${ctx.people[0]},` : "Hi there,";
              const when = (ctx.date || ctx.time || ctx.timezone) ? `${ctx.date || ""} ${ctx.time || ""} ${ctx.timezone || ""}`.trim() : "the scheduled time";
              const loc = ctx.locationOrLink ? `Location/link: ${ctx.locationOrLink}` : "Could you confirm the Zoom link/location?";
              const body = [hi, "", `Looking forward to our conversation with ${company} on ${when}.`, "", `I'll come prepared to discuss ${goal.toLowerCase()} and share a quick overview of ${product}.`, "", loc, "", "Best,"].join("\n");
              meetingKit.draftReply = body;
              // Clear stale draft link since the text changed
              meetingKit.draftId = undefined;
              meetingKit.draftWebLink = undefined;
              return { content: body };
            },
          }));
          break;
        }
        default:
          log.warn(`rerun_meeting_kit: unknown section id "${id}" — skipped`);
      }
    }

    if (tasks.length === 0) {
      return { content: [{ type: "text" as const, text: `None of the requested section IDs are valid: ${sectionIds.join(", ")}` }] };
    }

    await Promise.allSettled(tasks);

    // Mark re-run sections as cached at the current context version
    for (const id of sectionIds) {
      const sec = meetingKit.sections.find(s => s.id === id);
      if (sec) sec.cached = false; // freshly run, not from cache
    }

    meetingKit.lastUpdated = now();
    bumpVersion();

    log.info(`Rerun complete for sections: ${sectionIds.join(", ")}`);
    return {
      content: [{
        type: "text" as const,
        text: `Re-ran ${tasks.length} section${tasks.length !== 1 ? "s" : ""}: ${sectionIds.join(", ")}. Open the Meeting Kit widget to review.`,
      }],
    };
  });

  log.info("Meeting Prep tools registered");
}
