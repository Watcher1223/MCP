// Synapse - Shared Utilities

import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

export function generateId(): string {
  return uuidv4();
}

export function generateShortId(): string {
  return uuidv4().split('-')[0];
}

export function now(): number {
  return Date.now();
}

export function checksum(content: string): string {
  return createHash('md5').update(content).digest('hex');
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString();
}

export function truncate(str: string, length: number = 100): string {
  if (str.length <= length) return str;
  return str.slice(0, length - 3) + '...';
}

export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

export function mergePatch(original: string, patch: string): string {
  // Simple last-write-wins patch merge
  // In a real system, this could use operational transforms or diff-match-patch
  return patch;
}

export function applyDiff(original: string, diff: string): string {
  // Simplified diff application
  // For demo purposes, we treat diff as the new content
  return diff;
}

export function createDiff(original: string, modified: string): string {
  // Simplified diff creation
  // Returns unified diff format
  const originalLines = original.split('\n');
  const modifiedLines = modified.split('\n');

  let diff = '';
  const maxLines = Math.max(originalLines.length, modifiedLines.length);

  for (let i = 0; i < maxLines; i++) {
    const origLine = originalLines[i] ?? '';
    const modLine = modifiedLines[i] ?? '';

    if (origLine !== modLine) {
      if (originalLines[i] !== undefined) {
        diff += `-${origLine}\n`;
      }
      if (modifiedLines[i] !== undefined) {
        diff += `+${modLine}\n`;
      }
    } else {
      diff += ` ${origLine}\n`;
    }
  }

  return diff;
}

export function targetMatches(target1: string, target2: string): boolean {
  // Check if two targets overlap
  // A target is a path or semantic identifier

  // Exact match
  if (target1 === target2) return true;

  // One is prefix of another (parent directory)
  if (target1.startsWith(target2 + '/') || target2.startsWith(target1 + '/')) {
    return true;
  }

  // Semantic match (e.g., "function:login" matches "file:/api/auth.ts")
  // This is simplified - real implementation would parse identifiers
  return false;
}

export function parseTarget(target: string): { type: string; path: string; identifier?: string } {
  const parts = target.split(':');
  if (parts.length === 1) {
    return { type: 'file', path: parts[0] };
  }
  return {
    type: parts[0],
    path: parts[1],
    identifier: parts[2],
  };
}

export function formatTarget(type: string, path: string, identifier?: string): string {
  if (identifier) {
    return `${type}:${path}:${identifier}`;
  }
  return `${type}:${path}`;
}

// Event emitter for local use
export class EventEmitter<T extends Record<string, any[]> = Record<string, any[]>> {
  private listeners: Map<keyof T, Set<(...args: any[]) => void>> = new Map();

  on<K extends keyof T>(event: K, listener: (...args: T[K]) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return () => this.off(event, listener);
  }

  off<K extends keyof T>(event: K, listener: (...args: T[K]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit<K extends keyof T>(event: K, ...args: T[K]): void {
    this.listeners.get(event)?.forEach(listener => {
      try {
        listener(...args);
      } catch (error) {
        console.error(`Error in event listener for ${String(event)}:`, error);
      }
    });
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}

// Logger with colors
export const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
} as const;

export class Logger {
  private name: string;
  private level: number;

  constructor(name: string, level: number = LogLevel.INFO) {
    this.name = name;
    this.level = level;
  }

  private format(level: string, message: string): string {
    const timestamp = new Date().toISOString().slice(11, 23);
    return `[${timestamp}] [${level}] [${this.name}] ${message}`;
  }

  debug(message: string, ...args: any[]): void {
    if (this.level <= LogLevel.DEBUG) {
      console.log('\x1b[90m' + this.format('DEBUG', message) + '\x1b[0m', ...args);
    }
  }

  info(message: string, ...args: any[]): void {
    if (this.level <= LogLevel.INFO) {
      console.log('\x1b[36m' + this.format('INFO', message) + '\x1b[0m', ...args);
    }
  }

  warn(message: string, ...args: any[]): void {
    if (this.level <= LogLevel.WARN) {
      console.log('\x1b[33m' + this.format('WARN', message) + '\x1b[0m', ...args);
    }
  }

  error(message: string, ...args: any[]): void {
    if (this.level <= LogLevel.ERROR) {
      console.log('\x1b[31m' + this.format('ERROR', message) + '\x1b[0m', ...args);
    }
  }

  success(message: string, ...args: any[]): void {
    console.log('\x1b[32m' + this.format('SUCCESS', message) + '\x1b[0m', ...args);
  }
}
