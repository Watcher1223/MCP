# Investor Meeting Kit — Implementation Guide

> **Synapse MCP App** · YC Hackathon Feb 2026  
> ChatGPT-native multi-agent meeting prep: Gmail → extract context → 7 parallel agents → living Meeting Kit.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Data Model](#data-model)
4. [MCP Tools Reference](#mcp-tools-reference)
5. [Agent System](#agent-system)
6. [Web Search Integration (Serper)](#web-search-integration-serper)
7. [Gmail Integration](#gmail-integration)
8. [Widget UI](#widget-ui)
9. [Environment Variables](#environment-variables)
10. [API Reference](#api-reference)
11. [Test Coverage](#test-coverage)
12. [Demo Script](#demo-script)

---

## Overview

The Investor Meeting Kit is a ChatGPT-native MCP App that turns a raw investor email into a complete meeting preparation package in ~30 seconds.

**End-to-end flow:**

```
Gmail OAuth → Select email → Extract context (editable) →
Generate Kit (7 agents in parallel) → Living Meeting Kit →
Create Gmail Draft → Open Draft in Gmail
```

**What makes it unique:**
- Parallelism: 7 specialist agents run simultaneously, sections fill in live
- Shared state: editing any context field lets you re-run only the affected sections
- Real sources: when `SERPER_API_KEY` is set, News/Thesis/Competitors sections cite real web results
- ChatGPT-native: everything runs inside `window.openai.callTool()` — no page loads

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      ChatGPT App Widget                     │
│  (meeting-kit uiResource — server-mcpuse.ts)                │
│                                                             │
│  [Context Editor]  [Agent Feed]  [Meeting Kit Sections]     │
│        │                │               │                   │
│   callTool()       callTool()       callTool()              │
└──────────┬──────────────┬───────────────┬───────────────────┘
           │              │               │
           ▼              ▼               ▼
┌──────────────────────────────────────────────────────────────┐
│                   MCP Server (mcp-use)                       │
│                                                              │
│  meeting-prep.ts         google-integration.ts              │
│  ├─ extract_meeting_context   ├─ google_login               │
│  ├─ update_meeting_context    ├─ gmail_get_email            │
│  ├─ generate_meeting_kit      ├─ read_gmail                 │
│  ├─ rerun_meeting_kit         ├─ gmail_create_draft         │
│  ├─ get_meeting_kit           └─ add_calendar_event         │
│  └─ update_meeting_section                                  │
│                                                              │
│  search.ts                   workspace.ts                   │
│  ├─ searchWeb()              ├─ meetingKit (shared state)   │
│  └─ isSearchAvailable()      └─ bumpVersion()               │
└──────────────────────────────────────────────────────────────┘
           │                           │
           ▼                           ▼
    Serper API                   Gmail / Calendar API
 (google.serper.dev)           (googleapis.com)
```

### Key files

| File | Responsibility |
|---|---|
| `mcp/tools/meeting-prep.ts` | All meeting prep orchestration tools + `runAgentSection` helper |
| `mcp/tools/google-integration.ts` | Gmail OAuth, email reading, draft creation, calendar |
| `mcp/tools/search.ts` | Serper web search abstraction |
| `mcp/types.ts` | All shared TypeScript interfaces |
| `mcp/workspace.ts` | In-memory shared state + `bumpVersion()` |
| `mcp/server-mcpuse.ts` | Widget HTML/CSS/JS + `uiResource` registration |
| `mcp/http-routes.ts` | Express routes + `buildDemoTools` for local browser testing |

---

## Data Model

### `MeetingContext` — editable meeting fields

```typescript
interface MeetingContext {
  companyOrFirm:      string;              // "Sequoia Capital"
  people:             string[];            // ["Sarah Chen", "Mike Torres"]
  meetingGoal:        string;              // "Fundraising intro"
  date:               string;              // "2026-03-10"
  time:               string;             // "10:00 AM"
  timezone:           string;             // "ET"
  locationOrLink:     string;             // "https://zoom.us/j/123"
  timeboxMinutes:     30 | 45 | 60;
  yourProductOneLiner: string;            // "AI legal co-pilot for SMBs"
  stage:              string;             // "Seed"
  raiseTarget:        string;             // "$3M"
  assumptions:        string[];           // what was auto-filled (shown to user)
  version:            number;             // increments on every edit
  sourceEmail?:       MeetingSourceEmail; // traceability back to Gmail message
}
```

### `MeetingKitSection` — one card in the kit

```typescript
interface MeetingKitSection {
  id:        string;                              // "news", "thesis", etc.
  title:     string;                              // "Recent News"
  icon:      string;                              // "🗞"
  agentName: string;                              // "🗞 News Agent"
  status:    "pending" | "working" | "done" | "error";
  content:   string;                              // summary paragraph
  bullets?:  string[];                            // bullet points
  sources?:  SearchSource[];                      // Serper citations (if available)
  cached?:   boolean;                             // false = freshly run
  updatedAt: number;
}
```

### `MeetingKitState` — top-level state object

```typescript
interface MeetingKitState {
  status:         "idle" | "preparing" | "ready";
  runId:          string;          // unique per Generate Kit call
  contextVersion: number;          // context.version snapshot at run time
  meeting:        { company, people, date, time, location, goal, emailSubject, emailFrom, emailId? };
  context:        MeetingContext;
  sections:       MeetingKitSection[];
  agentFeed:      { agentName, icon, message, timestamp }[];
  draftReply:     string;          // composed reply body
  draftId?:       string;          // Gmail draft id after gmail_create_draft
  draftWebLink?:  string;          // "https://mail.google.com/mail/#drafts/<id>"
  lastUpdated:    number;
}
```

### `SearchSource` — cited web result

```typescript
interface SearchSource {
  title:   string;
  url:     string;
  snippet: string;
  date?:   string;
}
```

---

## MCP Tools Reference

### Meeting Prep Tools (`mcp/tools/meeting-prep.ts`)

#### `extract_meeting_context`
Parses a Gmail email into structured editable fields using heuristic extraction.

| Input | Type | Description |
|---|---|---|
| `email_id` | `string` | Gmail message id to parse |

**What it does:**
1. Fetches the full email body via `gmail_get_email`
2. Runs heuristic extraction: company from subject/domain, date/time patterns, Zoom links, timebox mentions, fundraising keywords
3. Populates `meetingKit.context` and lists any inferred fields as `assumptions`
4. Sets `meetingKit.status = "preparing"`

**Output:** JSON with `{ ok, companyOrFirm, assumptions[] }`

---

#### `update_meeting_context`
Applies user edits from the Context Editor to `meetingKit.context`.

| Input | Type | Description |
|---|---|---|
| `companyOrFirm` | `string?` | Company/firm name |
| `meetingGoal` | `string?` | Purpose of the meeting |
| `date` | `string?` | Meeting date |
| `time` | `string?` | Meeting time |
| `timezone` | `string?` | Timezone abbreviation |
| `locationOrLink` | `string?` | Location or video link |
| `timeboxMinutes` | `30\|45\|60?` | Agenda timebox |
| `yourProductOneLiner` | `string?` | Your product description |
| `stage` | `string?` | Fundraising stage |
| `raiseTarget` | `string?` | Raise amount |
| `people_csv` | `string?` | Comma-separated attendees |

Increments `context.version` on every call so `rerun_meeting_kit` can detect stale sections.

---

#### `generate_meeting_kit`
Coordinator tool that spawns 7 specialist agents in parallel and streams a full Meeting Kit.

**Agents spawned:**

| Agent | Icon | Section(s) | Uses Serper? |
|---|---|---|---|
| 🧠 Coordinator | `mk-coord-*` | Company Snapshot, Risks | No |
| 🗞 News Agent | `mk-news-*` | Recent News | Yes |
| 🧩 Thesis Agent | `mk-thesis-*` | Investor Thesis & Fit | Yes |
| 🥊 Competitive Agent | `mk-comp-*` | Competitive Landscape | Yes |
| 📝 Narrative Agent | `mk-narr-*` | Talking Points | No |
| 📋 Agenda Agent | `mk-agenda-*` | 30/45/60-min Agenda + Questions | No |
| ✉️ Email Draft Agent | `mk-email-*` | Draft Reply Email | No |

**Execution model:** `Promise.allSettled` — all agents run concurrently. Each calls `runAgentSection` which:
1. Sets `sec.status = "working"` and posts a feed entry
2. Calls the `work()` function (may include a Serper search)
3. On success: writes `content`, `bullets`, `sources`, sets `status = "done"`
4. On error: writes error message to `content`, sets `status = "error"`
5. Posts completion to `workspace.intents` for Mission Control telemetry

---

#### `rerun_meeting_kit`
Re-runs a specific subset of sections without touching the rest of the kit.

| Input | Type | Description |
|---|---|---|
| `section_ids` | `string[]` | IDs to re-run: `snapshot`, `news`, `thesis`, `competitors`, `talking_points`, `agenda`, `questions`, `risks`, `reply` |

Use this when:
- A section errored and you want to retry
- You edited `companyOrFirm` and only want to refresh News + Thesis
- You changed `yourProductOneLiner` and want new Competitors analysis

Re-running `reply` also clears `draftId`/`draftWebLink` since the text changed.

---

#### `get_meeting_kit`
Returns the full `MeetingKitState` as JSON for widget rendering.

---

#### `update_meeting_section`
Manually update a specific section with new content (e.g. after ChatGPT researches something).

| Input | Type | Description |
|---|---|---|
| `section_id` | `string` | Target section id |
| `content` | `string` | New paragraph text |
| `bullets` | `string[]?` | New bullet list |

---

### Google Integration Tools (`mcp/tools/google-integration.ts`)

#### `google_login`
Starts OAuth 2.0 PKCE flow. Returns an `auth_url` to open in a browser.

Default scopes: `gmail.readonly`, `gmail.compose`, `calendar`, `userinfo.email`, `userinfo.profile`

---

#### `google_connection_status`
Polls whether the current session has a valid Google token.

---

#### `gmail_get_email`
Fetches the full body of a specific Gmail message (MIME-aware, prefers `text/plain`).

---

#### `read_gmail`
Lists the last N emails with subject, sender, snippet, and date.

---

#### `gmail_create_draft`
Creates a Gmail draft from the Meeting Kit's `draftReply` body.

| Input | Type | Description |
|---|---|---|
| `to` | `string?` | Recipient (defaults to `emailFrom` from source email) |
| `subject` | `string?` | Subject (defaults to `Re: <original subject>`) |
| `body` | `string?` | Body (defaults to `meetingKit.draftReply`) |

**Process:**
1. Builds an RFC 2822 message (`To`, `Subject`, `Content-Type`, body)
2. Base64url-encodes it
3. Calls `gmailClient.users.drafts.create`
4. Stores `draftId` and `draftWebLink` on `meetingKit`
5. Widget action bar updates to show "Open Draft in Gmail" link

---

#### `add_calendar_event`
Creates a real Google Calendar event.

---

## Agent System

### `runAgentSection` — shared execution helper

All section work runs through this single function:

```typescript
async function runAgentSection(params: {
  agent:        AgentSpec;
  sectionId:    string;
  sectionTitle: string;
  sectionIcon:  string;
  context:      MeetingContext;
  bumpVersion:  () => void;
  work: () => Promise<{
    content:  string;
    bullets?: string[];
    sources?: SearchResult[];  // = SearchSource[]
  }>;
}): Promise<void>
```

**Status lifecycle:**

```
pending → working → done
                  ↘ error  (if work() throws)
```

Error sections display a red dot indicator and a red error box in the widget. The ↺ re-run button is shown on both `done` and `error` sections.

### Agent feed

Every section produces two feed entries:
- `"Working on <title>..."` when it starts
- Completion intent pushed to `workspace.intents` when done

These flow into the Agent Activity panel in the widget and into Mission Control.

---

## Web Search Integration (Serper)

### `mcp/tools/search.ts`

```typescript
// Type alias — same shape as SearchSource
export type SearchResult = SearchSource;

export function isSearchAvailable(): boolean
// Returns true only when SERPER_API_KEY is set

export async function searchWeb(query: string, n = 5): Promise<SearchResult[]>
// POST https://google.serper.dev/search
// Returns [] on any error (never throws)
```

### Sections that use Serper

| Section | Query |
|---|---|
| Recent News | `"<company>" funding OR investment OR launch news 2025 OR 2026` |
| Investor Thesis & Fit | `"<company>" investment thesis OR portfolio OR focus areas` |
| Competitive Landscape | `<product> competitors OR alternatives OR "vs" site:crunchbase.com OR site:producthunt.com` |

### Fallback behavior

When `SERPER_API_KEY` is absent or the request fails:
- `searchWeb()` returns `[]` silently
- The section work function falls through to static placeholder bullets
- `sec.sources` is set to `[]`
- The UI renders normally with no Sources block

---

## Gmail Integration

### OAuth flow

```
Widget "Connect Gmail" button
    → calls google_login (returns auth_url)
    → opens auth_url in new tab/popup
    → user consents on Google's page
    → Google redirects to /auth/google/callback
    → server exchanges code for tokens (server-side, no secrets in widget)
    → tokenStore.set(sessionId, { accessToken, refreshToken, expiresAt, email })
    → popup/tab closes
    → widget polls google_connection_status until connected
```

### Token storage

Tokens are stored in-memory per MCP session id (`tokenStore: Map<sessionId, StoredGoogleToken>`). For production, replace with a database.

### Email body extraction

`extractTextFromGmailPayload(payload)` in `google-integration.ts`:
- Handles `text/plain`, `text/html` (strips tags), `multipart/*` (recursive)
- Prefers `text/plain` over `text/html` within `multipart/alternative`
- Returns `""` on null/undefined (safe for all callers)

---

## Widget UI

The meeting-kit widget is a single-page ChatGPT App (`uiResource`) rendered via inline HTML/CSS/JS in `server-mcpuse.ts`.

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│ INVESTOR MEETING KIT                    [status badge]       │
├──────────────────────┬──────────────────┬───────────────────┤
│   Context Editor     │  Agent Activity  │  Meeting Kit      │
│                      │                  │  Sections         │
│  Company/Firm: ____  │  🧠 Coordinator  │  🏢 Snapshot  ↺  │
│  People: _________   │    Extracted...  │  🗞 News       ↺  │
│  Goal: ___________   │  🗞 News Agent   │  🧩 Thesis     ↺  │
│  Date/Time: _______  │    Searching...  │  🥊 Competitors ↺ │
│  Location: ________  │  🧩 Thesis Agent │  🎯 Talking Pts ↺ │
│  Timebox: [30 ▾]    │    Analyzing...  │  📋 Agenda     ↺  │
│  Your product: ____  │                  │  ❓ Questions  ↺  │
│  Stage / Raise: ___  │                  │  ⚠️ Risks      ↺  │
│                      │                  │  ✉️ Reply       ↺  │
│  [Save Context]      │                  │                   │
├──────────────────────┴──────────────────┴───────────────────┤
│ [⚡ Generate Kit] [🔍 Deep Research] [📅 Calendar]           │
│ [✉️ Create Gmail Draft / 📬 Open Draft in Gmail] [📋 Copy]   │
└─────────────────────────────────────────────────────────────┘
```

### Key `window.*` functions

| Function | Description |
|---|---|
| `window.saveContext()` | Calls `update_meeting_context` with current field values |
| `window.generateKit()` | Calls `generate_meeting_kit` and refreshes |
| `window.deepResearch()` | Re-runs `generate_meeting_kit` (all sections) |
| `window.rerunSection(id)` | Calls `rerun_meeting_kit` for a single section |
| `window.createGmailDraft()` | Calls `gmail_create_draft`, shows link on success |
| `window.createCalEvent()` | Calls `add_calendar_event` |
| `window.copyKit()` | Copies full kit text to clipboard |
| `window.draftReply()` | Sends `draftReply` text to ChatGPT via `followUp()` |

### Section status indicators

| Status | Dot color | Shows re-run button? |
|---|---|---|
| `pending` | Gray | No |
| `working` | Blue (pulsing) | No |
| `done` | Green | Yes (↺) |
| `error` | Red | Yes (↺) |

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Gmail OAuth | Google OAuth 2.0 client id |
| `GOOGLE_CLIENT_SECRET` | Gmail OAuth | Google OAuth 2.0 client secret |
| `GOOGLE_REDIRECT_URI` | Gmail OAuth | Callback URL, e.g. `http://localhost:3200/auth/google/callback` |
| `SERPER_API_KEY` | Optional | Enables live web search in News/Thesis/Competitors sections. Get at [serper.dev](https://serper.dev). Without it, sections use static placeholder bullets. |
| `SYNAPSE_DASHBOARD_URL` | Hosted deploys | Base URL of deployed server, e.g. `https://your-app.manufact.dev` |
| `API_PORT` | Optional | HTTP API port (default `3201`) |
| `MCP_PORT` | Optional | MCP SSE port (default `3200`) |

---

## API Reference

The REST API at `:3201` is used by the widget when running outside ChatGPT (browser/Inspector mode). All meeting prep tools are available via `/api/execute`.

### `POST /api/execute`

```json
{
  "tool": "update_meeting_context",
  "arguments": {
    "companyOrFirm": "Sequoia Capital",
    "meetingGoal": "Seed fundraising intro",
    "date": "2026-03-10",
    "timeboxMinutes": 30
  }
}
```

Response:
```json
{
  "content": [{ "type": "text", "text": "Meeting context updated." }]
}
```

### `GET /api/meeting-kit/state`

Returns the full `MeetingKitState` object as JSON.

```json
{
  "status": "ready",
  "runId": "a1b2c3d4",
  "contextVersion": 3,
  "meeting": { "company": "Sequoia Capital", "date": "2026-03-10", ... },
  "context": { "companyOrFirm": "Sequoia Capital", "version": 3, ... },
  "sections": [
    {
      "id": "news",
      "status": "done",
      "content": "Found 4 recent items about Sequoia Capital.",
      "bullets": ["Sequoia leads $100M Series B in...", ...],
      "sources": [{ "title": "...", "url": "...", "snippet": "..." }],
      "cached": false
    }
  ],
  "agentFeed": [...],
  "draftReply": "Hi Sarah,\n\nLooking forward...",
  "draftId": "Draft_abc123",
  "draftWebLink": "https://mail.google.com/mail/#drafts/Draft_abc123"
}
```

### Available tools via `/api/execute`

| Tool | Phase |
|---|---|
| `extract_meeting_context` | 2 |
| `update_meeting_context` | 2 |
| `generate_meeting_kit` | 3 |
| `get_meeting_kit` | 3 |
| `update_meeting_section` | 3 |
| `rerun_meeting_kit` | 6 |
| `gmail_create_draft` | 5 |
| `google_connection_status` | 1 |
| `read_gmail` | 1 |
| `add_calendar_event` | — |
| `sync_context` | — |

---

## Test Coverage

**78 tests across 8 test files** — all passing.

| Test file | Tests | What's covered |
|---|---|---|
| `meeting-prep.test.ts` | 25 | `extractContextFromEmail` heuristics (10), Meeting Kit REST API (7), `gmail_create_draft` (4), `rerun_meeting_kit` (4) |
| `google-integration.test.ts` | 8 | `extractTextFromGmailPayload` — plain text, HTML stripping, multipart preference, nested MIME, edge cases |
| `http-routes.test.ts` | 13 | All HTTP routes including `GET /api/meeting-kit/state` |
| `workspace.test.ts` | 4 | `initDemoData` agent/intent setup |
| `doc-session-manager.test.ts` | 16 | Y.js collaborative editing sessions |
| `collab-ws.test.ts` | 5 | WebSocket sync + awareness protocol |
| `locks.test.ts` | 4 | Lock expiry, handoff intents |
| `presence.test.ts` | 3 | Agent disconnect + removal timeouts |

### `extractContextFromEmail` heuristics tested

- Company extraction from subject ("Intro call with Sequoia Capital")
- Company extraction from body text
- Missing company → adds to `assumptions`
- Date + time parsing ("Mar 15 at 2:00 PM ET")
- Timezone detection
- Zoom/Meet/Teams link as `locationOrLink`
- Timebox detection (30/45/60 minutes)
- Fundraising goal detection ("seed raise" → "Fundraising intro")
- Diligence goal detection
- Missing date/time → added to `assumptions`

---

## Demo Script

**2-minute reliable demo:**

1. Open the Meeting Kit widget in ChatGPT (or Inspector at `http://localhost:3200/inspector`)
2. Click **Connect Gmail** → authenticate → select an investor meeting email
3. The Context Editor fills in automatically (company, date, attendees, goal)
4. Review/edit any fields → **Save Context**
5. Click **⚡ Generate Kit**
   - Agent Activity panel lights up with 7 agents working in parallel
   - Sections fill in one by one as agents complete
   - News/Thesis/Competitors show cited source links (if Serper key is set)
6. Review the completed Meeting Kit
7. Click **✉️ Create Gmail Draft** → draft is saved in Gmail → button becomes **📬 Open Draft in Gmail**
8. Click **📅 Create Calendar Event** → event appears in Google Calendar
9. To update a single section: click ↺ next to it

**Key talking points:**
- "This replaces 45 minutes of manual prep"
- "7 agents run in parallel — the kit fills in live as you watch"
- "Edit any field and re-run just the affected sections"
- "Sources are cited — every claim links back to a real web page"

---

## Phase Implementation Summary

| Phase | What was built | Files changed |
|---|---|---|
| 1 | Gmail OAuth (PKCE), `google_login`, `google_connection_status`, OAuth callback route, in-widget connect button | `google-integration.ts`, `http-routes.ts`, `server-mcpuse.ts` |
| 2 | `extract_meeting_context` (heuristic parser), `update_meeting_context`, editable Context Editor in widget, `MeetingContext` type | `meeting-prep.ts`, `types.ts`, `workspace.ts`, `server-mcpuse.ts` |
| 3 | `generate_meeting_kit` (7 parallel agents), `runAgentSection` helper, agent feed, section status, `MeetingKitState`, `get_meeting_kit` | `meeting-prep.ts`, `types.ts`, `workspace.ts`, `server-mcpuse.ts` |
| 4 | `mcp/tools/search.ts` (`searchWeb` + `isSearchAvailable`), Serper wired into News/Thesis/Competitors, `SearchSource` type, source links in widget | `search.ts`, `meeting-prep.ts`, `types.ts`, `server-mcpuse.ts`, `README.md` |
| 5 | `gmail_create_draft` (RFC 2822 → Gmail API), `draftId`/`draftWebLink` on state, widget "Create Gmail Draft" / "Open Draft in Gmail" button | `google-integration.ts`, `types.ts`, `workspace.ts`, `server-mcpuse.ts`, `http-routes.ts` |
| 6 | `rerun_meeting_kit` (per-section re-run), `"error"` status on sections, `cached?` field, ↺ re-run buttons, red error box, `error` CSS dot | `meeting-prep.ts`, `types.ts`, `server-mcpuse.ts`, `http-routes.ts` |
