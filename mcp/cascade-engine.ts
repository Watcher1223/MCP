// Synapse Cascade Engine
// Automatic propagation of changes across the system
// When backend changes → frontend adapts → tests update

import { generateId, now, Logger } from "../shared/utils.js";

const log = new Logger("CascadeEngine");

// ========================================
// API CONTRACT TRACKING
// ========================================

export interface APIField {
  name: string;
  type: string;
  required: boolean;
}

export interface APIContract {
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  requestSchema: APIField[];
  responseSchema: APIField[];
  version: number;
  lastUpdated: number;
}

export interface FrontendBinding {
  componentId: string;
  componentName: string;
  boundEndpoint: string;
  boundFields: string[];
  lastSynced: number;
  needsUpdate: boolean;
}

export interface FileSession {
  path: string;
  editors: { agentId: string; agentName: string; cursor?: number }[];
  pendingChanges: { agentId: string; range: [number, number]; newText: string }[];
  version: number;
  lastMerge: number;
}

export interface CascadeEvent {
  id: string;
  type: "contract_changed" | "endpoint_added" | "endpoint_removed" | "field_changed" | "conflict_resolved" | "frontend_adapted" | "test_triggered";
  source: string;
  target: string;
  details: string;
  timestamp: number;
}

// ========================================
// CASCADE ENGINE
// ========================================

export class CascadeEngine {
  private contracts: Map<string, APIContract> = new Map();
  private bindings: Map<string, FrontendBinding> = new Map();
  private fileSessions: Map<string, FileSession> = new Map();
  private cascadeLog: CascadeEvent[] = [];
  private subscribers: Set<(event: CascadeEvent) => void> = new Set();

  // ========================================
  // API CONTRACTS
  // ========================================

  registerContract(contract: APIContract): void {
    const key = `${contract.method}:${contract.endpoint}`;
    const existing = this.contracts.get(key);

    if (existing) {
      // Detect schema changes
      const reqChanged = JSON.stringify(existing.requestSchema) !== JSON.stringify(contract.requestSchema);
      const resChanged = JSON.stringify(existing.responseSchema) !== JSON.stringify(contract.responseSchema);

      if (reqChanged || resChanged) {
        contract.version = existing.version + 1;
        this.emitCascade("contract_changed", key, "all_bindings",
          `Schema v${contract.version}: ${reqChanged ? "request" : ""}${reqChanged && resChanged ? "+" : ""}${resChanged ? "response" : ""} changed`);

        // Cascade to frontend bindings
        this.cascadeToFrontend(key);
      }
    } else {
      contract.version = 1;
      this.emitCascade("endpoint_added", "system", key, `New endpoint: ${contract.method} ${contract.endpoint}`);
    }

    contract.lastUpdated = now();
    this.contracts.set(key, contract);
  }

  removeContract(method: string, endpoint: string): void {
    const key = `${method}:${endpoint}`;
    if (this.contracts.has(key)) {
      this.contracts.delete(key);
      this.emitCascade("endpoint_removed", key, "all_bindings", `Endpoint removed: ${method} ${endpoint}`);
      this.cascadeToFrontend(key);
    }
  }

  updateField(method: string, endpoint: string, fieldName: string, newType: string, inRequest: boolean): void {
    const key = `${method}:${endpoint}`;
    const contract = this.contracts.get(key);
    if (!contract) return;

    const schema = inRequest ? contract.requestSchema : contract.responseSchema;
    const field = schema.find(f => f.name === fieldName);

    if (field && field.type !== newType) {
      const oldType = field.type;
      field.type = newType;
      contract.version++;
      contract.lastUpdated = now();

      this.emitCascade("field_changed", key, "all_bindings",
        `Field '${fieldName}' changed: ${oldType} → ${newType}`);
      this.cascadeToFrontend(key);
    }
  }

  // ========================================
  // FRONTEND BINDINGS
  // ========================================

  bindFrontend(componentId: string, componentName: string, endpoint: string, fields: string[]): FrontendBinding {
    const binding: FrontendBinding = {
      componentId,
      componentName,
      boundEndpoint: endpoint,
      boundFields: fields,
      lastSynced: now(),
      needsUpdate: false,
    };

    this.bindings.set(componentId, binding);
    log.info(`Frontend binding: ${componentName} → ${endpoint}`);

    return binding;
  }

  private cascadeToFrontend(contractKey: string): void {
    for (const [id, binding] of this.bindings) {
      if (binding.boundEndpoint === contractKey || contractKey.includes(binding.boundEndpoint)) {
        binding.needsUpdate = true;
        this.emitCascade("frontend_adapted", contractKey, binding.componentName,
          `Component needs update: ${binding.componentName}`);
      }
    }
  }

  getOutdatedBindings(): FrontendBinding[] {
    return Array.from(this.bindings.values()).filter(b => b.needsUpdate);
  }

