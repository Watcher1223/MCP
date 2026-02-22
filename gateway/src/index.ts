// Synapse Gateway Server
// Main entry point for all connections - WebSocket, HTTP, and SSE

import { WebSocketServer, WebSocket } from 'ws';
import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { createHash, randomBytes } from 'crypto';
import cors from 'cors';
import Database, { Agent, SynapseEvent } from '../../persistence/src/index.js';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Database connection
const db = new Database();

// Connected clients
interface ConnectedClient {
  ws: WebSocket;
  workspaceId: string;
  agent: Agent;
  subscriptions: Set<string>;
}

const clients = new Map<string, ConnectedClient>();

// Middleware
app.use(cors());
app.use(express.json());

// Auth middleware
async function authenticate(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'] as string || req.query.apiKey as string;
  const sessionToken = req.headers['x-session-token'] as string;

  if (sessionToken) {
    const agent = await db.getAgentBySession(sessionToken);
    if (agent) {
      (req as any).workspaceId = agent.workspaceId;
      (req as any).agent = agent;
      return next();
    }
  }

  if (apiKey) {
    const workspace = await db.getWorkspaceByApiKey(apiKey);
    if (workspace) {
      (req as any).workspaceId = workspace.id;
      (req as any).workspace = workspace;
      return next();
    }
  }

  res.status(401).json({ error: 'Unauthorized' });
}

// ================================================
// REST API Routes
// ================================================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0', timestamp: Date.now() });
});

// Install script
app.get('/install.sh', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send(`#!/bin/bash
# Synapse Install Script
# Usage: curl -fsSL https://synapse.clodhost.com/install.sh | bash

set -e

SYNAPSE_VERSION="2.0.0"
SYNAPSE_HUB="\${SYNAPSE_HUB:-wss://synapse.clodhost.com}"

echo ""
echo "🧠 Installing Synapse v\${SYNAPSE_VERSION}..."
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is required but not installed."
    echo "Install Node.js 18+ from: https://nodejs.org/"
    exit 1
fi

NODE_VERSION=\$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "\$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js 18+ is required. Found: \$(node -v)"
    exit 1
fi

echo "📦 Running Synapse connect..."
echo ""

# Create config directory
mkdir -p ~/.synapse

# Use npx to run synapse connect
npx --yes synapse@latest connect "\$@"

echo ""
echo "✅ Synapse connected!"
echo ""
echo "Commands:"
echo "  npx synapse status    - Check connection status"
echo "  npx synapse agents    - List all agents"
echo "  npx synapse daemon    - Run as background service"
echo ""
echo "Dashboard: https://synapse.clodhost.com"
echo ""
`);
});

