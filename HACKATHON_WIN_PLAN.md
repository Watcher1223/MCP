# MCP Apps Hackathon 2026 — Win Plan

## ✅ What You Already Have (Mandatory Rules)

| Rule | Status | Notes |
|------|--------|------|
| MCP App format | ✅ | War Room, Mission Control, Command Center, Dashboard widgets |
| mcp-use SDK | ✅ | server.uiResource, tools, resources |
| Deployed on Manufact | ✅ | https://shiny-credit-ak9lb.run.mcp-use.com/mcp |
| Demo on ChatGPT | ✅ | Add connector, use + button |

---

## 📊 Score Maximization (100 pts)

### 1. Originality (30 pts) — PRIMARY

**Current:** Multi-agent coordination (ChatGPT + Claude + Cursor) sharing a workspace is novel.

**To strengthen:**
- **Demo hook:** "I didn't know you could build that" — show agents coordinating in real time across different clients.
- **Unique angle:** "Stigmergy" = ants leaving pheromone trails. No one else is building a shared cognition layer for multi-agent coordination.
- **Punch line:** "One goal in, three agents act, zero babysitting."

**Action:** Nail the 2–3 min pitch. Lead with the "wow" — agents coordinating autonomously.

---

### 2. Real-World Usefulness (30 pts) — PRIMARY

**Current:** Dev teams with multiple AI tools (ChatGPT, Claude, Cursor) waste time context-switching.

**To strengthen:**
- **Concrete scenario:** "Build a login page" → Planner sets target → Backend implements API → Frontend builds UI → Tester runs tests. All without hand-holding.
- **Pain point:** "Today, Claude doesn't know what Cursor just did. Stigmergy fixes that."

**Action:** Demo a real workflow. Show the War Room, Mission Control, or Command Center with live agents.

---

### 3. Widget–Model Interaction (20 pts) — MEDIUM

**Current:** You have `useCallTool`, `sendFollowUpMessage`, `setState` in the HTML widgets.

**Criteria:** "Bidirectional communication between widget and AI model."

**Verify you're using:**
- `useCallTool()` — Widget calls server tools ✅ (Command Center, War Room, Mission Control)
- `sendFollowUpMessage()` — Widget sends message back to model ✅
- `state()` / `setState()` — Shared state between widget and model ✅

**Action:** In the demo, explicitly show: "When I click Approve in the widget, it calls the tool and the model gets a follow-up message." Make the interaction visible.

---

### 4. User Experience & UI (10 pts) — LOW

**Current:** War Room, Mission Control, Command Center have polished dark themes.

**Action:** Polish one widget as the "hero" — ensure it looks crisp on stage. Check mobile layout if judges demo on phone.

---

### 5. Production Readiness (10 pts) — LOW

**Current:** No OAuth. Onboarding flow could be clearer.

**Action:** 
- Add a simple "Connect to Stigmergy" onboarding message in the widget.
- Or: Add a `join_workspace` prompt when the user first opens the widget — "Enter your name to join the workspace."

---

## ⚠️ Async Evaluation at 5 PM

**Judges score before demos.** Your app must be:

1. **Deployed** — https://shiny-credit-ak9lb.run.mcp-use.com/mcp
2. **Working** — ChatGPT connector loads, tools respond, widgets render
3. **Documented** — README or landing explains what it does

**Action:** Deploy latest by 4:30 PM. Test the full flow in ChatGPT before 5 PM.

---

## 🎯 Demo Script (2–3 min)

1. **Hook (15 sec):** "What if every AI tool you use shared the same brain?"
2. **Problem (20 sec):** "Today, Claude doesn't know what Cursor did. ChatGPT can't see your tests. Every agent operates blind."
3. **Solution (30 sec):** "Stigmergy is a shared cognition layer. I set one goal: 'Build a login page.'" [Show set_target or Mission Control]
4. **Live demo (60 sec):** "Watch — the planner decomposes, the backend implements, the frontend builds. All in parallel. No hand-holding." [Show War Room or Command Center with agents]
5. **Widget interaction (20 sec):** "When I approve a request in the widget, the model gets notified. Full bidirectional flow." [Click approve, show follow-up]
6. **Close (15 sec):** "One goal in. Coordinated work out. Zero babysitting. Stigmergy."

---

## 📁 Project Structure Check

Hackathon template: `resources/[widget]/widget.tsx`

You have: `htmlTemplate` in server-uiResource (valid for mcpApps)

**Both work.** The mcp-use SDK supports `htmlTemplate`, `externalUrl`, and `remoteDom`. Your setup is valid.

---

## Checklist Before 5 PM

- [ ] Latest code pushed to GitHub
- [ ] `npx mcp-use deploy` successful
- [ ] ChatGPT connector works (add Stigmergy, use + button)
- [ ] At least one widget renders (War Room, Mission Control, or Command Center)
- [ ] Widget button → useCallTool → model responds (test approve/reject or similar)
- [ ] README or demo page explains the flow

---

## Quick Wins

1. **Add the AI Builder Skill** (for future dev): `npx skills add https://github.com/mcp-use/mcp-use --skill mcp-apps-builder`
2. **Test in Inspector** before ChatGPT: `npm run mcp` → `http://localhost:3000/inspector`
3. **Prepare a backup** — if live demo fails, have a 30-second screen recording ready.