  markBindingSynced(componentId: string): void {
    const binding = this.bindings.get(componentId);
    if (binding) {
      binding.needsUpdate = false;
      binding.lastSynced = now();
    }
  }

  // ========================================
  // COLLABORATIVE EDITING
  // ========================================

  joinFile(path: string, agentId: string, agentName: string): FileSession {
    let session = this.fileSessions.get(path);

    if (!session) {
      session = {
        path,
        editors: [],
        pendingChanges: [],
        version: 0,
        lastMerge: now(),
      };
      this.fileSessions.set(path, session);
    }

    if (!session.editors.find(e => e.agentId === agentId)) {
      session.editors.push({ agentId, agentName });
      log.info(`${agentName} joined editing: ${path}`);
    }

    return session;
  }

  leaveFile(path: string, agentId: string): void {
    const session = this.fileSessions.get(path);
    if (session) {
      session.editors = session.editors.filter(e => e.agentId !== agentId);
      if (session.editors.length === 0) {
        this.fileSessions.delete(path);
      }
    }
  }

  proposeChange(path: string, agentId: string, range: [number, number], newText: string): { accepted: boolean; merged?: string; conflict?: string } {
    const session = this.fileSessions.get(path);
    if (!session) return { accepted: false, conflict: "No active session" };

    // Check for overlapping changes
    const overlapping = session.pendingChanges.find(c =>
      c.agentId !== agentId &&
      !(range[1] <= c.range[0] || range[0] >= c.range[1])
    );

    if (overlapping) {
      // Attempt automatic merge
      const merged = this.attemptMerge(session, { agentId, range, newText }, overlapping);
      if (merged) {
        session.version++;
        session.lastMerge = now();
        session.pendingChanges = session.pendingChanges.filter(c => c !== overlapping);

        this.emitCascade("conflict_resolved", path, "editors",
          `Auto-merged changes from ${session.editors.find(e => e.agentId === agentId)?.agentName || agentId}`);

        return { accepted: true, merged };
      } else {
        return {
          accepted: false,
          conflict: `Conflict with ${session.editors.find(e => e.agentId === overlapping.agentId)?.agentName || overlapping.agentId}`
        };
      }
    }

    // No conflict, accept change
    session.pendingChanges.push({ agentId, range, newText });
    session.version++;

    return { accepted: true };
  }

  private attemptMerge(
    session: FileSession,
    change1: { agentId: string; range: [number, number]; newText: string },
    change2: { agentId: string; range: [number, number]; newText: string }
  ): string | null {
    // Simple merge strategy: if changes are adjacent or one contains the other, merge them
    const [start1, end1] = change1.range;
    const [start2, end2] = change2.range;

    // One contains the other - take the larger change
    if (start1 <= start2 && end1 >= end2) {
      return change1.newText;
    }
    if (start2 <= start1 && end2 >= end1) {
      return change2.newText;
    }

    // Adjacent changes - concatenate
    if (end1 === start2) {
      return change1.newText + change2.newText;
    }
    if (end2 === start1) {
      return change2.newText + change1.newText;
    }

    // Overlapping but not mergeable automatically
    // Use operational transform approach: both changes applied sequentially
    if (start1 < start2) {
      return change1.newText + change2.newText;
    } else {
      return change2.newText + change1.newText;
    }
  }

  commitChanges(path: string): { version: number; changes: number } {
    const session = this.fileSessions.get(path);
    if (!session) return { version: 0, changes: 0 };

    const count = session.pendingChanges.length;
    session.pendingChanges = [];

    return { version: session.version, changes: count };
  }

  getFileSessions(): FileSession[] {
    return Array.from(this.fileSessions.values());
  }

  // ========================================
  // CASCADE LOG
  // ========================================

  private emitCascade(type: CascadeEvent["type"], source: string, target: string, details: string): void {
    const event: CascadeEvent = {
      id: generateId(),
      type,
      source,
      target,
      details,
      timestamp: now(),
    };

    this.cascadeLog.push(event);
    if (this.cascadeLog.length > 100) {
      this.cascadeLog = this.cascadeLog.slice(-100);
    }

    log.info(`CASCADE: ${type} | ${source} → ${target} | ${details}`);

    for (const sub of this.subscribers) {
      try { sub(event); } catch {}
    }
  }

  getCascadeLog(limit = 20): CascadeEvent[] {
    return this.cascadeLog.slice(-limit);
  }

  subscribe(callback: (event: CascadeEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  // ========================================
  // SNAPSHOT
  // ========================================

  getSnapshot(): {
    contracts: APIContract[];
    bindings: FrontendBinding[];
    fileSessions: FileSession[];
    recentCascades: CascadeEvent[];
  } {
    return {
      contracts: Array.from(this.contracts.values()),
      bindings: Array.from(this.bindings.values()),
      fileSessions: Array.from(this.fileSessions.values()),
      recentCascades: this.cascadeLog.slice(-10),
    };
  }
}

// Singleton
export const cascadeEngine = new CascadeEngine();
