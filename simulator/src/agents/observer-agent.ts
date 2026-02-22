// Synapse Simulator - Observer Agent
// Simulates a local filesystem observer/daemon

import { VirtualAgent } from '../virtual-agent.js';
import { Event, FilePatch, Blueprint } from '../../../shared/types.js';
import { sleep } from '../../../shared/utils.js';

interface LocalFile {
  path: string;
  content: string;
  version: number;
  syncedWithHub: boolean;
}

export class ObserverAgent extends VirtualAgent {
  private localFiles: Map<string, LocalFile> = new Map();
  private watchingHub: boolean = false;
  private pendingSync: string[] = [];

  constructor(name: string = 'Local-Observer') {
    super(name, 'observer', 'observer', ['filesystem', 'sync', 'watch']);
  }

  async execute(): Promise<void> {
    this.log.info('Observer agent ready');

    // Sync initial state
    await this.syncFromHub();
  }

  // ========================================
  // FILESYSTEM OPERATIONS
  // ========================================

  async syncFromHub(): Promise<void> {
    const blueprint = await this.getBlueprint();

    for (const [path, file] of Object.entries(blueprint.files)) {
      const localFile: LocalFile = {
        path,
        content: file.content,
        version: file.version,
        syncedWithHub: true,
      };
      this.localFiles.set(path, localFile);
    }

    this.log.info(`Synced ${Object.keys(blueprint.files).length} files from hub`);
  }

  async applyPatch(patch: FilePatch): Promise<boolean> {
    this.log.info(`Applying patch: ${patch.operation} ${patch.path}`);

    switch (patch.operation) {
      case 'create':
        this.localFiles.set(patch.path, {
          path: patch.path,
          content: patch.content || '',
          version: 1,
          syncedWithHub: true,
        });
        this.log.info(`Created file: ${patch.path}`);
        return true;

      case 'modify':
        const existing = this.localFiles.get(patch.path);
        if (existing) {
          existing.content = patch.content || patch.diff || existing.content;
          existing.version++;
          existing.syncedWithHub = true;
          this.log.info(`Modified file: ${patch.path}`);
          return true;
        }
        return false;

      case 'delete':
        const deleted = this.localFiles.delete(patch.path);
        if (deleted) {
          this.log.info(`Deleted file: ${patch.path}`);
        }
        return deleted;

      case 'rename':
        const oldFile = this.localFiles.get(patch.oldPath!);
        if (oldFile) {
          this.localFiles.delete(patch.oldPath!);
          this.localFiles.set(patch.path, {
            ...oldFile,
            path: patch.path,
          });
          this.log.info(`Renamed file: ${patch.oldPath} -> ${patch.path}`);
          return true;
        }
        return false;
    }

    return false;
  }

  getLocalFile(path: string): LocalFile | undefined {
    return this.localFiles.get(path);
  }

  getAllLocalFiles(): LocalFile[] {
    return Array.from(this.localFiles.values());
  }

  // ========================================
  // IMPLEMENTATION SUPPORT
  // ========================================

  async implementFromIntent(
    intentId: string,
    implementations: Array<{ path: string; content: string }>
  ): Promise<boolean> {
    this.log.info(`Implementing intent: ${intentId}`);

    let success = true;

    for (const impl of implementations) {
      // Create or update local file
      const existing = this.localFiles.get(impl.path);
      const operation = existing ? 'modify' : 'create';

      // Apply to hub
      const result = await this.patchFile(impl.path, operation, impl.content);

      if (result.success) {
        this.localFiles.set(impl.path, {
          path: impl.path,
          content: impl.content,
          version: result.version || 1,
          syncedWithHub: true,
        });
      } else {
        success = false;
        this.log.error(`Failed to implement: ${impl.path}`);
      }
    }

    return success;
  }

  async executeCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Simulate command execution
    this.log.info(`Executing: ${command}`);

    // For simulation, we return mock results
    await sleep(100);

    if (command.startsWith('npm test')) {
      return {
        stdout: 'Tests passed',
        stderr: '',
        exitCode: 0,
      };
    }

    if (command.startsWith('npm run build')) {
      return {
        stdout: 'Build successful',
        stderr: '',
        exitCode: 0,
      };
    }

    return {
      stdout: `Executed: ${command}`,
      stderr: '',
      exitCode: 0,
    };
  }

  // ========================================
  // HUB SYNCHRONIZATION
  // ========================================

  enableHubWatch(): void {
    this.watchingHub = true;

    this.onEvent(async (event) => {
      if (!this.watchingHub) return;

      switch (event.type) {
        case 'file_created':
        case 'file_modified':
        case 'file_deleted':
        case 'file_renamed':
          await this.handleFileEvent(event);
          break;

        case 'intent_broadcast':
          await this.handleIntentEvent(event);
          break;
      }
    });

    this.log.info('Hub watch enabled');
  }

  disableHubWatch(): void {
    this.watchingHub = false;
  }

  private async handleFileEvent(event: Event): Promise<void> {
    const path = event.data.path as string;
    const operation = event.data.operation as string;

    this.log.debug(`File event: ${operation} ${path}`);

    // Sync the file from hub
    const blueprint = await this.getBlueprint();
    const file = blueprint.files[path];

    if (operation === 'delete') {
      this.localFiles.delete(path);
    } else if (file) {
      this.localFiles.set(path, {
        path,
        content: file.content,
        version: file.version,
        syncedWithHub: true,
      });
    }
  }

  private async handleIntentEvent(event: Event): Promise<void> {
    const intent = event.data.intent;

    // Check if this is an implementation request
    if (intent.action.includes('implement') && event.agentId !== this.getAgentId()) {
      this.log.info(`Received implementation intent from ${event.agentId}`);
      // Observer could trigger local tools or scripts here
    }
  }

  // ========================================
  // DIFF REPORTING
  // ========================================

  async reportLocalChanges(): Promise<Array<{ path: string; status: 'added' | 'modified' | 'deleted' }>> {
    const blueprint = await this.getBlueprint();
    const changes: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }> = [];

    // Check for local additions/modifications
    for (const [path, localFile] of this.localFiles) {
      const hubFile = blueprint.files[path];

      if (!hubFile) {
        changes.push({ path, status: 'added' });
      } else if (localFile.content !== hubFile.content) {
        changes.push({ path, status: 'modified' });
      }
    }

    // Check for deletions
    for (const path of Object.keys(blueprint.files)) {
      if (!this.localFiles.has(path)) {
        changes.push({ path, status: 'deleted' });
      }
    }

    return changes;
  }

  async pushLocalChanges(): Promise<number> {
    const changes = await this.reportLocalChanges();
    let pushed = 0;

    for (const change of changes) {
      const localFile = this.localFiles.get(change.path);

      if (change.status === 'deleted') {
        const result = await this.patchFile(change.path, 'delete');
        if (result.success) pushed++;
      } else if (localFile) {
        const operation = change.status === 'added' ? 'create' : 'modify';
        const result = await this.patchFile(change.path, operation, localFile.content);
        if (result.success) {
          localFile.syncedWithHub = true;
          pushed++;
        }
      }
    }

    this.log.info(`Pushed ${pushed} local changes to hub`);
    return pushed;
  }
}
