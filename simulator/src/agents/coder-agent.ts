// Synapse Simulator - Coder Agent
// Simulates a coding AI like Cursor or VSCode agent

import { VirtualAgent } from '../virtual-agent.js';
import { Intent, Event, LockTarget } from '../../../shared/types.js';
import { sleep } from '../../../shared/utils.js';

interface PendingEdit {
  path: string;
  content: string;
  intentId?: string;
  retryCount: number;
}

export class CoderAgent extends VirtualAgent {
  private heldLocks: Map<string, string> = new Map(); // lockId -> path
  private pendingEdits: PendingEdit[] = [];
  private watchingIntents: boolean = false;

  constructor(name: string = 'Cursor-Coder') {
    super(name, 'coder', 'realtime', ['coding', 'editing', 'refactoring']);
  }

  async execute(): Promise<void> {
    this.log.info('Coder agent ready');
  }

  // ========================================
  // FILE OPERATIONS
  // ========================================

  async editFile(path: string, content: string, intentId?: string): Promise<boolean> {
    // Request lock first
    const lockResult = await this.requestLock(
      { type: 'file', path },
      30000,
      intentId
    );

    if (!lockResult.success) {
      // Queue for retry
      this.pendingEdits.push({ path, content, intentId, retryCount: 0 });
      this.log.warn(`Edit queued for retry: ${path}`);
      return false;
    }

    const lockId = lockResult.lockId!;
    this.heldLocks.set(lockId, path);

    // Apply the edit
    const patchResult = await this.patchFile(path, 'modify', content, lockId);

    // Release lock
    await this.releaseLock(lockId);
    this.heldLocks.delete(lockId);

    if (patchResult.success) {
      this.log.info(`File edited: ${path} (v${patchResult.version})`);
      return true;
    }

    return false;
  }

  async createFile(path: string, content: string, intentId?: string): Promise<boolean> {
    const lockResult = await this.requestLock(
      { type: 'file', path },
      30000,
      intentId
    );

    if (!lockResult.success) {
      return false;
    }

    const lockId = lockResult.lockId!;
    this.heldLocks.set(lockId, path);

    const patchResult = await this.patchFile(path, 'create', content, lockId);

    await this.releaseLock(lockId);
    this.heldLocks.delete(lockId);

    return patchResult.success;
  }

  async deleteFile(path: string): Promise<boolean> {
    const lockResult = await this.requestLock({ type: 'file', path }, 30000);

    if (!lockResult.success) {
      return false;
    }

    const lockId = lockResult.lockId!;
    const patchResult = await this.patchFile(path, 'delete', undefined, lockId);

    await this.releaseLock(lockId);

    return patchResult.success;
  }

  async renameFile(oldPath: string, newPath: string, content: string): Promise<boolean> {
    // Lock both paths
    const oldLock = await this.requestLock({ type: 'file', path: oldPath }, 30000);
    if (!oldLock.success) return false;

    const newLock = await this.requestLock({ type: 'file', path: newPath }, 30000);
    if (!newLock.success) {
      await this.releaseLock(oldLock.lockId!);
      return false;
    }

    // Delete old, create new
    await this.patchFile(oldPath, 'delete', undefined, oldLock.lockId);
    const result = await this.patchFile(newPath, 'create', content, newLock.lockId);

    await this.releaseLock(oldLock.lockId!);
    await this.releaseLock(newLock.lockId!);

    return result.success;
  }

  // ========================================
  // SCENARIO BEHAVIORS
  // ========================================

  async implementLogin(path: string = '/api/login.ts'): Promise<boolean> {
    const content = `
// Login API endpoint
export async function login(req: Request, res: Response) {
  const { email, password } = req.body;

  // Validate credentials
  const user = await validateCredentials(email, password);

  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Generate session token
  const token = await createSession(user.id);

  return res.json({ token, user: sanitizeUser(user) });
}
`;
    return await this.createFile(path, content);
  }

  async implementFeature(
    path: string,
    featureCode: string,
    intentId?: string
  ): Promise<boolean> {
    return await this.createFile(path, featureCode, intentId);
  }

  async updateSchemaUsage(
    path: string,
    newContent: string,
    intentId?: string
  ): Promise<boolean> {
    return await this.editFile(path, newContent, intentId);
  }

  async fixCode(path: string, fixedContent: string): Promise<boolean> {
    return await this.editFile(path, fixedContent);
  }

  // ========================================
  // CONFLICT HANDLING
  // ========================================

  protected onLockConflict(data: { target: string; holdingAgent: string }): void {
    super.onLockConflict(data);

    // Find pending edit for this target and increment retry
    const pending = this.pendingEdits.find(e => e.path === data.target);
    if (pending) {
      pending.retryCount++;
      this.log.info(`Will retry edit on ${data.target} (attempt ${pending.retryCount})`);
    }
  }

  protected onLockReleased(lockId: string, target: string): void {
    super.onLockReleased(lockId, target);

    // Try to process pending edits for this target
    const pendingIndex = this.pendingEdits.findIndex(e => e.path === target);
    if (pendingIndex >= 0) {
      const pending = this.pendingEdits.splice(pendingIndex, 1)[0];
      this.log.info(`Retrying pending edit for ${target}`);
      this.editFile(pending.path, pending.content, pending.intentId);
    }
  }

  protected onFileChanged(path: string, version: number): void {
    super.onFileChanged(path, version);

    // Remove any pending edits for this file (someone else edited it)
    const pendingIndex = this.pendingEdits.findIndex(e => e.path === path);
    if (pendingIndex >= 0) {
      this.log.info(`Dropping pending edit for ${path} - file was modified by another agent`);
      this.pendingEdits.splice(pendingIndex, 1);
    }
  }

  // Watch for intents that target files this agent should implement
  enableIntentWatcher(): void {
    this.watchingIntents = true;
    this.onEvent(async (event) => {
      if (event.type === 'intent_broadcast' && this.watchingIntents) {
        const intent = event.data.intent as Intent;
        if (intent.action.includes('implement') || intent.action.includes('fix')) {
          this.log.info(`Picked up intent: ${intent.action}`);
          // In a real scenario, the coder would analyze the intent
          // and start implementing
        }
      }
    });
  }

  // Release all held locks
  async releaseAllLocks(): Promise<void> {
    for (const [lockId, path] of this.heldLocks) {
      await this.releaseLock(lockId);
      this.log.info(`Released lock on ${path}`);
    }
    this.heldLocks.clear();
  }
}
