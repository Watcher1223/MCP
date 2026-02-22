# Synapse Demo — Gap Analysis

## Vision Checklist vs. Current State

| Requirement | Status | Notes |
|-------------|--------|-------|
| **Shared context in real time** | ✅ Done | MCP tools + SSE push + WS /collab. Dashboard updates instantly. |
| **Message Board (agents post what they're working on)** | ✅ Done | `post_intent` tool. Dashboard activity feed shows all intents. |
| **Create workspace + invite agents** | ⚠️ MVP | Single global workspace. `join_workspace` registers agents. No invite links. |
| **Notify agents writing files / no collisions (lock system)** | ✅ Done | `lock_file` / `unlock_file` / `renew_lock` / `check_locks`. TTL-based with auto-expiry. |
| **Ping frontend when backend finishes (handoff)** | ✅ Done | `complete_work` + `unlock_file(handoff_to)` emits handoff intent. `subscribe_changes` / SSE for detection. |
| **Remove setup friction** | ⚠️ Partial | `npm run mcp` starts everything. ChatGPT needs Custom GPT + Actions config. |
| **Dashboard with agents communicating** | ✅ Done | Real-time SSE push. Shows agents, locks (with expiry), doc sessions, activity. |

---

## Killer Demo: "The Relentless Handoff"

> ChatGPT sets target -> Claude locks & builds -> Cursor sees lock -> Claude unlocks with handoff -> Cursor picks up

| Step | Status | Tool |
|------|--------|------|
| ChatGPT proposes "Login page" | ✅ | `set_target` |
| Claude joins, polls backend work | ✅ | `join_workspace` + `poll_work` |
| Claude locks auth.ts | ✅ | `lock_file` (TTL, reason, role) |
| Dashboard shows "LOCKED BY CLAUDE (terminal, backend)" | ✅ | SSE push + dashboard UI |
| Claude completes, unlocks, hands off to frontend | ✅ | `complete_work` + `unlock_file(handoff_to, message)` |
| Cursor joins, polls frontend work | ✅ | `join_workspace` + `poll_work` |
| Cursor picks up with API context from Claude | ✅ | Work item includes `handoff_context` |

### Co-editing overlay

| Step | Status | Tool |
|------|--------|------|
| Agent creates doc session | ✅ | `create_doc` |
| Multiple agents edit same file in real time | ✅ | WS `/collab` + Yjs sync |
| Dashboard shows active editors with colors | ✅ | `list_sessions` / SSE push |
| Non-WS agent reads doc content | ✅ | `get_doc_content` |

---

## Implementation Status

### P0 — Demo Blockers (all done)

1. ~~Intent posting~~ -> `post_intent` (working/completed/blocked/handoff)
2. ~~Lock tools~~ -> `lock_file` / `unlock_file` / `renew_lock` / `check_locks` (TTL + auto-expiry)
3. ~~Event subscription~~ -> `subscribe_changes` + SSE `/api/events/stream`
4. ~~Co-editing~~ -> `create_doc` + WS `/collab` (Yjs) + `get_doc_content`

### P1 — Done

5. ~~Real-time dashboard~~ -> SSE push (instant updates on every state change)
6. ~~WS reliability~~ -> ping/pong heartbeat every 30s

### P2 — Future

7. Workspace creation + invite links
8. Cursor/VS Code extension (sidebar lock UI)
9. One-click connect (hosted Synapse + pre-built Custom GPT)

---

## Current Tool Inventory (20 tools)

**Coordination**: `join_workspace`, `list_agents`, `set_target`, `get_target`, `poll_work`, `claim_work`, `complete_work`, `post_intent`, `read_intents`, `get_context`, `subscribe_changes`

**Locks**: `lock_file`, `unlock_file`, `check_locks`, `renew_lock`

**Co-editing**: `create_doc`, `list_sessions`, `get_doc_content`

**Dashboard**: `get_graph`, `get_graph_widget`
