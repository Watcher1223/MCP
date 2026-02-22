# MCP Apps Hackathon — Demo Script & Evaluation

**Feb 21st 2026 @ Y Combinator, SF | Manufact • mcp-use**

---

## Evaluation Criteria (Self-Score)

| Criteria | Points | Score | Notes |
|----------|--------|-------|-------|
| **Originality** | 30 | ★★★ | ChatGPT + Claude collaborating in ONE chat via MCP. "I didn't know you could build that." |
| **Real-World Usefulness** | 30 | ★★★ | Investor meeting prep: research company, draft reply, book meeting — real workflow |
| **Widget–Model Interaction** | 20 | ★★★ | useCallTool, sendFollowUpMessage, setState — dates/invitees save, calendar event creates |
| **User Experience & UI** | 10 | ★★ | Polished Meeting Kit, Agent feed, hackathon banner |
| **Production Readiness** | 10 | ★★★ | OAuth (Gmail + Calendar), no mock when configured |

---

## 2–3 Minute Demo Flow

### 1. Show Agents Sidebar (0:00–0:30)
- "Add Stigmergy to this chat"
- **Widget appears** with hackathon banner + Active Agents
- Point out: "This is the coordination layer — agents join here"

### 2. Check Real Email (0:30–0:45)
- "Check my email and show my inbox"
- **Command Center** loads real Gmail (OAuth connected)
- Pick an investor email

### 3. Meeting Kit + Widget Interactivity (0:45–1:15)
- "Prepare an investor meeting kit for [company from email]"
- **Meeting Kit** opens with hackathon banner
- **Edit fields**: Add date (e.g. 2026-02-27), add invitees (e.g. "Sarah Chen, Partner")
- Click **Save fields** → "Meeting fields saved"
- Click **Create Calendar Event** → pick date, time, Zoom → **Add to Calendar**
- Date/invitees persist (saved to context)

### 4. Claude + ChatGPT Collaboration (1:15–2:00)
- Click **Generate Kit** → agents spawn (News, Thesis, Competitors)
- **Agent feed** shows activity
- "Copy Claude Prompt" → open Claude → add same MCP server URL
- Paste prompt in Claude → Claude calls `join_workspace`, `poll_work`, `complete_work`
- **Both agents** (ChatGPT + Claude) work on the same Meeting Kit
- Point out: "Claude is researching in parallel — writing into the same kit ChatGPT is building"

### 5. Wrap (2:00–2:30)
- "Deep Research" for live market data
- "Create Gmail Draft" for reply
- "This is all real — real Gmail, real Calendar, real multi-agent collaboration"

---

## Key Talking Points

1. **Originality**: "Two different AI models — ChatGPT and Claude — collaborating inside one chat. They share state via MCP."
2. **Usefulness**: "Investor meeting prep: research the company, draft a reply, book the meeting. All in one flow."
3. **Widget–Model**: "I can edit dates and invitees in the widget — it saves. I can create a calendar event — it persists."
4. **No mock**: "We're using real OAuth. Real Gmail. Real Google Calendar."

---

## Do NOT

- Set `DEMO_MODE=1` — use real Gmail/Calendar
- Call `sync_context` — it loads mock data and overwrites real emails
- Skip the Claude collaboration — it's the novelty
