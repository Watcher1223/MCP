// Synapse HTTP Tools Server
// REST API adapter for stateless web AI agents (ChatGPT, Gemini, etc.)

import express from 'express';
import { Logger, generateId } from '../../shared/utils.js';

const log = new Logger('HTTP-Tools');

class HTTPToolsServer {
  private app: express.Application;
  private hubUrl: string;
  private registeredAgents: Map<string, { id: string; name: string; cursor: number; lastSeen: number }> = new Map();

  constructor(port: number = 3102, hubUrl: string = 'http://localhost:3100') {
    this.hubUrl = hubUrl;
    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();

    this.app.listen(port, () => {
      log.success(`Synapse HTTP Tools Server running on port ${port}`);
      log.info(`Hub URL: ${hubUrl}`);
    });

    // Cleanup stale agents periodically
    setInterval(() => this.cleanupStaleAgents(), 60000);
  }

  private setupRoutes(): void {
    // CORS
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') return res.sendStatus(200);
      next();
    });

    // Register as HTTP/polling agent
    this.app.post('/register', async (req, res) => {
      try {
        const { name, role = 'planner' } = req.body;

        const response = await fetch(`${this.hubUrl}/api/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: generateId(),
            name: name || 'HTTP-Agent',
            type: 'stateless',
            role,
            capabilities: ['planning', 'review'],
          }),
        });

        const data = await response.json();

        if (data.success) {
          this.registeredAgents.set(data.agentId, {
            id: data.agentId,
            name: name || 'HTTP-Agent',
            cursor: data.cursor,
            lastSeen: Date.now(),
          });

          res.json({
            success: true,
            agentId: data.agentId,
            cursor: data.cursor,
            message: 'Registered successfully. Include agentId in subsequent requests.',
          });
        } else {
          res.status(400).json(data);
        }
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get working memory (blueprint)
    this.app.get('/memory', async (req, res) => {
      try {
        const agentId = req.query.agentId as string;
        const agent = agentId ? this.registeredAgents.get(agentId) : null;
        const sinceCursor = agent?.cursor || parseInt(req.query.since as string) || 0;

        const url = sinceCursor > 0
          ? `${this.hubUrl}/api/blueprint?since=${sinceCursor}`
          : `${this.hubUrl}/api/blueprint`;

        const response = await fetch(url);
        const data = await response.json();

        // Update agent cursor
        if (agent && data.blueprint?.cursor) {
          agent.cursor = data.blueprint.cursor;
          agent.lastSeen = Date.now();
        }

        res.json({
          ...data,
          yourCursor: agent?.cursor || sinceCursor,
        });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // Poll for updates
    this.app.get('/updates', async (req, res) => {
      try {
        const agentId = req.query.agentId as string;
        const agent = agentId ? this.registeredAgents.get(agentId) : null;
        const sinceCursor = agent?.cursor || parseInt(req.query.since as string) || 0;

        const response = await fetch(`${this.hubUrl}/api/events?since=${sinceCursor}&limit=100`);
        const data = await response.json();

        // Update agent cursor
        if (agent && data.cursor) {
          agent.cursor = data.cursor;
          agent.lastSeen = Date.now();
        }

        res.json({
          events: data.events,
          cursor: data.cursor,
          hasMore: data.events?.length >= 100,
        });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // Broadcast intent (what you plan to do)
    this.app.post('/intent', async (req, res) => {
      try {
        const { agentId, action, targets, description, priority = 5 } = req.body;

        if (!agentId) {
          return res.status(400).json({ error: 'agentId required' });
        }

        const response = await fetch(`${this.hubUrl}/api/intent`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Agent-Id': agentId,
          },
          body: JSON.stringify({
            agentId,
            action,
            targets,
            description,
            priority,
            status: 'pending',
            dependencies: [],
          }),
        });

        const data = await response.json();
        res.json(data);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // Request lock on a file/resource
    this.app.post('/lock', async (req, res) => {
      try {
        const { agentId, path, type = 'file', ttl = 30000 } = req.body;

        if (!agentId) {
          return res.status(400).json({ error: 'agentId required' });
        }

        const response = await fetch(`${this.hubUrl}/api/lock`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Agent-Id': agentId,
          },
          body: JSON.stringify({
            target: { type, path },
            ttl,
          }),
        });

        const data = await response.json();
        res.json(data);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // Release lock
    this.app.delete('/lock/:lockId', async (req, res) => {
      try {
        const agentId = req.query.agentId as string;

        if (!agentId) {
          return res.status(400).json({ error: 'agentId query param required' });
        }

        const response = await fetch(`${this.hubUrl}/api/lock/${req.params.lockId}`, {
          method: 'DELETE',
          headers: { 'X-Agent-Id': agentId },
        });

        const data = await response.json();
        res.json(data);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // View all current locks
    this.app.get('/locks', async (req, res) => {
      try {
        const response = await fetch(`${this.hubUrl}/api/locks`);
        const data = await response.json();
        res.json(data);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // View all agents
    this.app.get('/agents', async (req, res) => {
      try {
        const response = await fetch(`${this.hubUrl}/api/agents`);
        const data = await response.json();
        res.json(data);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // View all intents
    this.app.get('/intents', async (req, res) => {
      try {
        const response = await fetch(`${this.hubUrl}/api/intents`);
        const data = await response.json();
        res.json(data);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get file content
    this.app.get('/file/*', async (req, res) => {
      try {
        const path = '/' + req.params[0];
        const response = await fetch(`${this.hubUrl}/api/file${path}`);

        if (!response.ok) {
          return res.status(response.status).json({ error: 'File not found' });
        }

        const data = await response.json();
        res.json(data);
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // Health check
    this.app.get('/health', async (req, res) => {
      try {
        const hubHealth = await fetch(`${this.hubUrl}/health`);
        const hubData = await hubHealth.json();

        res.json({
          status: 'ok',
          hub: hubData,
          registeredAgents: this.registeredAgents.size,
        });
      } catch (error: any) {
        res.json({
          status: 'degraded',
          hub: 'unreachable',
          error: error.message,
        });
      }
    });

    // OpenAPI spec for AI agents
    this.app.get('/openapi.json', (req, res) => {
      res.json(this.getOpenAPISpec());
    });
  }

  private cleanupStaleAgents(): void {
    const staleThreshold = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();

    for (const [agentId, agent] of this.registeredAgents) {
      if (now - agent.lastSeen > staleThreshold) {
        this.registeredAgents.delete(agentId);
        log.info(`Removed stale agent: ${agent.name} (${agentId})`);
      }
    }
  }

  private getOpenAPISpec(): object {
    return {
      openapi: '3.0.0',
      info: {
        title: 'Synapse HTTP Tools API',
        description: 'REST API for AI agents to collaborate through shared working memory',
        version: '1.0.0',
      },
      servers: [
        { url: 'http://localhost:3102', description: 'Local development' },
      ],
      paths: {
        '/register': {
          post: {
            summary: 'Register as an HTTP agent',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      role: { type: 'string', enum: ['planner', 'coder', 'tester', 'refactor', 'observer'] },
                    },
                  },
                },
              },
            },
            responses: {
              200: { description: 'Registration successful' },
            },
          },
        },
        '/memory': {
          get: {
            summary: 'Get shared working memory (blueprint)',
            parameters: [
              { name: 'agentId', in: 'query', schema: { type: 'string' } },
              { name: 'since', in: 'query', schema: { type: 'number' } },
            ],
            responses: { 200: { description: 'Current blueprint' } },
          },
        },
        '/updates': {
          get: {
            summary: 'Poll for recent updates/events',
            parameters: [
              { name: 'agentId', in: 'query', schema: { type: 'string' } },
              { name: 'since', in: 'query', schema: { type: 'number' } },
            ],
            responses: { 200: { description: 'Recent events' } },
          },
        },
        '/intent': {
          post: {
            summary: 'Broadcast your intent to other agents',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['agentId', 'action', 'targets', 'description'],
                    properties: {
                      agentId: { type: 'string' },
                      action: { type: 'string' },
                      targets: { type: 'array', items: { type: 'string' } },
                      description: { type: 'string' },
                      priority: { type: 'number' },
                    },
                  },
                },
              },
            },
            responses: { 200: { description: 'Intent created' } },
          },
        },
      },
    };
  }
}

// Run if executed directly
const isMain = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isMain) {
  const port = parseInt(process.env.HTTP_PORT || '3102');
  const hubUrl = process.env.HUB_URL || 'http://localhost:3100';
  new HTTPToolsServer(port, hubUrl);
}

export default HTTPToolsServer;