// Create workspace (public endpoint for onboarding)
app.post('/api/workspace', async (req, res) => {
  try {
    const { name, slug } = req.body;
    if (!name || !slug) {
      return res.status(400).json({ error: 'Name and slug required' });
    }

    const existing = await db.getWorkspaceBySlug(slug);
    if (existing) {
      return res.status(409).json({ error: 'Workspace slug already exists' });
    }

    const { workspace, apiKey } = await db.createWorkspace(name, slug);
    res.json({ workspace, apiKey });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Quick connect endpoint - generates workspace if needed
app.post('/api/connect', async (req, res) => {
  try {
    const { environment, name, role, capabilities, workspaceSlug } = req.body;

    // Get or create workspace
    let workspace = workspaceSlug ? await db.getWorkspaceBySlug(workspaceSlug) : null;
    let apiKey: string | undefined;

    if (!workspace) {
      const slug = workspaceSlug || `ws-${randomBytes(4).toString('hex')}`;
      const result = await db.createWorkspace(`Workspace ${slug}`, slug);
      workspace = result.workspace;
      apiKey = result.apiKey;
    }

    // Generate agent identity
    const externalId = `${environment}-${randomBytes(4).toString('hex')}`;
    const agent = await db.upsertAgent(workspace.id, {
      externalId,
      name: name || `${environment}-agent`,
      role: role || detectRole(environment),
      type: 'realtime',
      environment,
      capabilities: capabilities || detectCapabilities(environment)
    });

    res.json({
      success: true,
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      apiKey, // Only returned for new workspaces
      agentId: agent.id,
      sessionToken: agent.sessionToken,
      hubUrl: `wss://${req.get('host')}`
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Get blueprint (authenticated)
app.get('/api/blueprint', authenticate, async (req, res) => {
  try {
    const workspaceId = (req as any).workspaceId;
    const blueprint = await db.getBlueprint(workspaceId);
    res.json(blueprint);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Get agents
app.get('/api/agents', authenticate, async (req, res) => {
  try {
    const workspaceId = (req as any).workspaceId;
    const agents = await db.getAllAgents(workspaceId);
    res.json({ agents });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Update agent
app.patch('/api/agents/:agentId', authenticate, async (req, res) => {
  try {
    const workspaceId = (req as any).workspaceId;
    const agentId = req.params.agentId as string;
    const { name, role, subscriptions, capabilities } = req.body;

    const agent = await db.updateAgent(workspaceId, agentId, {
      name, role, subscriptions, capabilities
    });

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Broadcast update
    broadcastToWorkspace(workspaceId, {
      type: 'agent_updated',
      agent
    });

    res.json({ agent });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Create intent
app.post('/api/intent', authenticate, async (req, res) => {
  try {
    const workspaceId = (req as any).workspaceId;
    const agent = (req as any).agent;

    if (!agent) {
      return res.status(400).json({ error: 'Session token required for intents' });
    }

    const { action, description, targets, concepts, priority } = req.body;
    const intent = await db.createIntent(workspaceId, agent.id, {
      action, description, targets, concepts, priority
    });

    // Broadcast to workspace
    broadcastToWorkspace(workspaceId, {
      type: 'intent_broadcast',
      intent
    });

    res.json({ intent });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Update intent
app.patch('/api/intent/:intentId', authenticate, async (req, res) => {
  try {
    const workspaceId = (req as any).workspaceId;
    const intentId = req.params.intentId as string;
    const { status, result } = req.body;

    const intent = await db.updateIntent(workspaceId, intentId, { status, result });

    if (!intent) {
      return res.status(404).json({ error: 'Intent not found' });
    }

    broadcastToWorkspace(workspaceId, {
      type: `intent_${status}`,
      intent
    });

    res.json({ intent });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Request lock
app.post('/api/lock', authenticate, async (req, res) => {
  try {
    const workspaceId = (req as any).workspaceId;
    const agent = (req as any).agent;

    if (!agent) {
      return res.status(400).json({ error: 'Session token required for locks' });
    }

    const { target, ttl, intentId } = req.body;
    const result = await db.acquireLock(workspaceId, agent.id, target, ttl, intentId);

    if (result.success) {
      broadcastToWorkspace(workspaceId, {
        type: 'lock_acquired',
        lockId: result.lockId,
        agentId: agent.id,
        target
      });
    }

    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Release lock
app.delete('/api/lock/:lockId', authenticate, async (req, res) => {
  try {
    const workspaceId = (req as any).workspaceId;
    const agent = (req as any).agent;
    const lockId = req.params.lockId as string;

    if (!agent) {
      return res.status(400).json({ error: 'Session token required' });
    }

    const released = await db.releaseLock(workspaceId, lockId, agent.id);

    if (released) {
      broadcastToWorkspace(workspaceId, {
        type: 'lock_released',
        lockId,
        agentId: agent.id
      });
    }

    res.json({ success: released });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// File operations
app.post('/api/file', authenticate, async (req, res) => {
  try {
    const workspaceId = (req as any).workspaceId;
    const agent = (req as any).agent;
    const { path, content } = req.body;

    if (!agent) {
      return res.status(400).json({ error: 'Session token required' });
    }

    const file = await db.upsertFile(workspaceId, agent.id, path, content);

    broadcastToWorkspace(workspaceId, {
      type: 'file_modified',
      path,
      version: file.version,
      checksum: file.checksum,
      agentId: agent.id
    });

    res.json({ file });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/file', authenticate, async (req, res) => {
  try {
    const workspaceId = (req as any).workspaceId;
    const path = req.query.path as string;

    if (!path) {
      return res.status(400).json({ error: 'Path required' });
    }

    const file = await db.getFile(workspaceId, path);
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.json({ file });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Events (polling for stateless agents)
app.get('/api/events', authenticate, async (req, res) => {
  try {
    const workspaceId = (req as any).workspaceId;
    const since = parseInt(req.query.since as string) || 0;
    const limit = parseInt(req.query.limit as string) || 100;

    const events = await db.getEventsSince(workspaceId, since, limit);
    const blueprint = await db.getBlueprint(workspaceId);

    res.json({
      events,
      cursor: blueprint.cursor
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Create reaction (automatic task trigger)
app.post('/api/reaction', authenticate, async (req, res) => {
  try {
    const workspaceId = (req as any).workspaceId;
    const agent = (req as any).agent;

    if (!agent) {
      return res.status(400).json({ error: 'Session token required' });
    }

    const { triggerConcepts, triggerEventTypes, actionType, actionConfig, priority } = req.body;
    const reaction = await db.createReaction(workspaceId, agent.id, {
      triggerConcepts, triggerEventTypes, actionType, actionConfig, priority
    });

    res.json({ reaction });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// SSE endpoint for real-time updates (alternative to WebSocket)
app.get('/api/stream', authenticate, (req, res) => {
  const workspaceId = (req as any).workspaceId;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const clientId = randomBytes(8).toString('hex');

  // Send initial state
  db.getBlueprint(workspaceId).then(blueprint => {
    res.write(`data: ${JSON.stringify({ type: 'blueprint', ...blueprint })}\n\n`);
  });

  // Listen for events
  const handler = (event: { workspaceId: string; type: string; data: any }) => {
    if (event.workspaceId === workspaceId) {
      res.write(`data: ${JSON.stringify({ type: event.type, ...event.data })}\n\n`);
    }
  };

  db.on('event', handler);

  req.on('close', () => {
    db.off('event', handler);
  });
});

// ================================================
// WebSocket Handling
// ================================================

wss.on('connection', async (ws, req) => {
  let client: ConnectedClient | null = null;

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      await handleWebSocketMessage(ws, message, client, (c) => { client = c; });
    } catch (e: any) {
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  });

  ws.on('close', async () => {
    if (client) {
      clients.delete(client.agent.id);
      await db.setAgentOffline(client.workspaceId, client.agent.id);
      broadcastToWorkspace(client.workspaceId, {
        type: 'agent_disconnected',
        agentId: client.agent.id
      });
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

async function handleWebSocketMessage(
  ws: WebSocket,
  message: any,
  client: ConnectedClient | null,
  setClient: (c: ConnectedClient) => void
) {
  switch (message.type) {
    case 'connect': {
      // Quick connect via WebSocket
      const { sessionToken, apiKey, environment, name, role, capabilities, workspaceSlug } = message;

      let agent: Agent | null = null;
      let workspaceId: string;

      if (sessionToken) {
        agent = await db.getAgentBySession(sessionToken);
        if (agent) {
          workspaceId = agent.workspaceId;
          // Update online status
          await db.updateAgent(workspaceId, agent.id, { isOnline: true });
        }
      }

      if (!agent && apiKey) {
        const workspace = await db.getWorkspaceByApiKey(apiKey);
        if (workspace) {
          workspaceId = workspace.id;
          const externalId = `${environment}-${randomBytes(4).toString('hex')}`;
          agent = await db.upsertAgent(workspaceId!, {
            externalId,
            name: name || `${environment}-agent`,
            role: role || detectRole(environment),
            type: 'realtime',
            environment,
            capabilities: capabilities || detectCapabilities(environment)
          });
        }
      }

      if (!agent) {
        ws.send(JSON.stringify({ type: 'error', code: 'AUTH_FAILED', message: 'Invalid credentials' }));
        ws.close();
        return;
      }

      const newClient: ConnectedClient = {
        ws,
        workspaceId: agent.workspaceId,
        agent,
        subscriptions: new Set(['*'])
      };

      clients.set(agent.id, newClient);
      setClient(newClient);

      // Send connection confirmation with blueprint
      const blueprint = await db.getBlueprint(agent.workspaceId);
      ws.send(JSON.stringify({
        type: 'connected',
        agent,
        sessionToken: agent.sessionToken,
        blueprint
      }));

      // Broadcast to others
      broadcastToWorkspace(agent.workspaceId, {
        type: 'agent_connected',
        agent
      }, agent.id);

      break;
    }

    case 'intent': {
      if (!client) return;

      const { action, description, targets, concepts, priority } = message;
      const intent = await db.createIntent(client.workspaceId, client.agent.id, {
        action, description, targets, concepts, priority
      });

      ws.send(JSON.stringify({ type: 'intent_created', intent }));

      broadcastToWorkspace(client.workspaceId, {
        type: 'intent_broadcast',
        intent
      }, client.agent.id);

      // Trigger reactions
      await triggerReactions(client.workspaceId, 'intent_broadcast', intent.concepts, { intent });

      break;
    }

    case 'intent_update': {
      if (!client) return;

      const { intentId, status, result } = message;
      const intent = await db.updateIntent(client.workspaceId, intentId, { status, result });

      if (intent) {
        ws.send(JSON.stringify({ type: 'intent_updated', intent }));
        broadcastToWorkspace(client.workspaceId, {
          type: `intent_${status}`,
          intent
        });
      }

      break;
    }

    case 'lock': {
      if (!client) return;

      const { target, ttl, intentId } = message;
      const result = await db.acquireLock(client.workspaceId, client.agent.id, target, ttl, intentId);

      ws.send(JSON.stringify({ type: 'lock_result', ...result }));

      if (result.success) {
        broadcastToWorkspace(client.workspaceId, {
          type: 'lock_acquired',
          lockId: result.lockId,
          agentId: client.agent.id,
          agentName: client.agent.name,
          target
        }, client.agent.id);
      }

      break;
    }

    case 'unlock': {
      if (!client) return;

      const { lockId } = message;
      const released = await db.releaseLock(client.workspaceId, lockId, client.agent.id);

      ws.send(JSON.stringify({ type: 'unlock_result', success: released }));

      if (released) {
        broadcastToWorkspace(client.workspaceId, {
          type: 'lock_released',
          lockId,
          agentId: client.agent.id
        });
      }

      break;
    }

    case 'file': {
      if (!client) return;

      const { path, content, operation } = message;

      if (operation === 'read') {
        const file = await db.getFile(client.workspaceId, path);
        ws.send(JSON.stringify({ type: 'file_content', path, file }));
      } else {
        const file = await db.upsertFile(client.workspaceId, client.agent.id, path, content);
        ws.send(JSON.stringify({ type: 'file_saved', path, version: file.version }));

        broadcastToWorkspace(client.workspaceId, {
          type: 'file_modified',
          path,
          version: file.version,
          checksum: file.checksum,
          agentId: client.agent.id,
          agentName: client.agent.name
        }, client.agent.id);

        // Trigger reactions
        await triggerReactions(client.workspaceId, 'file_modified', ['file', path], { path, file });
      }

      break;
    }

    case 'subscribe': {
      if (!client) return;

      const { concepts } = message;
      client.subscriptions = new Set(concepts || ['*']);

      // Also update in database
      await db.updateAgent(client.workspaceId, client.agent.id, {
        subscriptions: Array.from(client.subscriptions)
      });

      ws.send(JSON.stringify({ type: 'subscribed', concepts: Array.from(client.subscriptions) }));

      break;
    }

    case 'reaction': {
      if (!client) return;

      const { triggerConcepts, triggerEventTypes, actionType, actionConfig, priority } = message;
      const reaction = await db.createReaction(client.workspaceId, client.agent.id, {
        triggerConcepts, triggerEventTypes, actionType, actionConfig, priority
      });

      ws.send(JSON.stringify({ type: 'reaction_created', reaction }));

      break;
    }

    case 'heartbeat': {
      if (client) {
        await db.updateAgent(client.workspaceId, client.agent.id, { isOnline: true });
      }
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;
    }

    case 'blueprint': {
      if (!client) return;
      const blueprint = await db.getBlueprint(client.workspaceId);
      ws.send(JSON.stringify({ type: 'blueprint', ...blueprint }));
      break;
    }
  }
}

// ================================================
// Reaction Engine
// ================================================

async function triggerReactions(workspaceId: string, eventType: string, concepts: string[], data: any) {
  // Get reactions that match the event
  const [byType, byConcept] = await Promise.all([
    db.getReactionsForEventType(workspaceId, eventType),
    db.getReactionsForConcepts(workspaceId, concepts)
  ]);

  const reactions = [...byType, ...byConcept];
  const seen = new Set<string>();

  for (const reaction of reactions) {
    if (seen.has(reaction.id)) continue;
    seen.add(reaction.id);

    const client = clients.get(reaction.agentId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      // Send reaction trigger to the agent
      client.ws.send(JSON.stringify({
        type: 'reaction_trigger',
        reactionId: reaction.id,
        eventType,
        concepts,
        data,
        actionType: reaction.actionType,
        actionConfig: reaction.actionConfig
      }));
    }
  }
}

// ================================================
// Broadcast Helper
// ================================================

function broadcastToWorkspace(workspaceId: string, message: any, excludeAgentId?: string) {
  const payload = JSON.stringify(message);

  for (const [agentId, client] of clients) {
    if (client.workspaceId !== workspaceId) continue;
    if (excludeAgentId && agentId === excludeAgentId) continue;
    if (client.ws.readyState !== WebSocket.OPEN) continue;

    // Check subscriptions
    if (!client.subscriptions.has('*')) {
      const messageConcepts = message.concepts || message.intent?.concepts || [];
      const hasMatch = messageConcepts.some((c: string) => client.subscriptions.has(c));
      if (!hasMatch) continue;
    }

    client.ws.send(payload);
  }
}

// ================================================
// Environment Detection Helpers
// ================================================

function detectRole(environment: string): string {
  const env = environment.toLowerCase();
  if (env.includes('cursor') || env.includes('vscode')) return 'coder';
  if (env.includes('terminal') || env.includes('cli')) return 'executor';
  if (env.includes('test')) return 'tester';
  if (env.includes('claude') || env.includes('chatgpt')) return 'planner';
  return 'coder';
}

function detectCapabilities(environment: string): string[] {
  const env = environment.toLowerCase();
  const caps = ['chat'];

  if (env.includes('cursor') || env.includes('vscode')) {
    caps.push('edit', 'file_read', 'file_write', 'terminal');
  }
  if (env.includes('terminal') || env.includes('cli')) {
    caps.push('execute', 'file_read', 'file_write');
  }
  if (env.includes('claude')) {
    caps.push('plan', 'analyze', 'mcp');
  }
  if (env.includes('web')) {
    caps.push('browse');
  }

  return caps;
}

// ================================================
// Startup
// ================================================

async function start() {
  await db.connect();
  console.log('Database connected');

  // Listen for Redis events and broadcast
  db.on('event', ({ workspaceId, type, data }) => {
    broadcastToWorkspace(workspaceId, { type, ...data });
  });

  const port = parseInt(process.env.PORT || '3100');
  server.listen(port, () => {
    console.log(`\n🚀 Synapse Gateway running on port ${port}`);
    console.log(`   WebSocket: ws://localhost:${port}`);
    console.log(`   HTTP API:  http://localhost:${port}/api`);
    console.log(`   SSE:       http://localhost:${port}/api/stream\n`);
  });
}

start().catch(console.error);

export { app, server, wss, db };
