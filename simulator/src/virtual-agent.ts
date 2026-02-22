// Synapse Simulator - Virtual Agent Base Class
// Simulates different AI agent types for testing

import WebSocket from 'ws';
import {
  Agent,
  AgentRole,
  AgentType,
  Message,
  Response as ProtocolResponse,
  Event,
  Blueprint,
  Intent,
  Lock,
  FilePatch,
  LockTarget,
} from '../../shared/types.js';
import { generateId, sleep, Logger, EventEmitter } from '../../shared/utils.js';

interface AgentEvents {
  [key: string]: any[];
  connected: [Agent];
  disconnected: [];
  event: [Event];
  blueprint: [Blueprint];
  error: [Error];
  intent_conflict: [{ newIntent: Intent; conflictingIntents: Intent[] }];
  lock_conflict: [{ target: string; holdingAgent: string }];
  file_conflict: [{ path: string; holdingAgent: string }];
}

export abstract class VirtualAgent extends EventEmitter<AgentEvents> {
  protected ws: WebSocket | null = null;
  protected agent: Agent | null = null;
  protected cursor: number = 0;
  protected blueprint: Blueprint | null = null;
  protected log: Logger;
  protected connected: boolean = false;
  protected pendingResponses: Map<string, (response: ProtocolResponse) => void> = new Map();
  protected eventHandlers: ((event: Event) => void)[] = [];

  constructor(
    public readonly name: string,
    public readonly role: AgentRole,
    public readonly type: AgentType = 'realtime',
    public readonly capabilities: string[] = []
  ) {
    super();
    this.log = new Logger(`Agent:${name}`);
  }

  // ========================================
  // CONNECTION
  // ========================================

