import { MCPServer } from "mcp-use/server";
import { z } from "zod";
import { gmail } from "@googleapis/gmail";
import { calendar } from "@googleapis/calendar";
import { oauth2 } from "@googleapis/oauth2";
import { OAuth2Client } from "google-auth-library";
import { generateId, now, Logger } from "../../shared/utils.js";
import { commandCenter, workspace, meetingKit, bumpVersion } from "../workspace.js";
import type { CCEmail, CCEvent } from "../types.js";

const log = new Logger("GoogleIntegration");

// Google OAuth Configuration
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "";

// Token storage (in-memory for hackathon; production would use DB)
type StoredGoogleToken = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  email: string;
};

/**
 * In-memory per-session token store.
 * Keyed by MCP session id so widgets can poll and tools can access the right account.
 */
const tokenStore = new Map<string, StoredGoogleToken>();

let oauth2Client: OAuth2Client | null = null;

export function isGoogleConfigured(): boolean {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

export function isGoogleRedirectConfigured(): boolean {
  return !!GOOGLE_REDIRECT_URI;
}

/** Generate OAuth URL for a given state (session id). Used by /auth/go redirect. */
export function generateGoogleAuthUrlForState(state: string): string {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ],
    prompt: "consent",
    include_granted_scopes: true,
    state,
  });
}

/** Get short sign-in URL (redirects to full OAuth). Prevents truncation in chat UIs. */
export function getShortSignInUrl(state: string): string {
  const base = GOOGLE_REDIRECT_URI.replace(/\/auth\/google\/callback.*$/i, "").replace(/\/+$/, "") || "https://localhost:3200";
  return `${base}/auth/go?state=${encodeURIComponent(state)}`;
}

function getOAuth2Client(): OAuth2Client {
  if (!oauth2Client) {
    oauth2Client = new OAuth2Client(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI || undefined,
    );
  }
  return oauth2Client;
}

function getAuthenticatedClient(accessToken: string): OAuth2Client {
  const client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  client.setCredentials({ access_token: accessToken });
  return client;
}

/** Return the current MCP session id if available. */
function getSessionId(ctx: any): string | null {
  return ctx?.session?.sessionId || ctx?.session?.id || null;
}

/** Prefer the current session's token; fallback to any stored token (legacy tools). */
export function getTokenForContext(ctx: any): StoredGoogleToken | null {
  const sid = getSessionId(ctx);
  if (sid && tokenStore.has(sid)) return tokenStore.get(sid)!;
  return Array.from(tokenStore.values()).pop() || null;
}

/** Get connection status for widget display. Used by get_workspace. */
export function getConnectionStatus(ctx: any): { connected: boolean; email: string | null } {
  const token = getTokenForContext(ctx);
  return {
    connected: !!token,
    email: token?.email || null,
  };
}

