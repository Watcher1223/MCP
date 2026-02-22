# Synapse - Distributed Agent Collaboration

Real-time coordination for multiple AI agents. Connect ChatGPT, Claude, Cursor, and VSCode as collaborating teammates.

## Quick Start

```bash
npx skills add https://github.com/your-org/synapse --skill synapse
```

Then in ChatGPT, Claude, or any MCP client:

```
"Build a todo API with tests"
```

Watch as planner, coder, and tester agents coordinate automatically.

## What It Does

Synapse turns multiple AI agents into a coordinated team:

- **Planner** (ChatGPT/Claude): Decomposes tasks, reviews code, suggests improvements
- **Backend Coder** (Cursor): Implements APIs, database schemas, business logic
- **Frontend Coder** (VSCode): Builds UI, integrates endpoints, handles state
- **Tester**: Validates implementations, catches regressions

Agents coordinate through Synapse without human relay. When backend changes an API, frontend automatically adapts.

## Tools Available

| Tool | Description |
|------|-------------|
| `register_agent` | Join as a team member |
| `declare_intent` | Announce your planned work |
| `acquire_lock` | Lock a file before editing |
| `release_lock` | Release a file lock |
| `publish_update` | Notify others of your changes |
| `subscribe_changes` | Get real-time updates |
| `spawn_role_agent` | Create a specialized helper |
| `get_graph_state` | Visualize the collaboration |
| `react_to_change` | Automatically respond to changes |

## Widget

The `synapse-graph` widget renders a live animated graph:

- Agents appear as nodes (colored by role)
- Locks show as orange nodes
- Intents display current work
- Edges animate to show activity

## Demo Scenarios

### 1. Basic Collaboration

```
User: "Build a task manager"

→ Planner creates tasks
→ Backend implements endpoints
→ Frontend builds UI
→ Graph shows coordination
```

### 2. Breaking Change Recovery

```
Backend renames 'title' to 'name'
→ Synapse detects change
→ Frontend automatically updates
→ No human intervention needed
```

### 3. ChatGPT as PM

```
User: "Add due dates and prevent past deadlines"

→ Planner structures requirements
→ Backend adds validation
→ Frontend adds date picker
→ ChatGPT reviews result
```

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  ChatGPT    │     │   Cursor    │     │   VSCode    │
│  (Planner)  │     │  (Backend)  │     │  (Frontend) │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
                    ┌──────▼──────┐
                    │   Synapse   │
                    │   MCP Hub   │
                    └─────────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
         Intents        Locks        Events
```

## Local Development

```bash
cd synapse
npm install
npm run dev:mcp
```

Server starts on port 3200. Connect any MCP client.

## No Auth Required

For local development, no API keys needed. Agents auto-register on connection.

## Environment Detection

Synapse detects your environment:

- `chatgpt` / `browser` → Planner role
- `cursor` → Backend Coder role
- `vscode` → Frontend Coder role
- `test` → Tester role

## Implementation Reference

**Server**: `/mcp/server.ts`
**Widget**: `/mcp/resources/synapse-graph.tsx`
**Hub Logic**: `/hub/src/state.ts`

---

Built for the AI agent era. Where coordination happens automatically.
