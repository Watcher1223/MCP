# SYNAPSE

## Shared Cognition for AI Agents

> What if every AI tool you use shared the same brain?

**MCP Apps Hackathon @ Y Combinator, Feb 21 2025**

---

## Quick Start

```bash
# Install
npm install

# Start the server
npm run mcp

# Open the dashboard (in browser)
open http://localhost:3201/

# Test the ChatGPT widget (Inspector)
open http://localhost:3200/inspector
# Then invoke the "synapse-dashboard" tool to see agents, locks, and activity

# Run the Relentless Handoff demo (in another terminal)
./demo/relentless-handoff.sh
```

### ChatGPT / MCP Inspector Widget

The **synapse-dashboard** widget surfaces Synapse state (target, agents, locks, recent activity) in ChatGPT and the MCP Inspector. When connected to Synapse, ask the AI to "show Synapse status" or invoke the `synapse-dashboard` tool.

### Connect to Synapse

```bash
# Connect this environment (Cursor/Claude/Terminal) to Synapse hub
npx synapse connect
# or
npm run connect
```

### Deploy to MCP Cloud

```bash
mcp-use login
mcp-use deploy
```

Set `SYNAPSE_DASHBOARD_URL` to your deployed API URL so the widget fetches from the correct origin (e.g. `https://your-app.manufact.dev`).

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` | For Gmail OAuth | Google OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | For Gmail OAuth | Google OAuth 2.0 client secret |
| `GOOGLE_REDIRECT_URI` | For Gmail OAuth | OAuth callback URL (e.g. `http://localhost:3200/auth/google/callback`) |
| `SERPER_API_KEY` | Optional | Enables live web search in Meeting Kit (News / Thesis / Competitors). Get one at [serper.dev](https://serper.dev). Without it, sections fall back to static placeholder bullets. |
| `SYNAPSE_DASHBOARD_URL` | For hosted deploys | Base URL of your deployed MCP server |

## The Problem

Today, AI tools are isolated:
- Claude doesn't know what Cursor just did
- ChatGPT can't see your test results
- Every agent operates blind

## The Solution

**Synapse** provides a shared cognition layer:

1. **Shared World State** - A structured belief graph all agents read/write
2. **Convergence Engine** - Goals auto-evaluate, work auto-assigns
3. **Autonomous Coordination** - One goal in, multiple agents act, zero babysitting

## Watch the Demo

1. Three AI agents connect (Planner, Coder, Tester)
2. You propose ONE goal: "Build a todo API with tests"
3. Without any additional prompts:
   - Planner decomposes the task
   - Coder implements endpoints
   - Tester writes and runs tests
4. Goal turns green: **SATISFIED**

**No babysitting. No prompt chaining. Autonomous coordination.**

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      SYNAPSE SERVER                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │ World State │  │ Convergence │  │ Work Queue          │ │
│  │ (beliefs)   │←→│ Engine      │←→│ (role-based)        │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
└────────────────────────┬────────────────────────────────────┘
                         │ MCP Protocol
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
   ┌─────────┐     ┌─────────┐      ┌─────────┐
   │ ChatGPT │     │ Claude  │      │ Cursor  │
   │ Client  │     │ Desktop │      │ IDE     │
   └─────────┘     └─────────┘      └─────────┘
```

## MCP Tools (21 total)

### Coordination
| Tool | Description |
|------|-------------|
| `register_agent` | Join the workspace |
| `declare_intent` | Announce planned work |
| `acquire_lock` / `release_lock` | Prevent conflicts |
| `publish_update` | Broadcast changes |

### World State
| Tool | Description |
|------|-------------|
| `read_world_state` | See shared reality |
| `update_world_state` | Modify shared reality |
| `assert_fact` | Add beliefs with confidence |
| `report_failure` | Trigger automatic fixes |

### Goals
| Tool | Description |
|------|-------------|
| `propose_goal` | Start autonomous work chain |
| `evaluate_goal` | Check goal satisfaction |
| `assign_work` | Get next task for your role |
| `complete_work` | Mark work done |

## Why MCP?

MCP is the USB of AI. 800M+ users across ChatGPT, Claude, Cursor, and VS Code. Synapse is the hub they all plug into.

## Connect Any MCP Client

**Claude Desktop** - Add to config:
```json
{
  "mcpServers": {
    "synapse": {
      "command": "node",
      "args": ["/path/to/synapse/dist/mcp/server.js"]
    }
  }
}
```

**Cursor/VS Code** - Point MCP extension to `http://localhost:3200/mcp`

## Files

```
synapse/
├── mcp/
│   ├── server.ts       # Main MCP server + widget
│   ├── world-state.ts  # Shared cognition runtime
│   └── index.ts        # Module exports
├── demo/
│   ├── PITCH.md        # 3-minute pitch script
│   ├── run-demo.sh     # Interactive demo
│   └── instant-demo.sh # Quick demo
├── hub/                # Core coordination server
├── shared/             # Shared types
└── README.md
```

## The One-Liner

**"Synapse is the shared brain for AI agents. One goal in, coordinated work out, zero babysitting."**

---

MIT License
