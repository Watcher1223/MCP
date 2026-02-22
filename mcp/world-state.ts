// Synapse World State - Shared Cognition Runtime
// Structured belief graph for autonomous agent coordination

import { generateId, now, Logger } from "../shared/utils.js";

const log = new Logger("WorldState");

// ========================================
// DATA MODEL
// ========================================

export interface FileEntity {
  path: string;
  purpose: string;
  owned_by?: string;
  last_changed_by?: string;
  stability: "unknown" | "unstable" | "stable";
  last_updated: number;
}

export interface EndpointEntity {
  route: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  implemented: boolean;
  wired_to_frontend: boolean;
  tested: boolean;
  failing: boolean;
  last_updated: number;
}

export interface UIElement {
  id: string;
  name: string;
  connected_endpoint?: string;
  functional: boolean;
  last_updated: number;
}

export interface Flow {
  name: string;
  steps: string[];
  working: boolean;
  last_updated: number;
}

export interface Test {
  name: string;
  covers: string[];
  passing: boolean;
  last_run?: number;
}

export interface Goal {
  id: string;
  description: string;
  success_criteria: string[];
  status: "pending" | "in_progress" | "converging" | "satisfied" | "regressed";
  created_at: number;
  updated_at: number;
  assigned_to?: string;
}

export interface Observation {
  id: string;
  timestamp: number;
  agent: string;
  assertion: string;
  confidence: number; // 0-1
  source: "test" | "runtime" | "static" | "assumption";
}

export interface Conflict {
  id: string;
  assertion_a: string;
  assertion_b: string;
  resolution_status: "pending" | "resolved" | "deferred";
  resolved_by?: string;
  resolution?: string;
  created_at: number;
}

export interface WorkItem {
  id: string;
  goal_id: string;
  description: string;
  required_role: "planner" | "coder" | "tester" | "fixer";
  priority: number;
  status: "queued" | "assigned" | "completed";
  assigned_to?: string;
  created_at: number;
}

export interface WorldState {
  version: number;
  entities: {
    files: Map<string, FileEntity>;
    endpoints: Map<string, EndpointEntity>;
    ui_elements: Map<string, UIElement>;
    flows: Map<string, Flow>;
    tests: Map<string, Test>;
  };
  goals: Map<string, Goal>;
  observations: Observation[];
  conflicts: Conflict[];
  work_queue: WorkItem[];
  last_updated: number;
}

// ========================================
// WORLD STATE MANAGER
// ========================================

export class WorldStateManager {
  private state: WorldState;
  private subscribers: Set<(state: WorldState, change: any) => void> = new Set();
  private convergenceInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.state = {
      version: 0,
      entities: {
        files: new Map(),
        endpoints: new Map(),
        ui_elements: new Map(),
        flows: new Map(),
        tests: new Map(),
      },
      goals: new Map(),
      observations: [],
      conflicts: [],
      work_queue: [],
      last_updated: now(),
    };

