# Synapse Realtime Co-Editing MVP

Status: **Implemented** (steps 1-5 complete in `mcp/server-mcpuse.ts`)

---

## Architecture

All co-editing lives in a single process alongside the MCP server:

```
mcp/server-mcpuse.ts
├── MCP Server              :3200   (tools for ChatGPT, Claude, Cursor)
├── Express HTTP + Dashboard :3201   (REST API + dashboard UI)
├── WS /collab              :3201   (Yjs sync + awareness)
└── DocSessionManager                (in-memory Yjs doc sessions)
```

Agents interact via MCP tools (create_doc, lock_file, etc.) or WebSocket for realtime editing.

---

## MCP Tools (20 total)

### Co-editing tools

| Tool | Schema | Description |
|------|--------|-------------|
| `create_doc` | `{ path, initial_content? }` | Create a Yjs doc session (idempotent). Returns `collab_url`. |
| `list_sessions` | `{}` | List active sessions with editors, update count, last activity. |
| `get_doc_content` | `{ path }` | Plain-text snapshot for non-WS agents (e.g. ChatGPT). |

### Lock tools (TTL-based)

| Tool | Schema | Description |
|------|--------|-------------|
| `lock_file` | `{ path, reason?, ttl? }` | Exclusive lock with 2-min default TTL. Expired locks are auto-reclaimed. |
| `unlock_file` | `{ path, handoff_to?, message? }` | Release lock, optionally hand off to a role with a message. |
| `check_locks` | `{}` | Show all locks with holder identity, reason, and time remaining. |
| `renew_lock` | `{ path, ttl? }` | Extend TTL. Only the holder can renew. |

### Coordination tools

| Tool | Description |
|------|-------------|
| `join_workspace` | Register an agent (name, client, role). |
| `set_target` | Set workspace goal + queue backend/frontend work items. |
| `poll_work` | Find available work for a role. Auto-assigns if autonomous. |
| `claim_work` | Explicitly claim a work item by ID. |
| `complete_work` | Mark work done, trigger handoff to next role. |
| `post_intent` | Post a status update (working/completed/blocked/handoff). |
| `read_intents` | Read recent intent history. |
| `get_context` | Full workspace snapshot. |
| `subscribe_changes` | Poll for changes since a version number. |
| `list_agents` | List connected agents. |
| `get_target` | Get current workspace target. |
| `get_graph` / `get_graph_widget` | Dashboard visualization data. |

---

## WebSocket Protocol (`ws://localhost:3201/collab`)

### Connection flow

1. Agent calls `create_doc` MCP tool (explicit creation required).
2. Agent opens WS to `/collab`.
3. Agent sends `join` message.
4. Server responds with `sync` (full Yjs state) + `awareness` (editor list).
5. Client sends binary Yjs updates; server broadcasts to all other clients.
6. Client sends `awareness` messages for cursor/typing state.
7. On disconnect, server cleans up awareness and broadcasts updated editor list.

### Message types

**Client to server (JSON):**

```json
{ "type": "join", "path": "src/auth.ts", "agentId": "...", "name": "Claude", "role": "backend", "environment": "terminal" }
{ "type": "awareness", "cursor": { "anchor": 42, "head": 42 }, "isTyping": true }
{ "type": "leave" }
```

**Server to client (JSON):**

```json
{ "type": "sync", "snapshot": [/* Yjs state as number array */] }
{ "type": "awareness", "updatedBy": "agent-id", "editors": [{ "name": "...", "role": "...", "environment": "...", "color": "#3b82f6" }] }
{ "type": "sessions", "sessions": [{ "path": "...", "editors": [...], "updateCount": 5 }] }
{ "type": "error", "message": "Doc not found: src/auth.ts. Call create_doc first." }
```

**Binary (both directions):** Raw Yjs updates (`Uint8Array`), applied to the shared `Y.Doc` and broadcast.

---

## Lock System

### Design

Locks are **coordination signals** (not the primary concurrency mechanism -- Yjs handles that).

- **TTL-based**: default 2 minutes, configurable per lock.
- **Auto-expiry**: cleanup runs every 5 seconds. Expired locks emit a handoff intent.
- **Reclaim on expire**: if an agent tries to lock a path held by an expired lock, it takes over.
- **Renewal**: holders call `renew_lock` to extend (heartbeat pattern).

### FileLock fields

```typescript
interface FileLock {
  path: string;
  agentId: string;
  agentName: string;
  client: string;       // "chatgpt" | "claude" | "cursor" | "vscode" | "terminal"
  role: string;         // "planner" | "backend" | "frontend" | "tester" | "any"
  lockedAt: number;
  expiresAt: number;    // lockedAt + ttl
  reason?: string;
}
```

### Demo flow ("Relentless Handoff")

1. **ChatGPT** calls `set_target("Login")` -- queues backend + frontend work.
2. **Claude** calls `poll_work("backend")` -- auto-assigned. Calls `lock_file("src/auth.ts")`.
3. **Cursor** calls `check_locks` -- sees "LOCKED by Claude Backend (terminal, backend). Expires in 110s."
4. **Claude** finishes, calls `unlock_file("src/auth.ts", handoff_to: "frontend", message: "API ready at /login")`.
5. **Cursor** calls `check_locks` -- lock gone. Calls `poll_work("frontend")` -- picks up with API context.

---

## HTTP Endpoints (port 3201)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Dashboard UI (auto-refreshes every 3s) |
| `/health` | GET | `{ status, agents, locks, docSessions, version }` |
| `/api/graph?format=widget` | GET | Widget-format graph data (agents, locks, intents, docSessions) |
| `/api/graph` | GET | Raw graph nodes + edges |
| `/api/state` | GET | Full workspace state |
| `/api/sessions` | GET | Active doc sessions list |
| `/api/changes?since=N` | GET | Poll for workspace changes since version N |
| `/mcp/execute` | POST | Demo tool execution (`{ tool, arguments, clientId }`) |
| `/collab` | WS | Yjs co-editing WebSocket endpoint |

---

## DocSessionManager

In-memory manager keyed by file path. Each session holds:

- `Y.Doc` with a `Y.Text("content")` for the file body
- Awareness map: per-agent `{ name, role, environment, color, cursor, isTyping }`
- Connected WS clients set
- Timestamps and update counter

### Lifecycle

- **Create**: `docManager.create(path, initialContent?)` -- idempotent.
- **Join**: WS client sends `join` message. Fails if doc doesn't exist.
- **Edit**: Binary Yjs updates applied + broadcast to peers.
- **Leave**: WS close or explicit `leave`. Awareness cleaned up.
- **Cleanup**: Empty sessions removed after 60 seconds of inactivity.
- **Colors**: deterministic hash of agentId into an 8-color palette.

---

## Non-goals (MVP)

- Horizontal scaling / multi-region
- Durable persistence of Yjs state
- Full repo-wide file syncing
- Range locks / symbol locks (future improvement)
- Perfect semantic diffing across languages