function decodeBase64Url(data: string): string {
  const s = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract best-effort text from a Gmail message payload (prefers text/plain, falls back to text/html).
 */
export function extractTextFromGmailPayload(payload: any): string {
  const stack: any[] = [payload].filter(Boolean);
  let html: string | null = null;

  while (stack.length > 0) {
    const p = stack.pop();
    const mime = p?.mimeType;
    const bodyData = p?.body?.data;

    if (mime === "text/plain" && typeof bodyData === "string" && bodyData.length > 0) {
      return decodeBase64Url(bodyData);
    }
    if (mime === "text/html" && typeof bodyData === "string" && bodyData.length > 0 && !html) {
      html = decodeBase64Url(bodyData);
    }
    const parts = p?.parts;
    if (Array.isArray(parts)) {
      for (const child of parts) stack.push(child);
    }
  }

  if (html) return stripHtml(html);
  return "";
}

/**
 * Exchange an OAuth authorization code for tokens and store them for a session.
 * Intended to be called from the browser redirect route (/auth/google/callback).
 */
export async function handleGoogleOAuthCallback(
  code: string,
  sessionId?: string,
): Promise<{ sessionId: string; email: string }> {
  if (!isGoogleConfigured()) {
    throw new Error("Google OAuth not configured (missing GOOGLE_CLIENT_ID/SECRET).");
  }
  if (!isGoogleRedirectConfigured()) {
    throw new Error("Google OAuth redirect not configured (missing GOOGLE_REDIRECT_URI).");
  }

  const sid = sessionId || generateId();
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const oauth2Client = oauth2({ version: "v2", auth: client });
  const userInfo = await oauth2Client.userinfo.get();
  const email = userInfo.data.email || "unknown";

  tokenStore.set(sid, {
    accessToken: tokens.access_token!,
    refreshToken: tokens.refresh_token || undefined,
    expiresAt: tokens.expiry_date || Date.now() + 3600_000,
    email,
  });

  log.info(`Google OAuth complete for ${email} (session=${sid.slice(0, 6)}...)`);
  return { sessionId: sid, email };
}

// ── Demo data (used when Google is not configured or as fallback) ──
function getDemoEmails(): CCEmail[] {
  return [
    {
      id: generateId(), from: "Sarah Chen <sarah.chen@sequoiacap.com>",
      subject: "Intro call — Sequoia x Synapse",
      preview: "Hi! I saw your demo at the YC hackathon and I'm really impressed with the multi-agent coordination layer. Would love to set up a 30-min call to discuss a potential seed investment.",
      date: new Date().toISOString(), read: false, starred: true, labels: ["investor", "urgent"],
      body: "Hi!\n\nI saw your demo at the YC hackathon and I'm really impressed with the multi-agent coordination layer you've built. The stigmergy approach to AI agent orchestration is exactly the kind of infrastructure play we've been looking for.\n\nWould love to set up a 30-min intro call to discuss a potential seed investment. We typically write $1-3M checks at this stage.\n\nAre you free Friday at 3pm PT? Happy to do Zoom.\n\nBest,\nSarah Chen\nPartner, Sequoia Capital",
    },
    {
      id: generateId(), from: "David Park <david@a16z.com>",
      subject: "Re: AI Agent Infrastructure — follow up",
      preview: "Great meeting you at the demo day. Your agent coordination protocol reminds me of what we saw early with Kubernetes. Let's chat more.",
      date: new Date(Date.now() - 3600_000).toISOString(), read: false, starred: true, labels: ["investor"],
    },
    {
      id: generateId(), from: "Lisa Wang <lisa@ycombinator.com>",
      subject: "YC W26 — Office Hours Reminder",
      preview: "Reminder: Your office hours slot is Thursday 2-3pm. Come prepared to discuss your fundraising strategy and product roadmap.",
      date: new Date(Date.now() - 7200_000).toISOString(), read: true, starred: false, labels: ["yc"],
    },
    {
      id: generateId(), from: "Mike Torres <mike@eng.team>",
      subject: "Re: MCP Server Performance",
      preview: "Latency is down to 45ms p99 after the optimization. Ready for the demo tomorrow.",
      date: new Date(Date.now() - 14400_000).toISOString(), read: true, starred: false, labels: ["engineering"],
    },
    {
      id: generateId(), from: "Alex Rivera <alex@openai.com>",
      subject: "Partnership discussion — ChatGPT + Synapse",
      preview: "Hi, I lead the MCP integrations team at OpenAI. We'd love to explore a deeper integration between Synapse and ChatGPT.",
      date: new Date(Date.now() - 28800_000).toISOString(), read: false, starred: false, labels: ["partnership"],
    },
    {
      id: generateId(), from: "Jen Liu <jen@linear.app>",
      subject: "Synapse x Linear integration?",
      preview: "Our users have been asking about AI agent task coordination. Would Synapse be a good fit as an integration partner?",
      date: new Date(Date.now() - 43200_000).toISOString(), read: true, starred: false, labels: ["partnership"],
    },
  ];
}

function getDemoCalendarEvents(): CCEvent[] {
  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];
  const fri = new Date(today);
  fri.setDate(fri.getDate() + ((5 - fri.getDay() + 7) % 7 || 7));
  const friStr = fri.toISOString().split("T")[0];
  return [
    { id: generateId(), title: "Team Standup", date: todayStr, time: "09:00", duration: "15m", location: "Zoom", color: "#3b82f6" },
    { id: generateId(), title: "YC Office Hours", date: todayStr, time: "14:00", duration: "1h", location: "YC Campus, SF", attendees: ["Lisa Wang"], color: "#f97316" },
    { id: generateId(), title: "Sequoia Call — Sarah Chen", date: friStr, time: "15:00", duration: "30m", location: "Zoom", attendees: ["Sarah Chen"], color: "#a855f7" },
  ];
}

