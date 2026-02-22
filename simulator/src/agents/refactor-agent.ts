// Synapse Simulator - Refactor Agent
// Simulates a second coder agent focused on refactoring

import { VirtualAgent } from '../virtual-agent.js';
import { Intent, Event } from '../../../shared/types.js';
import { sleep } from '../../../shared/utils.js';

export class RefactorAgent extends VirtualAgent {
  private heldLocks: Map<string, string> = new Map();
  private pendingRefactors: Array<{ oldPath: string; newPath: string; content: string }> = [];

  constructor(name: string = 'Refactor-Agent') {
    super(name, 'refactor', 'realtime', ['refactoring', 'renaming', 'restructuring']);
  }

  async execute(): Promise<void> {
    this.log.info('Refactor agent ready');
  }

  // ========================================
  // REFACTORING OPERATIONS
  // ========================================

  async renameFile(oldPath: string, newPath: string): Promise<boolean> {
    this.log.info(`Renaming file: ${oldPath} -> ${newPath}`);

    // Get current file content
    const blueprint = await this.getBlueprint();
    const file = blueprint.files[oldPath];

    if (!file) {
      this.log.error(`File not found: ${oldPath}`);
      return false;
    }

    // Lock old path
    const oldLock = await this.requestLock(
      { type: 'file', path: oldPath },
      60000,
      'rename'
    );

    if (!oldLock.success) {
      this.log.warn(`Cannot lock ${oldPath} for rename, queueing...`);
      this.pendingRefactors.push({ oldPath, newPath, content: file.content });
      return false;
    }

    // Lock new path
    const newLock = await this.requestLock(
      { type: 'file', path: newPath },
      60000,
      'rename'
    );

    if (!newLock.success) {
      await this.releaseLock(oldLock.lockId!);
      this.log.warn(`Cannot lock ${newPath} for rename`);
      return false;
    }

    this.heldLocks.set(oldLock.lockId!, oldPath);
    this.heldLocks.set(newLock.lockId!, newPath);

    try {
      // Create new file
      const createResult = await this.patchFile(newPath, 'create', file.content, newLock.lockId);
      if (!createResult.success) {
        throw new Error(`Failed to create ${newPath}`);
      }

      // Delete old file
      const deleteResult = await this.patchFile(oldPath, 'delete', undefined, oldLock.lockId);
      if (!deleteResult.success) {
        throw new Error(`Failed to delete ${oldPath}`);
      }

      this.log.success(`Renamed: ${oldPath} -> ${newPath}`);
      return true;
    } catch (error: any) {
      this.log.error(`Rename failed: ${error.message}`);
      return false;
    } finally {
      // Release locks
      await this.releaseLock(oldLock.lockId!);
      await this.releaseLock(newLock.lockId!);
      this.heldLocks.delete(oldLock.lockId!);
      this.heldLocks.delete(newLock.lockId!);
    }
  }

  async extractFunction(
    sourcePath: string,
    functionName: string,
    newFilePath: string,
    extractedCode: string,
    updatedSourceCode: string
  ): Promise<boolean> {
    this.log.info(`Extracting function ${functionName} to ${newFilePath}`);

    // Lock both files
    const sourceLock = await this.requestLock(
      { type: 'file', path: sourcePath },
      60000,
      'extract'
    );

    if (!sourceLock.success) {
      return false;
    }

    const newLock = await this.requestLock(
      { type: 'file', path: newFilePath },
      60000,
      'extract'
    );

    if (!newLock.success) {
      await this.releaseLock(sourceLock.lockId!);
      return false;
    }

    try {
      // Create new file with extracted function
      const createResult = await this.patchFile(
        newFilePath,
        'create',
        extractedCode,
        newLock.lockId
      );

      if (!createResult.success) {
        throw new Error('Failed to create extracted file');
      }

      // Update source file to import from new file
      const updateResult = await this.patchFile(
        sourcePath,
        'modify',
        updatedSourceCode,
        sourceLock.lockId
      );

      if (!updateResult.success) {
        throw new Error('Failed to update source file');
      }

      this.log.success(`Extracted ${functionName} to ${newFilePath}`);
      return true;
    } catch (error: any) {
      this.log.error(`Extraction failed: ${error.message}`);
      return false;
    } finally {
      await this.releaseLock(sourceLock.lockId!);
      await this.releaseLock(newLock.lockId!);
    }
  }

  async updateImports(
    files: string[],
    oldImport: string,
    newImport: string
  ): Promise<number> {
    let updated = 0;
    const blueprint = await this.getBlueprint();

    for (const filePath of files) {
      const file = blueprint.files[filePath];
      if (!file) continue;

      if (file.content.includes(oldImport)) {
        const newContent = file.content.replace(
          new RegExp(oldImport, 'g'),
          newImport
        );

        const lockResult = await this.requestLock(
          { type: 'file', path: filePath },
          30000,
          'update-imports'
        );

        if (lockResult.success) {
          const patchResult = await this.patchFile(
            filePath,
            'modify',
            newContent,
            lockResult.lockId
          );

          await this.releaseLock(lockResult.lockId!);

          if (patchResult.success) {
            updated++;
          }
        }
      }
    }

    this.log.info(`Updated imports in ${updated} files`);
    return updated;
  }

  // ========================================
  // CONFLICT HANDLING
  // ========================================

  protected onLockConflict(data: { target: string; holdingAgent: string }): void {
    super.onLockConflict(data);

    // If we're trying to refactor a file that's being edited,
    // we should wait and retry
    this.log.info(`Waiting for ${data.target} to be released by ${data.holdingAgent}`);
  }

  protected onLockReleased(lockId: string, target: string): void {
    super.onLockReleased(lockId, target);

    // Check if we have a pending refactor for this target
    const pendingIndex = this.pendingRefactors.findIndex(
      r => r.oldPath === target || r.newPath === target
    );

    if (pendingIndex >= 0) {
      const pending = this.pendingRefactors.splice(pendingIndex, 1)[0];
      this.log.info(`Retrying pending rename: ${pending.oldPath} -> ${pending.newPath}`);
      this.renameFile(pending.oldPath, pending.newPath);
    }
  }

  protected onFileChanged(path: string, version: number): void {
    super.onFileChanged(path, version);

    // If a file we're tracking for refactor was changed, update our content
    const pending = this.pendingRefactors.find(r => r.oldPath === path);
    if (pending) {
      this.getBlueprint().then(blueprint => {
        const file = blueprint.files[path];
        if (file) {
          pending.content = file.content;
        }
      });
    }
  }

  // ========================================
  // UTILITIES
  // ========================================

  async releaseAllLocks(): Promise<void> {
    for (const [lockId, path] of this.heldLocks) {
      await this.releaseLock(lockId);
      this.log.info(`Released lock on ${path}`);
    }
    this.heldLocks.clear();
  }
}
