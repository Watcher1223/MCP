// Synapse SDK - Build collaborative AI agents
// Usage: import { SynapseAgent } from 'synapse-sdk';

import WebSocket from 'ws';
import { EventEmitter } from 'events';

export interface AgentConfig {
  name: string;
  role: 'coder' | 'planner' | 'tester' | 'executor' | 'observer';
  environment: string;
  capabilities?: string[];
  hubUrl?: string;
  apiKey?: string;
  sessionToken?: string;
  autoReconnect?: boolean;
  subscriptions?: string[];
}

export interface Intent {
  id: string;
  agentId: string;
  action: string;
  description: string;
  targets: string[];
  concepts: string[];
  priority: number;
  status: string;
}

export interface Lock {
  id: string;
  agentId: string;
  targetType: string;
  targetPath: string;
  targetIdentifier?: string;
  expiresAt: Date;
}

export interface FileState {
  path: string;
  content: string;
  checksum: string;
  version: number;
}

export interface Blueprint {
  agents: any[];
  intents: Intent[];
  locks: Lock[];
  files: Record<string, FileState>;
  cursor: number;
}

export interface ReactionConfig {
  triggerConcepts?: string[];
  triggerEventTypes?: string[];
  actionType: string;
  actionConfig?: Record<string, any>;
  priority?: number;
}

type EventHandler = (...args: any[]) => void;

