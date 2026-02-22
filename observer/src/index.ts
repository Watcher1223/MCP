// Synapse Observer Daemon
// Local filesystem observer that syncs with the hub

import { watch } from 'chokidar';
import { readFile, writeFile, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join, relative } from 'path';
import WebSocket from 'ws';
import { Logger, generateId, checksum } from '../../shared/utils.js';
import { Event, FilePatch, FileState } from '../../shared/types.js';

const log = new Logger('Observer');

interface LocalFileState {
  path: string;
  content: string;
  checksum: string;
  lastSync: number;
}

class ObserverDaemon {
  private ws: WebSocket | null = null;
  private agentId: string | null = null;
  private cursor: number = 0;
  private workingDir: string;
  private localFiles: Map<string, LocalFileState> = new Map();
  private watcher: ReturnType<typeof watch> | null = null;
  private connected: boolean = false;
  private syncing: boolean = false;
  private ignorePatterns: string[] = [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/*.log',
    '**/package-lock.json',
    '**/yarn.lock',
    '**/pnpm-lock.yaml',
  ];

  constructor(
    workingDir: string = process.cwd(),
    private hubUrl: string = 'ws://localhost:3100'
  ) {
    this.workingDir = workingDir;
    log.info(`Working directory: ${workingDir}`);
  }