/** Register Google integration tools (Gmail + Calendar) */
export function registerGoogleTools(
  server: MCPServer,
  bumpVersion: () => void,
): void {

  // ── google_connection_status: Widget-friendly status for polling ──
  server.tool({
    name: "google_connection_status",
    description: "Check whether this ChatGPT session is connected to Google (Gmail/Calendar). Widgets can poll this after OAuth.",
    schema: z.object({}),
  }, async (_args: any, ctx: any) => {
    const sid = getSessionId(ctx);
    const token = sid ? tokenStore.get(sid) : null;
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          connected: !!token,
          email: token?.email || null,
          session_id: sid,
          configured: isGoogleConfigured() && isGoogleRedirectConfigured(),
        }, null, 2),
      }],
    };
  });

  // ── gmail_get_email: Fetch a full email (body text) for meeting prep ──
  server.tool({
    name: "gmail_get_email",
    description: "Fetch a specific Gmail message by id and return headers + best-effort body text. Use this when you need the actual email content for meeting extraction.",
    schema: z.object({
      message_id: z.string().min(1).describe("Gmail message id"),
    }),
  }, async (args: any, ctx: any) => {
    const token = getTokenForContext(ctx);
    if (!token) {
      return { content: [{ type: "text" as const, text: "Not authenticated. Call google_login first." }], isError: true };
    }
    try {
      const auth = getAuthenticatedClient(token.accessToken);
      const gmailClient = gmail({ version: "v1", auth });
      const detail = await gmailClient.users.messages.get({
        userId: "me",
        id: args.message_id,
        format: "full",
      });
      const headers = detail.data.payload?.headers || [];
      const subject = headers.find(h => h.name === "Subject")?.value || "(no subject)";
      const from = headers.find(h => h.name === "From")?.value || "unknown";
      const date = headers.find(h => h.name === "Date")?.value || "";
      const snippet = detail.data.snippet || "";
      const bodyText = extractTextFromGmailPayload(detail.data.payload);

      // Update Command Center email entry if present
      const idx = commandCenter.data.emails.findIndex(e => e.id === args.message_id);
      if (idx >= 0) {
        commandCenter.data.emails[idx] = {
          ...commandCenter.data.emails[idx],
          subject,
          from,
          date,
          preview: snippet,
          body: bodyText,
        };
        commandCenter.lastUpdated = now();
        bumpVersion();
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            id: args.message_id,
            subject,
            from,
            date,
            snippet,
            body: bodyText,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      log.error(`gmail_get_email failed: ${err.message}`);
      return { content: [{ type: "text" as const, text: `Gmail error: ${err.message}` }], isError: true };
    }
  });

  // ── check_email: Primary entry point when user asks to check/read email ──
  server.tool({
    name: "check_email",
    description: "IMPORTANT: Call this when the user asks to check email, read inbox, see latest email, or check Gmail. Do NOT say you cannot access email—use this tool. If the user is not connected, it returns a SHORT sign-in link (won't be cut off). You MUST paste that link in your response so the user can click it. Do NOT say 'the link is shown above' — paste it. If connected, it fetches emails and loads them into the Command Center. After calling this, ALWAYS call the command-center tool to display the interactive inbox UI.",
    schema: z.object({
      query: z.string().optional().describe("Gmail search query, e.g. 'is:unread' or 'from:someone@example.com'"),
      max_results: z.number().optional().describe("Max emails to fetch (default 10)"),
    }),
  }, async (args: any, ctx: any) => {
    // Try real Gmail if configured and authenticated
    if (isGoogleConfigured() && isGoogleRedirectConfigured()) {
      const token = getTokenForContext(ctx);
      if (token) {
        try {
          const auth = getAuthenticatedClient(token.accessToken);
          const gmailClient = gmail({ version: "v1", auth });
          const listRes = await gmailClient.users.messages.list({
            userId: "me", maxResults: args.max_results || 10, q: args.query || "is:inbox",
          });
          const messages = listRes.data.messages || [];
          const emails: CCEmail[] = [];
          for (const msg of messages.slice(0, 10)) {
            const detail = await gmailClient.users.messages.get({
              userId: "me", id: msg.id!, format: "metadata",
              metadataHeaders: ["Subject", "From", "Date"],
            });
            const headers = detail.data.payload?.headers || [];
            emails.push({
              id: msg.id!,
              from: headers.find(h => h.name === "From")?.value || "unknown",
              subject: headers.find(h => h.name === "Subject")?.value || "(no subject)",
              preview: detail.data.snippet || "",
              date: headers.find(h => h.name === "Date")?.value || "",
              read: !(detail.data.labelIds || []).includes("UNREAD"),
              starred: (detail.data.labelIds || []).includes("STARRED"),
              labels: (detail.data.labelIds || []).filter(l => !["INBOX","UNREAD","STARRED","IMPORTANT"].includes(l)),
            });
          }
          commandCenter.data.emails = emails;
          if (!commandCenter.activeModules.includes("email")) commandCenter.activeModules.push("email");
          commandCenter.lastUpdated = now(); bumpVersion();
          log.info(`Read ${emails.length} real emails from Gmail`);
          const summary = emails.map((e, i) => `${i + 1}. **${e.subject}** — from ${e.from}\n   ${e.preview?.slice(0, 80)}...`).join("\n\n");
          return { content: [{ type: "text" as const, text: `NEXT: Call the command-center tool immediately to display the inbox UI.\n\nHere are your latest ${emails.length} emails:\n\n${summary}` }] };
        } catch (err: any) {
          log.error(`Gmail API failed, falling back to demo: ${err.message}`);
          // Fall through to demo data
        }
      }
      // Not connected but Google is configured — offer login but ALSO show demo data
      if (!getTokenForContext(ctx)) {
        const client = getOAuth2Client();
        const sid = getSessionId(ctx) || generateId();
        const url = client.generateAuthUrl({
          access_type: "offline",
          scope: [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.compose",
            "https://www.googleapis.com/auth/calendar",
            "https://www.googleapis.com/auth/userinfo.email",
            "https://www.googleapis.com/auth/userinfo.profile",
          ],
          prompt: "consent",
          include_granted_scopes: true,
          state: sid,
        });
        const shortUrl = isGoogleRedirectConfigured() ? getShortSignInUrl(sid) : url;
        return {
          content: [{
            type: "text" as const,
            text: `Gmail is not connected yet. **Click to sign in:** ${shortUrl}\n\n(Short link — won't be cut off. Paste the full URL in your response. After connecting, tell me "Connected".)`,
          }],
        };
      }
    }

    return {
      content: [{
        type: "text" as const,
        text: `Gmail is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI environment variables, then call google_login to connect. No mock data — real Gmail only.`,
      }],
    };
  });

  // ── google_login: Generate OAuth URL for user to log in ──
  server.tool({
    name: "google_login",
    description: "Get the Google OAuth login URL for this session. Returns a SHORT login_url that won't be cut off in chat. You MUST paste the login_url in your response so the user can click it. Do NOT say 'the link is in the interface' — paste it. Covers Gmail + Calendar.",
    schema: z.object({
      scopes: z.array(z.string()).optional().describe("OAuth scopes to request. Default: gmail.readonly + calendar"),
    }),
  }, async (args: any, ctx: any) => {
    if (!isGoogleConfigured()) {
      return {
        content: [{
          type: "text" as const,
          text: "Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.",
        }],
      };
    }
    if (!isGoogleRedirectConfigured()) {
      return {
        content: [{
          type: "text" as const,
          text: "Google OAuth redirect not configured. Set GOOGLE_REDIRECT_URI to https://<host>/auth/google/callback.",
        }],
        isError: true,
      };
    }

    const scopes = args.scopes || [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ];

    const sid = getSessionId(ctx) || generateId();
    const client = getOAuth2Client();
    const url = client.generateAuthUrl({
      access_type: "offline",
      scope: scopes,
      prompt: "consent",
      include_granted_scopes: true,
      state: sid,
    });

    log.info("Generated Google OAuth URL");
    const shortUrl = getShortSignInUrl(sid);
    return {
      content: [{
        type: "text" as const,
        text: [
          "Paste this SHORT link in your response (won't be cut off):",
          "",
          shortUrl,
          "",
          "User clicks it → redirects to Google sign-in. After connecting, they say 'Connected'.",
          "",
          JSON.stringify({
            login_url: shortUrl,
            url: shortUrl,
            message: "Sign in with Google (Gmail + Calendar). After authorizing, you'll be redirected back.",
            scopes,
            session_id: sid,
          }, null, 2),
        ].join("\n"),
      }],
    };
  });

  // ── google_auth_callback: Exchange OAuth code for tokens ──
  server.tool({
    name: "google_auth_callback",
    description: "Complete Google OAuth by exchanging the authorization code for tokens. Call this after the user has signed in and received an auth code.",
    schema: z.object({
      code: z.string().describe("The OAuth authorization code from Google"),
    }),
  }, async (args: any, ctx: any) => {
    if (!isGoogleConfigured()) {
      return { content: [{ type: "text" as const, text: "Google OAuth not configured." }] };
    }

    try {
      const sid = getSessionId(ctx) || generateId();
      const { email } = await handleGoogleOAuthCallback(args.code, sid);

      log.info(`Google OAuth complete for ${email}`);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            email,
            session_id: sid,
            message: `Connected as ${email}. You can now use read_gmail, read_calendar, and add_calendar_event.`,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      log.error(`OAuth exchange failed: ${err.message}`);
      return {
        content: [{
          type: "text" as const,
          text: `OAuth failed: ${err.message}`,
        }],
        isError: true,
      };
    }
  });

  // ── read_gmail: Read latest emails from Gmail ──
  server.tool({
    name: "read_gmail",
    description: "Read emails from the user's Gmail inbox. Falls back to synced inbox data if not connected. Prefer check_email when user first asks to 'check email'. After fetching, call command-center tool to display the inbox UI.",
    schema: z.object({
      token_id: z.string().optional().describe("Token ID from google_auth_callback. If not provided, uses the most recent token."),
      max_results: z.number().optional().describe("Max emails to fetch (default: 10)"),
      query: z.string().optional().describe("Gmail search query (e.g. 'is:unread', 'from:boss@company.com')"),
    }),
  }, async (args: any, ctx: any) => {
    const token = args.token_id ? tokenStore.get(args.token_id) : getTokenForContext(ctx);
    if (token) {
      try {
        const auth = getAuthenticatedClient(token.accessToken);
        const gmailClient = gmail({ version: "v1", auth });
        const listRes = await gmailClient.users.messages.list({
          userId: "me", maxResults: args.max_results || 10, q: args.query || "is:inbox",
        });
        const messages = listRes.data.messages || [];
        const emails: CCEmail[] = [];
        for (const msg of messages.slice(0, 10)) {
          const detail = await gmailClient.users.messages.get({
            userId: "me", id: msg.id!, format: "metadata", metadataHeaders: ["Subject", "From", "Date"],
          });
          const headers = detail.data.payload?.headers || [];
          emails.push({
            id: msg.id!, from: headers.find(h => h.name === "From")?.value || "unknown",
            subject: headers.find(h => h.name === "Subject")?.value || "(no subject)",
            preview: detail.data.snippet || "",
            date: headers.find(h => h.name === "Date")?.value || "",
            read: !(detail.data.labelIds || []).includes("UNREAD"),
            starred: (detail.data.labelIds || []).includes("STARRED"),
            labels: (detail.data.labelIds || []).filter(l => !["INBOX","UNREAD","STARRED","IMPORTANT"].includes(l)),
          });
        }
        commandCenter.data.emails = emails;
        if (!commandCenter.activeModules.includes("email")) commandCenter.activeModules.push("email");
        commandCenter.lastUpdated = now(); bumpVersion();
        log.info(`Read ${emails.length} real emails from Gmail`);
        return { content: [{ type: "text" as const, text: `NEXT: Call the command-center tool immediately to display the inbox UI.\n\n${JSON.stringify({ email_count: emails.length, account: token.email, emails: emails.map(e => ({ id: e.id, from: e.from, subject: e.subject, preview: e.preview, date: e.date, read: e.read, starred: e.starred })) }, null, 2)}` }] };
      } catch (err: any) {
        log.error(`Gmail read failed, using demo: ${err.message}`);
      }
    }
    return { content: [{ type: "text" as const, text: `NEXT: Call the command-center tool immediately to display the inbox UI.\n\n${JSON.stringify({ email_count: commandCenter.data.emails.length, emails: commandCenter.data.emails.map(e => ({ id: e.id, from: e.from, subject: e.subject, preview: e.preview, date: e.date, read: e.read, starred: e.starred })) }, null, 2)}` }] };
  });

  // ── read_calendar: Read upcoming events from Calendar ──
  server.tool({
    name: "read_calendar",
    description: "Read upcoming events from the user's calendar. Shows schedule, availability, and meeting details. Use this to check the user's availability or find meetings.",
    schema: z.object({
      token_id: z.string().optional().describe("Token ID from auth. Uses most recent if not provided."),
      days: z.number().optional().describe("Number of days ahead to look (default: 7)"),
    }),
  }, async (args: any, ctx: any) => {
    const token = args.token_id ? tokenStore.get(args.token_id) : getTokenForContext(ctx);
    if (token) {
      try {
        const auth = getAuthenticatedClient(token.accessToken);
        const calendarClient = calendar({ version: "v3", auth });
        const timeMin = new Date().toISOString();
        const days = args.days || 7;
        const timeMax = new Date(Date.now() + days * 86400_000).toISOString();
        const res = await calendarClient.events.list({
          calendarId: "primary", timeMin, timeMax, singleEvents: true, orderBy: "startTime", maxResults: 20,
        });
        const events: CCEvent[] = (res.data.items || []).map(evt => {
          const start = evt.start?.dateTime || evt.start?.date || "";
          const end = evt.end?.dateTime || evt.end?.date || "";
          const startDate = start.split("T")[0];
          const startTime = start.includes("T") ? start.split("T")[1].substring(0, 5) : "all-day";
          let duration = "";
          if (evt.start?.dateTime && evt.end?.dateTime) {
            const diffMs = new Date(end).getTime() - new Date(start).getTime();
            const diffMin = Math.round(diffMs / 60000);
            duration = diffMin >= 60 ? `${Math.floor(diffMin / 60)}h${diffMin % 60 > 0 ? diffMin % 60 + "m" : ""}` : `${diffMin}m`;
          }
          return { id: evt.id || generateId(), title: evt.summary || "(no title)", date: startDate, time: startTime, duration, location: evt.location, attendees: evt.attendees?.map(a => a.email || a.displayName || "").filter(Boolean), color: "#3b82f6" };
        });
        commandCenter.data.events = events;
        if (!commandCenter.activeModules.includes("calendar")) commandCenter.activeModules.push("calendar");
        commandCenter.lastUpdated = now(); bumpVersion();
        log.info(`Read ${events.length} real calendar events`);
        return { content: [{ type: "text" as const, text: JSON.stringify({ event_count: events.length, events: events.map(e => ({ id: e.id, title: e.title, date: e.date, time: e.time, duration: e.duration, location: e.location, attendees: e.attendees })) }, null, 2) }] };
      } catch (err: any) {
        log.error(`Calendar read failed, using demo: ${err.message}`);
      }
    }
    return { content: [{ type: "text" as const, text: JSON.stringify({ event_count: commandCenter.data.events.length, events: commandCenter.data.events.map(e => ({ id: e.id, title: e.title, date: e.date, time: e.time, duration: e.duration, location: e.location, attendees: e.attendees })) }, null, 2) }] };
  });

  // ── add_calendar_event: Create a new event ──
  server.tool({
    name: "add_calendar_event",
    description: "Add a new event to the user's calendar. Creates the event and updates the Command Center calendar widget. Works with or without Google Calendar connection.",
    schema: z.object({
      token_id: z.string().optional().describe("Token ID from auth. Uses most recent if not provided."),
      title: z.string().describe("Event title"),
      date: z.string().describe("Event date (YYYY-MM-DD)"),
      time: z.string().optional().describe("Start time (HH:MM, 24h or '3:00 PM'). Omit for all-day event."),
      duration_minutes: z.number().optional().describe("Duration in minutes (default: 60)"),
      location: z.string().optional().describe("Event location"),
      description: z.string().optional().describe("Event description"),
      attendees: z.array(z.string()).optional().describe("Attendee email addresses"),
      timezone: z.string().optional().describe("Timezone (default: America/Los_Angeles)"),
    }),
  }, async (args: any, ctx: any) => {
    const durationMin = args.duration_minutes || 60;
    const tz = args.timezone || "America/Los_Angeles";
    // Parse time: "3:00 PM" -> "15:00"
    let startTime = (args.time || "09:00").trim();
    const pmMatch = startTime.match(/(\d{1,2})(?::(\d{2}))?\s*PM/i);
    const amMatch = startTime.match(/(\d{1,2})(?::(\d{2}))?\s*AM/i);
    if (pmMatch) {
      const h = parseInt(pmMatch[1], 10);
      startTime = `${h === 12 ? 12 : h + 12}:${pmMatch[2] || "00"}`;
    } else if (amMatch) {
      const h = parseInt(amMatch[1], 10);
      startTime = `${h === 12 ? "00" : String(h).padStart(2, "0")}:${amMatch[2] || "00"}`;
    } else {
      startTime = startTime.replace(/\s*(AM|PM|ET|PT|PST|EST|CT)\s*/gi, "").trim();
      if (!/^\d{1,2}:\d{2}$/.test(startTime)) startTime = "09:00";
    }

    let googleLink: string | undefined;
    // Try real Google Calendar if authenticated
    const token = args.token_id ? tokenStore.get(args.token_id) : getTokenForContext(ctx);
    if (token) {
      try {
        const auth = getAuthenticatedClient(token.accessToken);
        const calendarClient = calendar({ version: "v3", auth });
        const [sH, sM] = startTime.split(":").map(Number);
        const endMin = sH * 60 + sM + durationMin;
        const eH = Math.floor(endMin / 60) % 24;
        const eM = endMin % 60;
        const startDateTime = `${args.date}T${startTime}:00`;
        const endDateTime = `${args.date}T${String(eH).padStart(2,"0")}:${String(eM).padStart(2,"0")}:00`;
        const event: any = {
          summary: args.title, location: args.location, description: args.description,
          start: args.time ? { dateTime: startDateTime, timeZone: tz } : { date: args.date },
          end: args.time ? { dateTime: endDateTime, timeZone: tz } : { date: args.date },
          attendees: args.attendees?.map((email: string) => ({ email })),
        };
        const res = await calendarClient.events.insert({ calendarId: "primary", requestBody: event, sendUpdates: "all" });
        googleLink = res.data.htmlLink || undefined;
        log.info(`Created real Google Calendar event: ${args.title}`);
      } catch (err: any) {
        log.error(`Google Calendar create failed (using local): ${err.message}`);
      }
    }

    // Always add to Command Center widget
    const ccEvent: CCEvent = {
      id: generateId(), title: args.title, date: args.date, time: startTime,
      duration: `${durationMin}m`, location: args.location, attendees: args.attendees, color: "#22c55e",
    };
    commandCenter.data.events.push(ccEvent);
    if (!commandCenter.activeModules.includes("calendar")) commandCenter.activeModules.push("calendar");
    commandCenter.lastUpdated = now(); bumpVersion();

    log.info(`Calendar event added: ${args.title} on ${args.date} at ${startTime}`);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: true, event_id: ccEvent.id, title: args.title, date: args.date, time: startTime,
          duration: `${durationMin}m`, location: args.location, timezone: tz,
          ...(googleLink ? { google_calendar_link: googleLink } : {}),
          message: `Event "${args.title}" added to calendar on ${args.date} at ${startTime}${args.location ? ` at ${args.location}` : ""}. ${googleLink ? "Also added to Google Calendar." : "Visible in the Command Center calendar widget."}`,
        }, null, 2),
      }],
    };
  });

  // ── gmail_create_draft: Create a Gmail draft from the Meeting Kit reply ──
  server.tool({
    name: "gmail_create_draft",
    description: "Create a Gmail draft from the Meeting Kit's draft reply email. Call this after generate_meeting_kit when the user wants to send the confirmation email. Updates the Meeting Kit widget with a link to open the draft in Gmail.",
    schema: z.object({
      token_id: z.string().optional().describe("Token ID from auth. Uses most recent if not provided."),
      to: z.string().optional().describe("Recipient email address. Defaults to the sender of the source email."),
      subject: z.string().optional().describe("Email subject. Defaults to 'Re: <original subject>'."),
      body: z.string().optional().describe("Email body. Defaults to the Meeting Kit draft reply."),
    }),
  }, async (args: any, ctx: any) => {
    const token = args.token_id ? tokenStore.get(args.token_id) : getTokenForContext(ctx);
    if (!token) {
      return { content: [{ type: "text" as const, text: "Not authenticated. Call google_login first." }] };
    }

    try {
      const auth = getAuthenticatedClient(token.accessToken);
      const gmailClient = gmail({ version: "v1", auth });

      // Strip CR/LF from header values to prevent header injection
      const sanitizeHeader = (v: string) => v.replace(/[\r\n]+/g, " ").trim();
      const to = sanitizeHeader(args.to || meetingKit.meeting.emailFrom || "");
      const subject = sanitizeHeader(args.subject || (meetingKit.meeting.emailSubject
        ? `Re: ${meetingKit.meeting.emailSubject}`
        : `Meeting Confirmation — ${meetingKit.meeting.company}`));
      const body = args.body || meetingKit.draftReply || "";

      if (!to) {
        return { content: [{ type: "text" as const, text: "No recipient address found. Please provide a 'to' address or connect Gmail first." }] };
      }

      const rawLines = [
        `To: ${to}`,
        `Subject: ${subject}`,
        `Content-Type: text/plain; charset=utf-8`,
        ``,
        body,
      ].join("\r\n");
      const raw = Buffer.from(rawLines).toString("base64url");

      const res = await gmailClient.users.drafts.create({
        userId: "me",
        requestBody: { message: { raw } },
      });

      const draftId = res.data.id || "";
      const draftWebLink = draftId
        ? `https://mail.google.com/mail/#drafts/${draftId}`
        : "https://mail.google.com/mail/#drafts";

      // Persist to Meeting Kit state
      meetingKit.draftId = draftId;
      meetingKit.draftWebLink = draftWebLink;
      meetingKit.lastUpdated = now();
      bumpVersion();

      log.info(`Gmail draft created: ${draftId} → ${to}`);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            draft_id: draftId,
            draft_link: draftWebLink,
            to,
            subject,
          }),
        }],
      };
    } catch (err: any) {
      log.error(`gmail_create_draft failed: ${err.message}`);
      return { content: [{ type: "text" as const, text: `Failed to create draft: ${err.message}` }] };
    }
  });

  log.info(isGoogleConfigured()
    ? "Google integration enabled (Gmail + Calendar)"
    : "Google integration in demo mode (set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET for real APIs)");
}