export class SynapseAgent extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: AgentConfig;
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private agent: any = null;
  private sessionToken: string | null = null;
  private blueprint: Blueprint | null = null;
  private messageQueue: any[] = [];
  private pendingResponses = new Map<string, { resolve: Function; reject: Function }>();
  private messageId = 0;

  constructor(config: AgentConfig) {
    super();
    this.config = {
      hubUrl: process.env.SYNAPSE_HUB || 'wss://synapse.clodhost.com',
      autoReconnect: true,
      capabilities: [],
      subscriptions: ['*'],
      ...config
    };
  }

  // Connect to the Synapse hub
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.config.hubUrl!;
      this.ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 10000);

      this.ws.on('open', () => {
        this.ws!.send(JSON.stringify({
          type: 'connect',
          apiKey: this.config.apiKey,
          sessionToken: this.config.sessionToken || this.sessionToken,
          environment: this.config.environment,
          name: this.config.name,
          role: this.config.role,
          capabilities: this.config.capabilities
        }));
      });

      this.ws.on('message', (data) => {
        const message = JSON.parse(data.toString());
        this.handleMessage(message, resolve, reject, timeout);
      });

      this.ws.on('close', () => {
        this.connected = false;
        this.emit('disconnected');
        this.stopHeartbeat();

        if (this.config.autoReconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        this.emit('error', err);
        if (!this.connected) {
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }

  private handleMessage(message: any, resolve?: Function, reject?: Function, timeout?: NodeJS.Timeout) {
    switch (message.type) {
      case 'connected':
        if (timeout) clearTimeout(timeout);
        this.connected = true;
        this.agent = message.agent;
        this.sessionToken = message.sessionToken;
        this.blueprint = message.blueprint;
        this.startHeartbeat();
        this.flushMessageQueue();
        this.emit('connected', this.agent, this.blueprint);

        // Subscribe to configured concepts
        if (this.config.subscriptions && this.config.subscriptions.length > 0) {
          this.subscribe(this.config.subscriptions);
        }

        if (resolve) resolve();
        break;

      case 'error':
        this.emit('error', new Error(message.message));
        if (reject && !this.connected) reject(new Error(message.message));
        break;

      case 'blueprint':
        this.blueprint = message;
        this.emit('blueprint', this.blueprint);
        break;

      case 'agent_connected':
        this.emit('agent:join', message.agent);
        break;

      case 'agent_disconnected':
        this.emit('agent:leave', message.agentId);
        break;

      case 'agent_updated':
        this.emit('agent:update', message.agent);
        break;

      case 'intent_broadcast':
        this.emit('intent', message.intent);
        this.emit('intent:new', message.intent);
        break;

      case 'intent_completed':
        this.emit('intent:completed', message.intent);
        break;

      case 'intent_cancelled':
        this.emit('intent:cancelled', message.intent);
        break;

      case 'lock_acquired':
        this.emit('lock:acquired', message);
        break;

      case 'lock_released':
        this.emit('lock:released', message);
        break;

      case 'file_modified':
        this.emit('file:modified', message);
        break;

      case 'reaction_trigger':
        this.emit('reaction', message);
        this.handleReaction(message);
        break;

      case 'pong':
        // Heartbeat response
        break;

      default:
        // Handle response to pending requests
        if (message.requestId && this.pendingResponses.has(message.requestId)) {
          const { resolve } = this.pendingResponses.get(message.requestId)!;
          this.pendingResponses.delete(message.requestId);
          resolve(message);
        }
    }
  }

  private handleReaction(reaction: any) {
    // Auto-execute registered reaction handlers
    const handlers = this.listeners(`reaction:${reaction.actionType}`);
    for (const handler of handlers) {
      try {
        handler(reaction);
      } catch (e) {
        this.emit('error', e);
      }
    }
  }

  // Disconnect from the hub
  disconnect(): void {
    this.config.autoReconnect = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  // Check if connected
  isConnected(): boolean {
    return this.connected;
  }

  // Get current agent info
  getAgent(): any {
    return this.agent;
  }

  // Get current blueprint
  getBlueprint(): Blueprint | null {
    return this.blueprint;
  }

  // Get session token for reconnection
  getSessionToken(): string | null {
    return this.sessionToken;
  }

  // Subscribe to concepts
  subscribe(concepts: string[]): void {
    this.send({ type: 'subscribe', concepts });
  }

  // Broadcast an intent
  async broadcastIntent(intent: {
    action: string;
    description?: string;
    targets?: string[];
    concepts?: string[];
    priority?: number;
  }): Promise<Intent> {
    const response = await this.sendAndWait({
      type: 'intent',
      ...intent
    });
    return response.intent;
  }

  // Update an intent
  async updateIntent(intentId: string, status: 'active' | 'completed' | 'cancelled', result?: any): Promise<Intent> {
    const response = await this.sendAndWait({
      type: 'intent_update',
      intentId,
      status,
      result
    });
    return response.intent;
  }

  // Request a lock
  async requestLock(target: {
    type: 'file' | 'function' | 'class' | 'module';
    path: string;
    identifier?: string;
  }, ttlMs: number = 30000, intentId?: string): Promise<{ success: boolean; lockId?: string; reason?: string }> {
    const response = await this.sendAndWait({
      type: 'lock',
      target,
      ttl: ttlMs,
      intentId
    });
    return response;
  }

  // Release a lock
  async releaseLock(lockId: string): Promise<boolean> {
    const response = await this.sendAndWait({
      type: 'unlock',
      lockId
    });
    return response.success;
  }

  // Read a file
  async readFile(path: string): Promise<FileState | null> {
    const response = await this.sendAndWait({
      type: 'file',
      operation: 'read',
      path
    });
    return response.file;
  }

  // Write a file
  async writeFile(path: string, content: string): Promise<{ version: number }> {
    const response = await this.sendAndWait({
      type: 'file',
      operation: 'write',
      path,
      content
    });
    return { version: response.version };
  }

  // Register a reaction (automatic task trigger)
  async registerReaction(config: ReactionConfig): Promise<any> {
    const response = await this.sendAndWait({
      type: 'reaction',
      ...config
    });
    return response.reaction;
  }

  // Refresh blueprint
  async refreshBlueprint(): Promise<Blueprint> {
    const response = await this.sendAndWait({ type: 'blueprint' });
    this.blueprint = response;
    return this.blueprint;
  }

  // Convenience: Auto-react to concepts
  onConcept(concepts: string | string[], handler: (event: any) => void): void {
    const conceptList = Array.isArray(concepts) ? concepts : [concepts];

    // Subscribe to these concepts
    this.subscribe(conceptList);

    // Register local handler
    this.on('intent', (intent: Intent) => {
      if (intent.concepts.some(c => conceptList.includes(c))) {
        handler({ type: 'intent', data: intent });
      }
    });

    this.on('file:modified', (file: any) => {
      // Extract concepts from path
      if (conceptList.some(c => file.path.includes(c))) {
        handler({ type: 'file', data: file });
      }
    });
  }

  // Convenience: React to specific event types
  onEvent(eventTypes: string | string[], handler: (event: any) => void): void {
    const types = Array.isArray(eventTypes) ? eventTypes : [eventTypes];
    for (const type of types) {
      this.on(type, handler);
    }
  }

  // Register a reaction handler
  onReaction(actionType: string, handler: (reaction: any) => void): void {
    this.on(`reaction:${actionType}`, handler);
  }

  // Private methods

  private send(message: any): void {
    if (!this.connected || !this.ws) {
      this.messageQueue.push(message);
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  private async sendAndWait(message: any, timeoutMs: number = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
      const requestId = `req_${++this.messageId}`;
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(requestId);
        reject(new Error('Request timeout'));
      }, timeoutMs);

      this.pendingResponses.set(requestId, {
        resolve: (response: any) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (error: any) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      this.send({ ...message, requestId });
    });
  }

  private flushMessageQueue(): void {
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      this.send(message);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (e) {
        this.scheduleReconnect();
      }
    }, 3000);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'heartbeat' });
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

// Helper to create a quick agent
export function createAgent(config: AgentConfig): SynapseAgent {
  return new SynapseAgent(config);
}

// Auto-reactive agent that automatically responds to events
export class ReactiveAgent extends SynapseAgent {
  private reactionHandlers = new Map<string, (context: ReactionContext) => Promise<void>>();

  constructor(config: AgentConfig) {
    super(config);

    // Auto-handle reactions
    this.on('reaction', async (reaction) => {
      const handler = this.reactionHandlers.get(reaction.actionType);
      if (handler) {
        const context: ReactionContext = {
          reaction,
          agent: this,
          blueprint: this.getBlueprint()!
        };
        await handler(context);
      }
    });
  }

  // Register automatic reaction
  react(actionType: string, handler: (context: ReactionContext) => Promise<void>): void {
    this.reactionHandlers.set(actionType, handler);
  }

  // Subscribe to API changes and auto-react
  async watchAPI(handler: (change: any) => Promise<void>): Promise<void> {
    await this.registerReaction({
      triggerConcepts: ['api', 'endpoint', 'schema'],
      actionType: 'api_changed'
    });
    this.react('api_changed', async (ctx) => {
      await handler(ctx.reaction.data);
    });
  }

  // Subscribe to test events and auto-react
  async watchTests(handler: (result: any) => Promise<void>): Promise<void> {
    await this.registerReaction({
      triggerEventTypes: ['test_failed', 'test_passed'],
      actionType: 'test_result'
    });
    this.react('test_result', async (ctx) => {
      await handler(ctx.reaction.data);
    });
  }

  // Subscribe to file changes and auto-react
  async watchFiles(patterns: string[], handler: (file: any) => Promise<void>): Promise<void> {
    await this.registerReaction({
      triggerConcepts: patterns,
      triggerEventTypes: ['file_modified', 'file_created'],
      actionType: 'file_changed'
    });
    this.react('file_changed', async (ctx) => {
      await handler(ctx.reaction.data);
    });
  }
}

export interface ReactionContext {
  reaction: any;
  agent: SynapseAgent;
  blueprint: Blueprint;
}

export default SynapseAgent;
