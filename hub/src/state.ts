// Synapse Hub - State Manager
// Manages the shared working memory state

import {
  Agent,
  Lock,
  Intent,
  FileState,
  Event,
  Blueprint,
  EventType,
  LockTarget,
  FilePatch,
} from '../../shared/types.js';
import { generateId, now, checksum, targetMatches, Logger } from '../../shared/utils.js';

const log = new Logger('StateManager');

export class StateManager {
  private agents: Map<string, Agent> = new Map();
  private locks: Map<string, Lock> = new Map();
  private intents: Map<string, Intent> = new Map();
  private files: Map<string, FileState> = new Map();
  private events: Event[] = [];
  private cursor: number = 0;
  private version: number = 0;
  private lockCleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start lock expiration checker
    this.lockCleanupInterval = setInterval(() => this.cleanupExpiredLocks(), 1000);
  }

  destroy(): void {
    if (this.lockCleanupInterval) {
      clearInterval(this.lockCleanupInterval);
    }
  }

  // ========================================
  // AGENT MANAGEMENT
  // ========================================

  registerAgent(agent: Omit<Agent, 'connectedAt' | 'lastSeen' | 'cursor'>): Agent {
    const fullAgent: Agent = {
      ...agent,
      connectedAt: now(),
      lastSeen: now(),
      cursor: this.cursor,
    };

    this.agents.set(agent.id, fullAgent);
    this.emitEvent('agent_connected', agent.id, { agent: fullAgent });

    log.info(`Agent registered: ${agent.name} (${agent.id}) as ${agent.role}`);
    return fullAgent;
  }

  unregisterAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Release all locks held by this agent
    for (const [lockId, lock] of this.locks) {
      if (lock.agentId === agentId) {
        this.releaseLock(lockId, agentId);
      }
    }

    // Cancel pending intents
    for (const [intentId, intent] of this.intents) {
      if (intent.agentId === agentId && intent.status === 'pending') {
        this.updateIntent(intentId, { status: 'cancelled' });
      }
    }

    this.agents.delete(agentId);
    this.emitEvent('agent_disconnected', agentId, { agentId });

    log.info(`Agent disconnected: ${agent.name} (${agentId})`);
  }

  updateAgentHeartbeat(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.lastSeen = now();
    }
  }

  getAgent(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  getAllAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  // ========================================
  // LOCK MANAGEMENT
  // ========================================

  requestLock(
    agentId: string,
    target: LockTarget,
    ttl: number = 30000,
    intent?: string
  ): { success: boolean; lockId?: string; reason?: string; conflictingAgent?: string; suggestedAction?: string } {
    // Check for existing locks on overlapping targets
    const targetKey = this.formatLockTarget(target);

    for (const [existingLockId, existingLock] of this.locks) {
      const existingKey = this.formatLockTarget(existingLock.target);

      if (targetMatches(targetKey, existingKey)) {
        if (existingLock.agentId === agentId) {
          // Agent already holds this lock, extend it
          existingLock.ttl = ttl;
          existingLock.expiresAt = now() + ttl;
          return { success: true, lockId: existingLockId };
        }

        // Conflict with another agent
        const conflictingAgent = this.agents.get(existingLock.agentId);
        this.emitEvent('lock_conflict', agentId, {
          requestingAgent: agentId,
          holdingAgent: existingLock.agentId,
          target: targetKey,
          existingLockId,
        });

        return {
          success: false,
          reason: `Target is locked by ${conflictingAgent?.name || existingLock.agentId}`,
          conflictingAgent: existingLock.agentId,
          suggestedAction: `Wait for lock release or negotiate with ${conflictingAgent?.name}. Lock expires at ${new Date(existingLock.expiresAt).toISOString()}`,
        };
      }
    }

    // Create new lock
    const lockId = generateId();
    const lock: Lock = {
      id: lockId,
      agentId,
      target,
      acquiredAt: now(),
      ttl,
      expiresAt: now() + ttl,
      intent,
    };

    this.locks.set(lockId, lock);
    this.emitEvent('lock_acquired', agentId, { lock });

    log.info(`Lock acquired: ${targetKey} by ${agentId}`);
    return { success: true, lockId };
  }

  releaseLock(lockId: string, agentId: string): boolean {
    const lock = this.locks.get(lockId);
    if (!lock) return false;

    if (lock.agentId !== agentId) {
      log.warn(`Agent ${agentId} tried to release lock owned by ${lock.agentId}`);
      return false;
    }

    this.locks.delete(lockId);
    this.emitEvent('lock_released', agentId, { lockId, target: this.formatLockTarget(lock.target) });

    log.info(`Lock released: ${this.formatLockTarget(lock.target)} by ${agentId}`);
    return true;
  }

  private cleanupExpiredLocks(): void {
    const currentTime = now();
    for (const [lockId, lock] of this.locks) {
      if (lock.expiresAt < currentTime) {
        this.locks.delete(lockId);
        this.emitEvent('lock_expired', lock.agentId, {
          lockId,
          target: this.formatLockTarget(lock.target),
        });
        log.info(`Lock expired: ${this.formatLockTarget(lock.target)}`);
      }
    }
  }

  getLock(lockId: string): Lock | undefined {
    return this.locks.get(lockId);
  }

  getAllLocks(): Lock[] {
    return Array.from(this.locks.values());
  }

  getAgentLocks(agentId: string): Lock[] {
    return Array.from(this.locks.values()).filter(l => l.agentId === agentId);
  }

  private formatLockTarget(target: LockTarget): string {
    let key = `${target.type}:${target.path}`;
    if (target.identifier) key += `:${target.identifier}`;
    return key;
  }

  // ========================================
  // INTENT MANAGEMENT
  // ========================================

  createIntent(agentId: string, intentData: Omit<Intent, 'id' | 'createdAt' | 'updatedAt'>): Intent {
    const intent: Intent = {
      ...intentData,
      id: generateId(),
      createdAt: now(),
      updatedAt: now(),
    };

    // Check for conflicting intents
    const conflicts = this.findConflictingIntents(intent);
    if (conflicts.length > 0) {
      this.emitEvent('intent_conflict', agentId, {
        newIntent: intent,
        conflictingIntents: conflicts,
      });
    }

    this.intents.set(intent.id, intent);
    this.emitEvent('intent_broadcast', agentId, { intent });

    log.info(`Intent created: ${intent.action} by ${agentId}`);
    return intent;
  }

  updateIntent(intentId: string, updates: Partial<Pick<Intent, 'status' | 'description'>>): Intent | undefined {
    const intent = this.intents.get(intentId);
    if (!intent) return undefined;

    Object.assign(intent, updates, { updatedAt: now() });

    if (updates.status === 'completed') {
      this.emitEvent('intent_completed', intent.agentId, { intent });
    } else if (updates.status === 'cancelled') {
      this.emitEvent('intent_cancelled', intent.agentId, { intent });
    } else {
      this.emitEvent('intent_updated', intent.agentId, { intent });
    }

    return intent;
  }

  private findConflictingIntents(newIntent: Intent): Intent[] {
    return Array.from(this.intents.values()).filter(existing => {
      if (existing.id === newIntent.id) return false;
      if (existing.status !== 'pending' && existing.status !== 'active') return false;

      // Check for overlapping targets
      return existing.targets.some(t1 =>
        newIntent.targets.some(t2 => targetMatches(t1, t2))
      );
    });
  }

  getIntent(intentId: string): Intent | undefined {
    return this.intents.get(intentId);
  }

  getAllIntents(): Intent[] {
    return Array.from(this.intents.values());
  }

  getActiveIntents(): Intent[] {
    return Array.from(this.intents.values()).filter(
      i => i.status === 'pending' || i.status === 'active'
    );
  }

  // ========================================
  // FILE MANAGEMENT
  // ========================================

  applyFilePatch(
    agentId: string,
    patch: FilePatch,
    lockId?: string
  ): { success: boolean; version?: number; reason?: string } {
    const path = patch.path;

    // Check if agent has lock (optional for some operations)
    if (lockId) {
      const lock = this.locks.get(lockId);
      if (!lock || lock.agentId !== agentId) {
        return { success: false, reason: 'Invalid or expired lock' };
      }
    }

    // Check if another agent has a lock on this file
    for (const lock of this.locks.values()) {
      if (lock.agentId !== agentId && targetMatches(lock.target.path, path)) {
        const holdingAgent = this.agents.get(lock.agentId);
        this.emitEvent('file_conflict', agentId, {
          path,
          holdingAgent: lock.agentId,
          patchingAgent: agentId,
        });
        return {
          success: false,
          reason: `File is locked by ${holdingAgent?.name || lock.agentId}`,
        };
      }
    }

    const existingFile = this.files.get(path);
    let newVersion = 1;
    let eventType: EventType = 'file_modified';

    switch (patch.operation) {
      case 'create':
        if (existingFile) {
          return { success: false, reason: 'File already exists' };
        }
        eventType = 'file_created';
        break;

      case 'modify':
        if (!existingFile && !patch.content) {
          return { success: false, reason: 'File does not exist' };
        }
        newVersion = (existingFile?.version || 0) + 1;
        break;

      case 'delete':
        if (!existingFile) {
          return { success: false, reason: 'File does not exist' };
        }
        this.files.delete(path);
        this.emitEvent('file_deleted', agentId, { path });
        log.info(`File deleted: ${path} by ${agentId}`);
        return { success: true, version: 0 };

      case 'rename':
        if (!existingFile) {
          return { success: false, reason: 'File does not exist' };
        }
        if (!patch.oldPath) {
          return { success: false, reason: 'Old path required for rename' };
        }
        this.files.delete(patch.oldPath);
        eventType = 'file_renamed';
        break;
    }

    const content = patch.content || patch.diff || '';
    const fileState: FileState = {
      path,
      content,
      version: newVersion,
      lastModifiedBy: agentId,
      lastModifiedAt: now(),
      checksum: checksum(content),
    };

    this.files.set(path, fileState);
    this.emitEvent(eventType, agentId, {
      path,
      version: newVersion,
      operation: patch.operation,
      oldPath: patch.oldPath,
    });

    log.info(`File ${patch.operation}: ${path} by ${agentId} (v${newVersion})`);
    return { success: true, version: newVersion };
  }

  getFile(path: string): FileState | undefined {
    return this.files.get(path);
  }

  getAllFiles(): Record<string, FileState> {
    const result: Record<string, FileState> = {};
    for (const [path, file] of this.files) {
      result[path] = file;
    }
    return result;
  }

  // ========================================
  // EVENT MANAGEMENT
  // ========================================

  private emitEvent(type: EventType, agentId: string, data: Record<string, any>): Event {
    this.cursor++;
    this.version++;

    const event: Event = {
      id: generateId(),
      cursor: this.cursor,
      type,
      agentId,
      timestamp: now(),
      data,
    };

    this.events.push(event);

    // Keep only last 1000 events in memory
    if (this.events.length > 1000) {
      this.events = this.events.slice(-1000);
    }

    return event;
  }

  getEventsSince(cursor: number, limit: number = 100): Event[] {
    return this.events
      .filter(e => e.cursor > cursor)
      .slice(0, limit);
  }

  getLatestEvents(count: number = 50): Event[] {
    return this.events.slice(-count);
  }

  getCurrentCursor(): number {
    return this.cursor;
  }

  // ========================================
  // BLUEPRINT (Full State Snapshot)
  // ========================================

  getBlueprint(): Blueprint {
    return {
      version: this.version,
      timestamp: now(),
      agents: this.getAllAgents(),
      locks: this.getAllLocks(),
      intents: this.getAllIntents(),
      files: this.getAllFiles(),
      cursor: this.cursor,
    };
  }

  getBlueprintDelta(sinceCursor: number): { blueprint: Blueprint; events: Event[] } {
    return {
      blueprint: this.getBlueprint(),
      events: this.getEventsSince(sinceCursor),
    };
  }

  // ========================================
  // TEST SUPPORT
  // ========================================

  reportTest(agentId: string, testName: string, status: 'started' | 'passed' | 'failed', details?: string, errors?: string[]): void {
    const eventType: EventType = status === 'started' ? 'test_started' : status === 'passed' ? 'test_passed' : 'test_failed';
    this.emitEvent(eventType, agentId, { testName, status, details, errors });
    log.info(`Test ${status}: ${testName}`);
  }

  // ========================================
  // RESET (for testing)
  // ========================================

  reset(): void {
    this.agents.clear();
    this.locks.clear();
    this.intents.clear();
    this.files.clear();
    this.events = [];
    this.cursor = 0;
    this.version = 0;
    log.info('State reset');
  }
}
