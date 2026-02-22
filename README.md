# Stigmergy

**ChatGPT + Claude collaborating in one chat. Real Gmail. Real Calendar. Investor meeting prep — end to end.**

MCP Apps Hackathon • Feb 21st 2026 @ Y Combinator, SF • Manufact • mcp-use

---

## What We Built (At a Glance)

**Stigmergy** is an MCP server that lets ChatGPT and Claude work together on the same task. You chat in ChatGPT, and widgets appear. You interact with them. Both AI models share state via MCP — no handoffs, no copy-paste.

** demo:** Investor meeting prep. Check email → pick a contact → prepare a meeting kit → book it on your calendar → draft a reply. All from chat. Claude can join and research News, Thesis, and Competitors in parallel while ChatGPT builds the kit.

---

## Demo: Full User Journey

### 1. Chat prompt → Widget appears

```
"Add Stigmergy to this chat"
```

```
"Check my email and show my inbox"
```

→ **Command Center** loads your real Gmail inbox (OAuth). You see emails with Archive, Star, Prep Meeting buttons.

### 2. Interact with the widget

- Click **Prep Meeting** on an email → Meeting Kit opens
- Edit date, invitees, goal → Click **Save fields**
- Click **Check Availability** → See your calendar
- Click **Create Calendar Event** → Add meeting to Google Calendar
- Click **Generate Kit** → Agents research News, Thesis, Competitors
- Click **Create Gmail Draft** → Reply draft in Gmail

### 3. ChatGPT + Claude collaborating

- Click **Copy Claude Prompt** in the Meeting Kit
- Add Stigmergy to Claude Desktop (same MCP URL)
- Paste the prompt in Claude → Claude calls `join_workspace`, `poll_work`, `update_meeting_section`
- **Both agents** write into the same Meeting Kit. Claude researches. ChatGPT orchestrates.

---

## Why It Matters

| Problem | Stigmergy |
|--------|-----------|
| Claude doesn't know what ChatGPT did | Shared workspace via MCP — both read/write the same Meeting Kit |
| "Check my email" → AI says "I can't" | Real Gmail OAuth. Real inbox. Real calendar. |
| Widgets are static | Buttons call tools: Check Email, Load Calendar, Prep Meeting, Add to Calendar |

---

## Quick Start

```bash
npm install
npm run mcp
```

**Add to ChatGPT:** Use the Stigmergy MCP connector (deployed at `https://shiny-credit-ak9lb.run.mcp-use.com/mcp` or deploy your own with `mcp-use deploy`).

**Add to Claude Desktop:** Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "stigmergy": {
      "url": "https://shiny-credit-ak9lb.run.mcp-use.com/mcp",
      "transport": "http"
    }
  }
}
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLIENT_ID` | For Gmail/Calendar | Google OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | For Gmail/Calendar | Google OAuth 2.0 client secret |
| `GOOGLE_REDIRECT_URI` | For Gmail/Calendar | OAuth callback (e.g. `https://your-host/auth/google/callback`) |
| `SERPER_API_KEY` | Optional | Live web search for Meeting Kit (News/Thesis/Competitors) |
| `SYNAPSE_DASHBOARD_URL` | For hosted deploys | Base URL of your deployed MCP server |

---

## Widgets

| Widget | Trigger | What it does |
|--------|---------|--------------|
| **Agents Sidebar** | "Add Stigmergy" / `stigmergy-dashboard` | Shows active agents, coordination state |
| **Command Center** | "Check email" / "Load inbox" | Inbox, calendar, email actions (Archive, Star, Prep Meeting) |
| **Meeting Kit** | "Prepare meeting kit for [company]" | Meeting context, sections, Generate Kit, Add to Calendar, Gmail Draft |

---

## Demo Video

*Walk us through: chat prompt → widget appearing → interacting with the widget. Keep it short and punchy — this is your pitch!*

---

## Tech Stack

- **mcp-use** SDK — MCP server, widgets, `useCallTool`, `sendFollowUpMessage`
- **Google OAuth** — Gmail + Calendar (no mock when configured)
- **Serper** — Live web search for Meeting Kit research
- **Deployed** — Manufact / mcp-use cloud

---

## One-Liner

**"Two AI models in one chat. Real email. Real calendar. Investor meeting prep from prompt to booked meeting."**

---

MIT License
