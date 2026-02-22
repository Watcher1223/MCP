// Synapse Hub - Main Server
// Coordination server with WebSocket and HTTP support

import { WebSocketServer, WebSocket } from 'ws';
import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import {
  Message,
  Response as ProtocolResponse,
  Event,
  Agent,
  MessageSchema,
} from '../../shared/types.js';
import { generateId, Logger } from '../../shared/utils.js';
import { StateManager } from './state.js';

const log = new Logger('Hub');

interface ConnectedClient {
  ws: WebSocket;
  agentId: string | null;
  subscriptions: Set<string>;
}

export class SynapseHub {
  private state: StateManager;
  private wss: WebSocketServer;
  private app: express.Application;
  private server: ReturnType<typeof createServer>;
  private clients: Map<WebSocket, ConnectedClient> = new Map();
  private httpAgents: Map<string, { agent: Agent; lastPoll: number }> = new Map();

  constructor(port: number = 3100) {
    this.state = new StateManager();
    this.app = express();
    this.app.use(express.json());
    this.setupHttpRoutes();

    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });

    this.setupWebSocket();

    this.server.listen(port, () => {
      log.success(`Synapse Hub running on port ${port}`);
      log.info(`WebSocket: ws://localhost:${port}`);
      log.info(`HTTP API: http://localhost:${port}/api`);
    });
  }

  // ========================================
  // WEBSOCKET HANDLING
  // ========================================

  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      const client: ConnectedClient = {
        ws,
        agentId: null,
        subscriptions: new Set(),
      };
      this.clients.set(ws, client);

      log.info('New WebSocket connection');

      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(ws, client, message);
        } catch (error) {
          this.sendResponse(ws, {
            type: 'error',
            message: 'Invalid message format',
            code: 'PARSE_ERROR',
          });
        }
      });

      ws.on('close', () => {
        if (client.agentId) {
          this.state.unregisterAgent(client.agentId);
          this.broadcastEvent({
            id: generateId(),
            cursor: this.state.getCurrentCursor(),
            type: 'agent_disconnected',
            agentId: client.agentId,
            timestamp: Date.now(),
            data: { agentId: client.agentId },
          });
        }
        this.clients.delete(ws);
        log.info(`WebSocket disconnected: ${client.agentId || 'unregistered'}`);
      });

      ws.on('error', (error) => {
        log.error(`WebSocket error: ${error.message}`);
      });
    });
  }

  private handleMessage(ws: WebSocket, client: ConnectedClient, rawMessage: unknown): void {
    const parseResult = MessageSchema.safeParse(rawMessage);

    if (!parseResult.success) {
      this.sendResponse(ws, {
        type: 'error',
        message: `Invalid message: ${parseResult.error.message}`,
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const message = parseResult.data;

    switch (message.type) {
      case 'register':
        this.handleRegister(ws, client, message);
        break;

      case 'broadcast_intent':
        this.handleBroadcastIntent(ws, client, message);
        break;

      case 'update_intent':
        this.handleUpdateIntent(ws, client, message);
        break;

      case 'request_lock':
        this.handleRequestLock(ws, client, message);
        break;

      case 'release_lock':
        this.handleReleaseLock(ws, client, message);
        break;

      case 'file_patch':
        this.handleFilePatch(ws, client, message);
        break;

      case 'get_blueprint':
        this.handleGetBlueprint(ws, client, message);
        break;

      case 'get_events':
        this.handleGetEvents(ws, client, message);
        break;

      case 'subscribe':
        this.handleSubscribe(ws, client, message);
        break;

      case 'heartbeat':
        this.handleHeartbeat(ws, client);
        break;

      case 'report_test':
        this.handleReportTest(ws, client, message);
        break;

      default:
        this.sendResponse(ws, {
          type: 'error',
          message: `Unknown message type`,
          code: 'UNKNOWN_TYPE',
        });
    }
  }

  private handleRegister(ws: WebSocket, client: ConnectedClient, message: any): void {
    const agent = this.state.registerAgent(message.agent);
    client.agentId = agent.id;

    this.sendResponse(ws, {
      type: 'registered',
      agentId: agent.id,
      cursor: this.state.getCurrentCursor(),
    });

    // Broadcast to other clients
    this.broadcastEvent({
      id: generateId(),
      cursor: this.state.getCurrentCursor(),
      type: 'agent_connected',
      agentId: agent.id,
      timestamp: Date.now(),
      data: { agent },
    }, ws);
  }

  private handleBroadcastIntent(ws: WebSocket, client: ConnectedClient, message: any): void {
    if (!client.agentId) {
      this.sendResponse(ws, { type: 'error', message: 'Not registered', code: 'NOT_REGISTERED' });
      return;
    }

    const intent = this.state.createIntent(client.agentId, {
      ...message.intent,
      agentId: client.agentId,
    });

    this.sendResponse(ws, {
      type: 'intent_created',
      intentId: intent.id,
    });

    this.broadcastEvent({
      id: generateId(),
      cursor: this.state.getCurrentCursor(),
      type: 'intent_broadcast',
      agentId: client.agentId,
      timestamp: Date.now(),
      data: { intent },
    }, ws);
  }

  private handleUpdateIntent(ws: WebSocket, client: ConnectedClient, message: any): void {
    if (!client.agentId) {
      this.sendResponse(ws, { type: 'error', message: 'Not registered', code: 'NOT_REGISTERED' });
      return;
    }

    const intent = this.state.updateIntent(message.intentId, message.updates);
    if (!intent) {
      this.sendResponse(ws, { type: 'error', message: 'Intent not found', code: 'NOT_FOUND' });
      return;
    }

    this.sendResponse(ws, { type: 'ack' });

    const eventType = message.updates.status === 'completed' ? 'intent_completed' :
                     message.updates.status === 'cancelled' ? 'intent_cancelled' : 'intent_updated';

    this.broadcastEvent({
      id: generateId(),
      cursor: this.state.getCurrentCursor(),
      type: eventType,
      agentId: client.agentId,
      timestamp: Date.now(),
      data: { intent },
    });
  }

  private handleRequestLock(ws: WebSocket, client: ConnectedClient, message: any): void {
    if (!client.agentId) {
      this.sendResponse(ws, { type: 'error', message: 'Not registered', code: 'NOT_REGISTERED' });
      return;
    }

    const result = this.state.requestLock(
      client.agentId,
      message.target,
      message.ttl || 30000,
      message.intent
    );

    this.sendResponse(ws, {
      type: 'lock_result',
      ...result,
    });

    if (result.success) {
      this.broadcastEvent({
        id: generateId(),
        cursor: this.state.getCurrentCursor(),
        type: 'lock_acquired',
        agentId: client.agentId,
        timestamp: Date.now(),
        data: { lockId: result.lockId, target: message.target },
      }, ws);
    }
  }

  private handleReleaseLock(ws: WebSocket, client: ConnectedClient, message: any): void {
    if (!client.agentId) {
      this.sendResponse(ws, { type: 'error', message: 'Not registered', code: 'NOT_REGISTERED' });
      return;
    }

    const released = this.state.releaseLock(message.lockId, client.agentId);
    this.sendResponse(ws, {
      type: 'lock_result',
      success: released,
      lockId: message.lockId,
      reason: released ? undefined : 'Lock not found or not owned',
    });

    if (released) {
      this.broadcastEvent({
        id: generateId(),
        cursor: this.state.getCurrentCursor(),
        type: 'lock_released',
        agentId: client.agentId,
        timestamp: Date.now(),
        data: { lockId: message.lockId },
      }, ws);
    }
  }

  private handleFilePatch(ws: WebSocket, client: ConnectedClient, message: any): void {
    if (!client.agentId) {
      this.sendResponse(ws, { type: 'error', message: 'Not registered', code: 'NOT_REGISTERED' });
      return;
    }

    const result = this.state.applyFilePatch(client.agentId, message.patch, message.lockId);

    this.sendResponse(ws, {
      type: 'patch_result',
      success: result.success,
      path: message.patch.path,
      version: result.version,
      reason: result.reason,
    });

    if (result.success) {
      const eventType = message.patch.operation === 'create' ? 'file_created' :
                       message.patch.operation === 'delete' ? 'file_deleted' :
                       message.patch.operation === 'rename' ? 'file_renamed' : 'file_modified';

      this.broadcastEvent({
        id: generateId(),
        cursor: this.state.getCurrentCursor(),
        type: eventType,
        agentId: client.agentId,
        timestamp: Date.now(),
        data: {
          path: message.patch.path,
          operation: message.patch.operation,
          version: result.version,
        },
      });
    }
  }

  private handleGetBlueprint(ws: WebSocket, client: ConnectedClient, message: any): void {
    if (message.sinceCursor !== undefined) {
      const delta = this.state.getBlueprintDelta(message.sinceCursor);
      this.sendResponse(ws, {
        type: 'blueprint',
        blueprint: delta.blueprint,
      });
      // Also send events
      if (delta.events.length > 0) {
        this.sendResponse(ws, {
          type: 'events',
          events: delta.events,
          cursor: this.state.getCurrentCursor(),
        });
      }
    } else {
      this.sendResponse(ws, {
        type: 'blueprint',
        blueprint: this.state.getBlueprint(),
      });
    }
  }

  private handleGetEvents(ws: WebSocket, client: ConnectedClient, message: any): void {
    const events = this.state.getEventsSince(message.sinceCursor, message.limit);
    this.sendResponse(ws, {
      type: 'events',
      events,
      cursor: this.state.getCurrentCursor(),
    });
  }

  private handleSubscribe(ws: WebSocket, client: ConnectedClient, message: any): void {
    const eventTypes = message.eventTypes || ['*'];
    client.subscriptions = new Set(eventTypes);
    this.sendResponse(ws, {
      type: 'subscribed',
      eventTypes: eventTypes as any[],
    });
  }

  private handleHeartbeat(ws: WebSocket, client: ConnectedClient): void {
    if (client.agentId) {
      this.state.updateAgentHeartbeat(client.agentId);
    }
    this.sendResponse(ws, { type: 'ack' });
  }

  private handleReportTest(ws: WebSocket, client: ConnectedClient, message: any): void {
    if (!client.agentId) {
      this.sendResponse(ws, { type: 'error', message: 'Not registered', code: 'NOT_REGISTERED' });
      return;
    }

    this.state.reportTest(client.agentId, message.testName, message.status, message.details, message.errors);
    this.sendResponse(ws, { type: 'ack' });

    const eventType = message.status === 'started' ? 'test_started' :
                     message.status === 'passed' ? 'test_passed' : 'test_failed';

    this.broadcastEvent({
      id: generateId(),
      cursor: this.state.getCurrentCursor(),
      type: eventType,
      agentId: client.agentId,
      timestamp: Date.now(),
      data: { testName: message.testName, status: message.status, details: message.details, errors: message.errors },
    });
  }

  private sendResponse(ws: WebSocket, response: ProtocolResponse): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(response));
    }
  }

  private broadcastEvent(event: Event, exclude?: WebSocket): void {
    const message = JSON.stringify({ type: 'event', event });

    for (const [ws, client] of this.clients) {
      if (ws === exclude) continue;
      if (ws.readyState !== WebSocket.OPEN) continue;

      // Check subscriptions
      if (client.subscriptions.size > 0 &&
          !client.subscriptions.has('*') &&
          !client.subscriptions.has(event.type)) {
        continue;
      }

      ws.send(message);
    }
  }

  // ========================================
  // HTTP API ROUTES
  // ========================================

  private setupHttpRoutes(): void {
    // CORS middleware
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Content-Type, X-Agent-Id, X-Agent-Cursor');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }
      next();
    });

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', cursor: this.state.getCurrentCursor() });
    });

    // Register HTTP agent
    this.app.post('/api/register', (req, res) => {
      const agent = this.state.registerAgent(req.body);
      this.httpAgents.set(agent.id, { agent, lastPoll: Date.now() });
      res.json({
        success: true,
        agentId: agent.id,
        cursor: this.state.getCurrentCursor(),
      });
    });

    // Get blueprint
    this.app.get('/api/blueprint', (req, res) => {
      const sinceCursor = parseInt(req.query.since as string) || 0;
      if (sinceCursor > 0) {
        res.json(this.state.getBlueprintDelta(sinceCursor));
      } else {
        res.json({ blueprint: this.state.getBlueprint() });
      }
    });

    // Get events (polling)
    this.app.get('/api/events', (req, res) => {
      const sinceCursor = parseInt(req.query.since as string) || 0;
      const limit = parseInt(req.query.limit as string) || 100;
      const events = this.state.getEventsSince(sinceCursor, limit);
      res.json({
        events,
        cursor: this.state.getCurrentCursor(),
      });
    });

    // Broadcast intent
    this.app.post('/api/intent', (req, res) => {
      const agentId = req.headers['x-agent-id'] as string;
      if (!agentId) {
        return res.status(401).json({ error: 'Missing X-Agent-Id header' });
      }

      const intent = this.state.createIntent(agentId, {
        ...req.body,
        agentId,
      });

      this.broadcastEvent({
        id: generateId(),
        cursor: this.state.getCurrentCursor(),
        type: 'intent_broadcast',
        agentId,
        timestamp: Date.now(),
        data: { intent },
      });

      res.json({ success: true, intentId: intent.id });
    });

    // Request lock
    this.app.post('/api/lock', (req, res) => {
      const agentId = req.headers['x-agent-id'] as string;
      if (!agentId) {
        return res.status(401).json({ error: 'Missing X-Agent-Id header' });
      }

      const result = this.state.requestLock(
        agentId,
        req.body.target,
        req.body.ttl || 30000,
        req.body.intent
      );

      res.json(result);
    });

    // Release lock
    this.app.delete('/api/lock/:lockId', (req, res) => {
      const agentId = req.headers['x-agent-id'] as string;
      if (!agentId) {
        return res.status(401).json({ error: 'Missing X-Agent-Id header' });
      }

      const released = this.state.releaseLock(req.params.lockId, agentId);
      res.json({ success: released });
    });

    // File patch
    this.app.post('/api/file', (req, res) => {
      const agentId = req.headers['x-agent-id'] as string;
      if (!agentId) {
        return res.status(401).json({ error: 'Missing X-Agent-Id header' });
      }

      const result = this.state.applyFilePatch(agentId, req.body.patch, req.body.lockId);
      res.json(result);
    });

    // Get file
    this.app.get('/api/file/*', (req, res) => {
      const path = '/' + req.params[0];
      const file = this.state.getFile(path);
      if (!file) {
        return res.status(404).json({ error: 'File not found' });
      }
      res.json(file);
    });

    // Report test
    this.app.post('/api/test', (req, res) => {
      const agentId = req.headers['x-agent-id'] as string;
      if (!agentId) {
        return res.status(401).json({ error: 'Missing X-Agent-Id header' });
      }

      this.state.reportTest(
        agentId,
        req.body.testName,
        req.body.status,
        req.body.details,
        req.body.errors
      );

      res.json({ success: true });
    });

    // Get all agents
    this.app.get('/api/agents', (req, res) => {
      res.json({ agents: this.state.getAllAgents() });
    });

    // Get all locks
    this.app.get('/api/locks', (req, res) => {
      res.json({ locks: this.state.getAllLocks() });
    });

    // Get all intents
    this.app.get('/api/intents', (req, res) => {
      res.json({ intents: this.state.getAllIntents() });
    });

    // Reset state (for testing)
    this.app.post('/api/reset', (req, res) => {
      this.state.reset();
      this.httpAgents.clear();
      res.json({ success: true });
    });
  }

  // ========================================
  // PUBLIC METHODS
  // ========================================

  getState(): StateManager {
    return this.state;
  }

  close(): void {
    this.state.destroy();
    this.wss.close();
    this.server.close();
  }
}

// Run if executed directly
const isMain = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isMain) {
  const port = parseInt(process.env.PORT || '3100');
  new SynapseHub(port);
}

export default SynapseHub;