  async connect(hubUrl: string = 'ws://localhost:3100'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(hubUrl);

      this.ws.on('open', async () => {
        this.log.info('Connected to hub');
        await this.register();
        this.connected = true;
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString()) as ProtocolResponse;
          this.handleResponse(message);
        } catch (error) {
          this.log.error('Failed to parse message');
        }
      });

      this.ws.on('close', () => {
        this.connected = false;
        this.log.info('Disconnected from hub');
        this.emit('disconnected');
      });

      this.ws.on('error', (error) => {
        this.log.error(`WebSocket error: ${error.message}`);
        this.emit('error', error);
        reject(error);
      });

      setTimeout(() => {
        if (!this.connected) {
          reject(new Error('Connection timeout'));
        }
      }, 5000);
    });
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.agent = null;
  }

  private async register(): Promise<void> {
    const response = await this.send({
      type: 'register',
      agent: {
        id: generateId(),
        name: this.name,
        type: this.type,
        role: this.role,
        capabilities: this.capabilities,
      },
    });

    if (response.type === 'registered') {
      this.agent = {
        id: response.agentId,
        name: this.name,
        type: this.type,
        role: this.role,
        capabilities: this.capabilities,
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        cursor: response.cursor,
      };
      this.cursor = response.cursor;
      this.log.info(`Registered with ID: ${this.agent.id}`);
      this.emit('connected', this.agent);

      // Subscribe to all events
      await this.send({ type: 'subscribe' });
    }
  }

  // ========================================
  // MESSAGING
  // ========================================

  protected send(message: Message): Promise<ProtocolResponse> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected'));
        return;
      }

      // For messages that expect a specific response, we track them
      const messageId = generateId();
      this.pendingResponses.set(messageId, resolve);

      this.ws.send(JSON.stringify(message));

      // Timeout for response
      setTimeout(() => {
        if (this.pendingResponses.has(messageId)) {
          this.pendingResponses.delete(messageId);
          // Return ack if no specific response needed
          resolve({ type: 'ack' });
        }
      }, 5000);
    });
  }

  private handleResponse(response: ProtocolResponse): void {
    // Handle events
    if (response.type === 'event') {
      this.cursor = response.event.cursor;
      this.handleEvent(response.event);
      return;
    }

    // Handle blueprint
    if (response.type === 'blueprint') {
      this.blueprint = response.blueprint;
      this.cursor = response.blueprint.cursor;
      this.emit('blueprint', response.blueprint);
    }

    // Resolve pending response
    const pending = this.pendingResponses.entries().next().value;
    if (pending) {
      const [id, resolver] = pending;
      this.pendingResponses.delete(id);
      resolver(response);
    }
  }

  protected handleEvent(event: Event): void {
    this.log.debug(`Event: ${event.type}`);
    this.emit('event', event);

    // Handle specific events
    switch (event.type) {
      case 'intent_conflict':
        this.emit('intent_conflict', event.data as any);
        this.onIntentConflict(event.data as any);
        break;

      case 'lock_conflict':
        this.emit('lock_conflict', event.data as any);
        this.onLockConflict(event.data as any);
        break;

      case 'file_conflict':
        this.emit('file_conflict', event.data as any);
        this.onFileConflict(event.data as any);
        break;

      case 'lock_released':
        this.onLockReleased(event.data.lockId, event.data.target);
        break;

      case 'file_modified':
      case 'file_created':
        this.onFileChanged(event.data.path, event.data.version);
        break;

      case 'test_failed':
        this.onTestFailed(event.data.testName, event.data.errors);
        break;
    }

    // Call custom event handlers
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  // ========================================
  // PROTOCOL OPERATIONS
  // ========================================

  async broadcastIntent(
    action: string,
    targets: string[],
    description: string,
    priority: number = 0
  ): Promise<string> {
    const response = await this.send({
      type: 'broadcast_intent',
      intent: {
        agentId: this.agent!.id,
        action,
        targets,
        description,
        priority,
        status: 'pending',
        dependencies: [],
      },
    });

    if (response.type === 'intent_created') {
      this.log.info(`Intent created: ${action}`);
      return response.intentId;
    }

    throw new Error('Failed to create intent');
  }

  async updateIntent(intentId: string, status: Intent['status']): Promise<void> {
    await this.send({
      type: 'update_intent',
      intentId,
      updates: { status },
    });
  }

  async requestLock(
    target: LockTarget,
    ttl: number = 30000,
    intent?: string
  ): Promise<{ success: boolean; lockId?: string; reason?: string }> {
    const response = await this.send({
      type: 'request_lock',
      target,
      ttl,
      intent,
    });

    if (response.type === 'lock_result') {
      if (response.success) {
        this.log.info(`Lock acquired on ${target.path}`);
      } else {
        this.log.warn(`Lock denied on ${target.path}: ${response.reason}`);
      }
      return {
        success: response.success,
        lockId: response.lockId,
        reason: response.reason,
      };
    }

    return { success: false, reason: 'Unknown error' };
  }

  async releaseLock(lockId: string): Promise<boolean> {
    const response = await this.send({
      type: 'release_lock',
      lockId,
    });

    return response.type === 'lock_result' && response.success;
  }

  async patchFile(
    path: string,
    operation: FilePatch['operation'],
    content?: string,
    lockId?: string
  ): Promise<{ success: boolean; version?: number; reason?: string }> {
    const response = await this.send({
      type: 'file_patch',
      patch: {
        path,
        operation,
        content,
      },
      lockId,
    });

    if (response.type === 'patch_result') {
      if (response.success) {
        this.log.info(`File ${operation}: ${path} (v${response.version})`);
      } else {
        this.log.warn(`File patch failed on ${path}: ${response.reason}`);
      }
      return {
        success: response.success,
        version: response.version,
        reason: response.reason,
      };
    }

    return { success: false, reason: 'Unknown error' };
  }

  async getBlueprint(): Promise<Blueprint> {
    const response = await this.send({
      type: 'get_blueprint',
    });

    if (response.type === 'blueprint') {
      this.blueprint = response.blueprint;
      return response.blueprint;
    }

    throw new Error('Failed to get blueprint');
  }

  async getEventsSince(cursor: number): Promise<Event[]> {
    const response = await this.send({
      type: 'get_events',
      sinceCursor: cursor,
    });

    if (response.type === 'events') {
      this.cursor = response.cursor;
      return response.events;
    }

    return [];
  }

  async reportTest(
    testName: string,
    status: 'started' | 'passed' | 'failed',
    details?: string,
    errors?: string[]
  ): Promise<void> {
    await this.send({
      type: 'report_test',
      testName,
      status,
      details,
      errors,
    });
  }

  // ========================================
  // EVENT HANDLERS (Override in subclasses)
  // ========================================

  protected onIntentConflict(data: { newIntent: Intent; conflictingIntents: Intent[] }): void {
    this.log.warn(`Intent conflict detected with ${data.conflictingIntents.length} other intent(s)`);
  }

  protected onLockConflict(data: { target: string; holdingAgent: string }): void {
    this.log.warn(`Lock conflict on ${data.target}, held by ${data.holdingAgent}`);
  }

  protected onFileConflict(data: { path: string; holdingAgent: string }): void {
    this.log.warn(`File conflict on ${data.path}, locked by ${data.holdingAgent}`);
  }

  protected onLockReleased(lockId: string, target: string): void {
    this.log.debug(`Lock released: ${target}`);
  }

  protected onFileChanged(path: string, version: number): void {
    this.log.debug(`File changed: ${path} (v${version})`);
  }

  protected onTestFailed(testName: string, errors?: string[]): void {
    this.log.warn(`Test failed: ${testName}`);
  }

  // ========================================
  // ABSTRACT METHODS
  // ========================================

  abstract execute(): Promise<void>;

  // ========================================
  // UTILITIES
  // ========================================

  onEvent(handler: (event: Event) => void): void {
    this.eventHandlers.push(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  getAgentId(): string | null {
    return this.agent?.id || null;
  }

  getCurrentCursor(): number {
    return this.cursor;
  }

  getBlueprrintCache(): Blueprint | null {
    return this.blueprint;
  }

  async waitForEvent(eventType: string, timeout: number = 10000): Promise<Event> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for event: ${eventType}`));
      }, timeout);

      const handler = (event: Event) => {
        if (event.type === eventType) {
          clearTimeout(timer);
          const idx = this.eventHandlers.indexOf(handler);
          if (idx >= 0) this.eventHandlers.splice(idx, 1);
          resolve(event);
        }
      };

      this.eventHandlers.push(handler);
    });
  }

  async delay(ms: number): Promise<void> {
    return sleep(ms);
  }
}