    // Start convergence engine
    this.convergenceInterval = setInterval(() => this.runConvergenceLoop(), 2000);
  }

  destroy(): void {
    if (this.convergenceInterval) {
      clearInterval(this.convergenceInterval);
    }
  }

  // ========================================
  // READ
  // ========================================

  getState(): WorldState {
    return this.state;
  }

  getSnapshot(): any {
    return {
      version: this.state.version,
      entities: {
        files: Object.fromEntries(this.state.entities.files),
        endpoints: Object.fromEntries(this.state.entities.endpoints),
        ui_elements: Object.fromEntries(this.state.entities.ui_elements),
        flows: Object.fromEntries(this.state.entities.flows),
        tests: Object.fromEntries(this.state.entities.tests),
      },
      goals: Object.fromEntries(this.state.goals),
      observations: this.state.observations.slice(-50),
      conflicts: this.state.conflicts,
      work_queue: this.state.work_queue,
      last_updated: this.state.last_updated,
    };
  }

  // ========================================
  // UPDATE
  // ========================================

  applyPatch(patch: any): void {
    this.state.version++;
    this.state.last_updated = now();

    if (patch.files) {
      for (const [path, data] of Object.entries(patch.files)) {
        if (data === null) {
          this.state.entities.files.delete(path);
        } else {
          const existing = this.state.entities.files.get(path) || {
            path,
            purpose: "",
            stability: "unknown" as const,
            last_updated: now(),
          };
          this.state.entities.files.set(path, { ...existing, ...(data as any), last_updated: now() });
        }
      }
    }

    if (patch.endpoints) {
      for (const [key, data] of Object.entries(patch.endpoints)) {
        if (data === null) {
          this.state.entities.endpoints.delete(key);
        } else {
          const existing = this.state.entities.endpoints.get(key) || {
            route: key.split(":")[1] || key,
            method: (key.split(":")[0] || "GET") as any,
            implemented: false,
            wired_to_frontend: false,
            tested: false,
            failing: false,
            last_updated: now(),
          };
          this.state.entities.endpoints.set(key, { ...existing, ...(data as any), last_updated: now() });
        }
      }
    }

    if (patch.ui_elements) {
      for (const [id, data] of Object.entries(patch.ui_elements)) {
        if (data === null) {
          this.state.entities.ui_elements.delete(id);
        } else {
          const existing = this.state.entities.ui_elements.get(id) || {
            id,
            name: id,
            functional: false,
            last_updated: now(),
          };
          this.state.entities.ui_elements.set(id, { ...existing, ...(data as any), last_updated: now() });
        }
      }
    }

    if (patch.flows) {
      for (const [name, data] of Object.entries(patch.flows)) {
        if (data === null) {
          this.state.entities.flows.delete(name);
        } else {
          const existing = this.state.entities.flows.get(name) || {
            name,
            steps: [],
            working: false,
            last_updated: now(),
          };
          this.state.entities.flows.set(name, { ...existing, ...(data as any), last_updated: now() });
        }
      }
    }

    if (patch.tests) {
      for (const [name, data] of Object.entries(patch.tests)) {
        if (data === null) {
          this.state.entities.tests.delete(name);
        } else {
          const existing = this.state.entities.tests.get(name) || {
            name,
            covers: [],
            passing: false,
          };
          this.state.entities.tests.set(name, { ...existing, ...(data as any), last_run: now() });
        }
      }
    }

    this.notify({ type: "patch", patch });
  }

  // ========================================
  // ASSERTIONS
  // ========================================

  assertFact(agent: string, assertion: string, confidence: number, source: Observation["source"] = "assumption"): Observation {
    const obs: Observation = {
      id: generateId(),
      timestamp: now(),
      agent,
      assertion,
      confidence,
      source,
    };

    // Check for contradictions
    const contradicting = this.findContradiction(assertion);
    if (contradicting) {
      this.createConflict(contradicting.assertion, assertion);
    }

    this.state.observations.push(obs);
    if (this.state.observations.length > 500) {
      this.state.observations = this.state.observations.slice(-500);
    }

    this.state.version++;
    this.notify({ type: "assertion", observation: obs });

    return obs;
  }

  private findContradiction(assertion: string): Observation | null {
    // Simple negation detection
    const recent = this.state.observations.slice(-50);
    const normalized = assertion.toLowerCase();

    for (const obs of recent) {
      const obsNorm = obs.assertion.toLowerCase();
      // Check for direct contradictions
      if (
        (normalized.includes("not working") && obsNorm.includes("working") && !obsNorm.includes("not")) ||
        (normalized.includes("working") && !normalized.includes("not") && obsNorm.includes("not working")) ||
        (normalized.includes("failing") && obsNorm.includes("passing")) ||
        (normalized.includes("passing") && obsNorm.includes("failing"))
      ) {
        return obs;
      }
    }
    return null;
  }

  // ========================================
  // CONFLICTS
  // ========================================

  private createConflict(assertion_a: string, assertion_b: string): Conflict {
    const conflict: Conflict = {
      id: generateId(),
      assertion_a,
      assertion_b,
      resolution_status: "pending",
      created_at: now(),
    };

    this.state.conflicts.push(conflict);
    this.enqueueWork("Resolve conflict: " + assertion_a.slice(0, 30) + " vs " + assertion_b.slice(0, 30), "tester", 10);

    return conflict;
  }

  resolveConflict(conflictId: string, resolution: string, resolvedBy: string): boolean {
    const conflict = this.state.conflicts.find(c => c.id === conflictId);
    if (!conflict) return false;

    conflict.resolution_status = "resolved";
    conflict.resolution = resolution;
    conflict.resolved_by = resolvedBy;

    this.state.version++;
    this.notify({ type: "conflict_resolved", conflict });

    return true;
  }

  // ========================================
  // GOALS
  // ========================================

  proposeGoal(description: string, success_criteria: string[]): Goal {
    const goal: Goal = {
      id: generateId(),
      description,
      success_criteria,
      status: "pending",
      created_at: now(),
      updated_at: now(),
    };

    this.state.goals.set(goal.id, goal);
    this.state.version++;

    // Enqueue planning work
    this.enqueueWork(`Plan: ${description}`, "planner", 10, goal.id);

    this.notify({ type: "goal_proposed", goal });
    log.info(`Goal proposed: ${description}`);

    return goal;
  }

  evaluateGoal(goalId: string): { satisfied: boolean; progress: number; missing: string[] } {
    const goal = this.state.goals.get(goalId);
    if (!goal) return { satisfied: false, progress: 0, missing: ["Goal not found"] };

    const missing: string[] = [];
    let satisfied = 0;

    for (const criterion of goal.success_criteria) {
      if (this.checkCriterion(criterion)) {
        satisfied++;
      } else {
        missing.push(criterion);
      }
    }

    const progress = goal.success_criteria.length > 0 ? satisfied / goal.success_criteria.length : 0;
    const isSatisfied = missing.length === 0 && goal.success_criteria.length > 0;

    // Update goal status
    const oldStatus = goal.status;
    if (isSatisfied) {
      goal.status = "satisfied";
    } else if (progress > 0.5) {
      goal.status = "converging";
    } else if (goal.status === "satisfied" || goal.status === "converging") {
      goal.status = "regressed";
      this.handleRegression(goal, missing);
    } else {
      goal.status = "in_progress";
    }
    goal.updated_at = now();

    if (oldStatus !== goal.status) {
      this.state.version++;
      this.notify({ type: "goal_status_changed", goal, oldStatus });
      log.info(`Goal ${goalId} status: ${oldStatus} → ${goal.status}`);
    }

    return { satisfied: isSatisfied, progress, missing };
  }

  private checkCriterion(criterion: string): boolean {
    const lower = criterion.toLowerCase();

    // Check endpoints
    if (lower.includes("endpoint") || lower.includes("api")) {
      const endpoints = Array.from(this.state.entities.endpoints.values());
      if (lower.includes("implemented")) {
        return endpoints.some(e => e.implemented && criterion.toLowerCase().includes(e.route.toLowerCase()));
      }
      if (lower.includes("tested")) {
        return endpoints.some(e => e.tested && criterion.toLowerCase().includes(e.route.toLowerCase()));
      }
    }

    // Check tests
    if (lower.includes("test") && lower.includes("pass")) {
      const tests = Array.from(this.state.entities.tests.values());
      return tests.length > 0 && tests.every(t => t.passing);
    }

    // Check UI
    if (lower.includes("ui") || lower.includes("frontend")) {
      const elements = Array.from(this.state.entities.ui_elements.values());
      return elements.some(e => e.functional);
    }

    // Check flows
    if (lower.includes("flow") || lower.includes("working")) {
      const flows = Array.from(this.state.entities.flows.values());
      return flows.some(f => f.working);
    }

    // Check observations for assertions
    const recentObs = this.state.observations.slice(-20);
    return recentObs.some(o => o.assertion.toLowerCase().includes(lower) && o.confidence > 0.7);
  }

  private handleRegression(goal: Goal, missing: string[]): void {
    log.info(`Regression detected for goal: ${goal.description}`);

    // Enqueue fix work
    for (const m of missing.slice(0, 3)) {
      this.enqueueWork(`Fix regression: ${m}`, "fixer", 8, goal.id);
    }
  }

  // ========================================
  // WORK QUEUE
  // ========================================

  private enqueueWork(description: string, role: WorkItem["required_role"], priority: number, goalId?: string): WorkItem {
    const work: WorkItem = {
      id: generateId(),
      goal_id: goalId || "",
      description,
      required_role: role,
      priority,
      status: "queued",
      created_at: now(),
    };

    this.state.work_queue.push(work);
    this.state.work_queue.sort((a, b) => b.priority - a.priority);

    this.notify({ type: "work_enqueued", work });

    return work;
  }

  assignWork(agentId: string, agentRole: string): WorkItem | null {
    const roleMap: Record<string, WorkItem["required_role"][]> = {
      planner: ["planner"],
      coder: ["coder", "fixer"],
      tester: ["tester"],
      fixer: ["fixer", "coder"],
    };

    const acceptableRoles = roleMap[agentRole] || [agentRole as WorkItem["required_role"]];

    const work = this.state.work_queue.find(
      w => w.status === "queued" && acceptableRoles.includes(w.required_role)
    );

    if (work) {
      work.status = "assigned";
      work.assigned_to = agentId;
      this.state.version++;
      this.notify({ type: "work_assigned", work, agentId });
      log.info(`Work assigned to ${agentId}: ${work.description}`);
    }

    return work || null;
  }

  completeWork(workId: string): boolean {
    const work = this.state.work_queue.find(w => w.id === workId);
    if (!work) return false;

    work.status = "completed";
    this.state.version++;

    // Re-evaluate associated goal
    if (work.goal_id) {
      this.evaluateGoal(work.goal_id);
    }

    this.notify({ type: "work_completed", work });

    return true;
  }

  reportFailure(area: string, reason: string, agentId: string): void {
    this.assertFact(agentId, `${area} failing: ${reason}`, 0.9, "runtime");

    // Mark relevant entities as failing
    if (area.includes("/api/") || area.includes("endpoint")) {
      for (const [key, endpoint] of this.state.entities.endpoints) {
        if (key.includes(area) || area.includes(endpoint.route)) {
          endpoint.failing = true;
        }
      }
    }

    // Enqueue fix work
    this.enqueueWork(`Fix: ${area} - ${reason}`, "fixer", 9);

    this.state.version++;
    this.notify({ type: "failure_reported", area, reason });
  }

  // ========================================
  // CONVERGENCE ENGINE
  // ========================================

  private runConvergenceLoop(): void {
    // Evaluate all active goals
    for (const [id, goal] of this.state.goals) {
      if (goal.status !== "satisfied") {
        this.evaluateGoal(id);
      }
    }

    // Clean up completed work
    this.state.work_queue = this.state.work_queue.filter(
      w => w.status !== "completed" || now() - w.created_at < 60000
    );

    // Check for stale work
    const staleThreshold = now() - 30000;
    for (const work of this.state.work_queue) {
      if (work.status === "assigned" && work.created_at < staleThreshold) {
        work.status = "queued";
        work.assigned_to = undefined;
      }
    }
  }

  // ========================================
  // SUBSCRIPTIONS
  // ========================================

  subscribe(callback: (state: WorldState, change: any) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private notify(change: any): void {
    for (const sub of this.subscribers) {
      try {
        sub(this.state, change);
      } catch (e) {
        // ignore
      }
    }
  }
}

// Singleton
export const worldState = new WorldStateManager();