  async start(): Promise<void> {
    await this.connect();
    await this.initialSync();
    this.startFileWatcher();

    log.success('Observer daemon started');
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    log.info('Observer daemon stopped');
  }

  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.hubUrl);

      this.ws.on('open', async () => {
        log.info('Connected to hub');
        await this.register();
        this.connected = true;
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          log.error('Failed to parse message');
        }
      });

      this.ws.on('close', () => {
        this.connected = false;
        log.warn('Disconnected from hub');

        // Attempt to reconnect after 5 seconds
        setTimeout(() => {
          if (!this.connected) {
            log.info('Attempting to reconnect...');
            this.connect();
          }
        }, 5000);
      });

      this.ws.on('error', (error) => {
        log.error(`WebSocket error: ${error.message}`);
        reject(error);
      });
    });
  }

  private async register(): Promise<void> {
    this.send({
      type: 'register',
      agent: {
        id: generateId(),
        name: 'Local-Observer',
        type: 'observer',
        role: 'observer',
        capabilities: ['filesystem', 'sync', 'execute'],
      },
    });
  }

  private send(message: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private handleMessage(message: any): void {
    switch (message.type) {
      case 'registered':
        this.agentId = message.agentId;
        this.cursor = message.cursor;
        log.info(`Registered as ${this.agentId}`);

        // Subscribe to file events
        this.send({ type: 'subscribe', eventTypes: ['file_created', 'file_modified', 'file_deleted', 'file_renamed'] });
        break;

      case 'event':
        this.handleEvent(message.event);
        break;

      case 'blueprint':
        this.handleBlueprint(message.blueprint);
        break;

      case 'subscribed':
        log.info('Subscribed to file events');
        break;
    }
  }

  private async handleEvent(event: Event): Promise<void> {
    // Ignore our own events
    if (event.agentId === this.agentId) return;

    this.cursor = event.cursor;

    switch (event.type) {
      case 'file_created':
      case 'file_modified':
        await this.syncFileFromHub(event.data.path);
        break;

      case 'file_deleted':
        await this.deleteLocalFile(event.data.path);
        break;

      case 'file_renamed':
        await this.deleteLocalFile(event.data.oldPath);
        await this.syncFileFromHub(event.data.path);
        break;
    }
  }

  private async handleBlueprint(blueprint: any): Promise<void> {
    log.info(`Received blueprint with ${Object.keys(blueprint.files).length} files`);

    for (const [path, file] of Object.entries(blueprint.files)) {
      const fileState = file as FileState;
      const localFile = this.localFiles.get(path);

      if (!localFile || localFile.checksum !== fileState.checksum) {
        await this.writeLocalFile(path, fileState.content);
      }
    }
  }

  private async initialSync(): Promise<void> {
    log.info('Performing initial sync...');

    // Request full blueprint
    this.send({ type: 'get_blueprint' });
  }

  private async syncFileFromHub(path: string): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;

    try {
      const response = await fetch(`http://localhost:3100/api/file${path}`);
      if (response.ok) {
        const file = await response.json();
        await this.writeLocalFile(path, file.content);
        log.info(`Synced from hub: ${path}`);
      }
    } catch (error: any) {
      log.error(`Failed to sync ${path}: ${error.message}`);
    } finally {
      this.syncing = false;
    }
  }

  private async writeLocalFile(relativePath: string, content: string): Promise<void> {
    const fullPath = join(this.workingDir, relativePath);
    const dir = dirname(fullPath);

    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(fullPath, content, 'utf-8');

    this.localFiles.set(relativePath, {
      path: relativePath,
      content,
      checksum: checksum(content),
      lastSync: Date.now(),
    });
  }

  private async deleteLocalFile(relativePath: string): Promise<void> {
    const fullPath = join(this.workingDir, relativePath);

    try {
      if (existsSync(fullPath)) {
        await unlink(fullPath);
        log.info(`Deleted: ${relativePath}`);
      }
    } catch (error: any) {
      log.error(`Failed to delete ${relativePath}: ${error.message}`);
    }

    this.localFiles.delete(relativePath);
  }

  private startFileWatcher(): void {
    this.watcher = watch(this.workingDir, {
      ignored: this.ignorePatterns,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    this.watcher.on('add', (path) => this.handleLocalFileChange(path, 'create'));
    this.watcher.on('change', (path) => this.handleLocalFileChange(path, 'modify'));
    this.watcher.on('unlink', (path) => this.handleLocalFileChange(path, 'delete'));

    log.info('File watcher started');
  }

  private async handleLocalFileChange(
    fullPath: string,
    operation: 'create' | 'modify' | 'delete'
  ): Promise<void> {
    // Prevent sync loops
    if (this.syncing) return;

    const relativePath = '/' + relative(this.workingDir, fullPath);

    // Check if this is a file we just wrote from hub
    const localFile = this.localFiles.get(relativePath);
    if (localFile && Date.now() - localFile.lastSync < 1000) {
      return; // Skip - this is a file we just synced
    }

    this.syncing = true;

    try {
      if (operation === 'delete') {
        this.send({
          type: 'file_patch',
          patch: {
            path: relativePath,
            operation: 'delete',
          },
        });
        this.localFiles.delete(relativePath);
        log.info(`Pushed delete: ${relativePath}`);
      } else {
        const content = await readFile(fullPath, 'utf-8');
        const fileChecksum = checksum(content);

        // Skip if content hasn't actually changed
        if (localFile && localFile.checksum === fileChecksum) {
          return;
        }

        this.send({
          type: 'file_patch',
          patch: {
            path: relativePath,
            operation,
            content,
            checksum: fileChecksum,
          },
        });

        this.localFiles.set(relativePath, {
          path: relativePath,
          content,
          checksum: fileChecksum,
          lastSync: Date.now(),
        });

        log.info(`Pushed ${operation}: ${relativePath}`);
      }
    } catch (error: any) {
      log.error(`Failed to handle ${operation} for ${relativePath}: ${error.message}`);
    } finally {
      this.syncing = false;
    }
  }
}

// Run if executed directly
const isMain = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isMain) {
  const workingDir = process.argv[2] || process.cwd();
  const hubUrl = process.env.HUB_URL || 'ws://localhost:3100';

  const daemon = new ObserverDaemon(workingDir, hubUrl);

  process.on('SIGINT', async () => {
    await daemon.stop();
    process.exit(0);
  });

  daemon.start().catch((error) => {
    log.error(`Failed to start: ${error.message}`);
    process.exit(1);
  });
}

export default ObserverDaemon;
