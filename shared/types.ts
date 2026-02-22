// Synapse - Shared Types and Event Schema
// Core protocol definitions for multi-agent coordination

import { z } from 'zod';

// ========================================
// AGENT TYPES
// ========================================

export const AgentType = z.enum(['realtime', 'stateless', 'observer']);
export type AgentType = z.infer<typeof AgentType>;

export const AgentRole = z.enum(['planner', 'coder', 'tester', 'refactor', 'observer']);
export type AgentRole = z.infer<typeof AgentRole>;

export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: AgentType,
  role: AgentRole,
  capabilities: z.array(z.string()),
  connectedAt: z.number(),
  lastSeen: z.number(),
  cursor: z.number().default(0),
});
export type Agent = z.infer<typeof AgentSchema>;

// ========================================
// LOCK SYSTEM
// ========================================

export const LockTargetSchema = z.object({
  type: z.enum(['file', 'function', 'class', 'module', 'semantic']),
  path: z.string(),
  identifier: z.string().optional(),
  description: z.string().optional(),
});
export type LockTarget = z.infer<typeof LockTargetSchema>;

export const LockSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  target: LockTargetSchema,
  acquiredAt: z.number(),
  ttl: z.number(), // milliseconds
  expiresAt: z.number(),
  intent: z.string().optional(),
});
export type Lock = z.infer<typeof LockSchema>;

// ========================================
// INTENT SYSTEM
// ========================================

export const IntentSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  action: z.string(),
  targets: z.array(z.string()),
  description: z.string(),
  priority: z.number().default(0),
  status: z.enum(['pending', 'active', 'completed', 'cancelled', 'blocked']),
  dependencies: z.array(z.string()).default([]),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Intent = z.infer<typeof IntentSchema>;

// ========================================
// FILE OPERATIONS
// ========================================

export const FilePatchSchema = z.object({
  path: z.string(),
  operation: z.enum(['create', 'modify', 'delete', 'rename']),
  content: z.string().optional(),
  diff: z.string().optional(),
  oldPath: z.string().optional(), // for rename
  checksum: z.string().optional(),
});
export type FilePatch = z.infer<typeof FilePatchSchema>;

export const FileStateSchema = z.object({
  path: z.string(),
  content: z.string(),
  version: z.number(),
  lastModifiedBy: z.string(),
  lastModifiedAt: z.number(),
  checksum: z.string(),
});
export type FileState = z.infer<typeof FileStateSchema>;

// ========================================
// EVENTS
// ========================================

export const EventTypeSchema = z.enum([
  // Agent lifecycle
  'agent_connected',
  'agent_disconnected',
  'agent_heartbeat',

  // Intent operations
  'intent_broadcast',
  'intent_updated',
  'intent_completed',
  'intent_cancelled',
  'intent_conflict',

  // Lock operations
  'lock_requested',
  'lock_acquired',
  'lock_denied',
  'lock_released',
  'lock_expired',
  'lock_conflict',

  // File operations
  'file_patch',
  'file_created',
  'file_modified',
  'file_deleted',
  'file_renamed',
  'file_conflict',

  // Blueprint/state
  'blueprint_update',
  'state_snapshot',

  // Test/validation
  'test_started',
  'test_passed',
  'test_failed',

  // System
  'system_message',
  'error',
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const EventSchema = z.object({
  id: z.string(),
  cursor: z.number(),
  type: EventTypeSchema,
  agentId: z.string(),
  timestamp: z.number(),
  data: z.record(z.any()),
  targets: z.array(z.string()).optional(), // specific agents to notify
});
export type Event = z.infer<typeof EventSchema>;

// ========================================
// BLUEPRINT (Working Memory)
// ========================================

export const BlueprintSchema = z.object({
  version: z.number(),
  timestamp: z.number(),
  agents: z.array(AgentSchema),
  locks: z.array(LockSchema),
  intents: z.array(IntentSchema),
  files: z.record(FileStateSchema),
  cursor: z.number(),
  projectName: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});
export type Blueprint = z.infer<typeof BlueprintSchema>;

// ========================================
// PROTOCOL MESSAGES
// ========================================

export const MessageSchema = z.discriminatedUnion('type', [
  // Agent registration
  z.object({
    type: z.literal('register'),
    agent: AgentSchema.omit({ connectedAt: true, lastSeen: true, cursor: true }),
  }),

  // Intent operations
  z.object({
    type: z.literal('broadcast_intent'),
    intent: IntentSchema.omit({ id: true, createdAt: true, updatedAt: true }),
  }),
  z.object({
    type: z.literal('update_intent'),
    intentId: z.string(),
    updates: z.object({
      status: IntentSchema.shape.status.optional(),
      description: z.string().optional(),
    }),
  }),

  // Lock operations
  z.object({
    type: z.literal('request_lock'),
    target: LockTargetSchema,
    ttl: z.number().optional(),
    intent: z.string().optional(),
  }),
  z.object({
    type: z.literal('release_lock'),
    lockId: z.string(),
  }),

  // File operations
  z.object({
    type: z.literal('file_patch'),
    patch: FilePatchSchema,
    lockId: z.string().optional(),
  }),

  // Query operations
  z.object({
    type: z.literal('get_blueprint'),
    sinceCursor: z.number().optional(),
  }),
  z.object({
    type: z.literal('get_events'),
    sinceCursor: z.number(),
    limit: z.number().optional(),
  }),
  z.object({
    type: z.literal('subscribe'),
    eventTypes: z.array(EventTypeSchema).optional(),
  }),

  // Heartbeat
  z.object({
    type: z.literal('heartbeat'),
  }),

  // Test reporting
  z.object({
    type: z.literal('report_test'),
    testName: z.string(),
    status: z.enum(['started', 'passed', 'failed']),
    details: z.string().optional(),
    errors: z.array(z.string()).optional(),
  }),
]);
export type Message = z.infer<typeof MessageSchema>;

// ========================================
// RESPONSE TYPES
// ========================================

export const ResponseSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('registered'),
    agentId: z.string(),
    cursor: z.number(),
  }),
  z.object({
    type: z.literal('intent_created'),
    intentId: z.string(),
  }),
  z.object({
    type: z.literal('lock_result'),
    success: z.boolean(),
    lockId: z.string().optional(),
    reason: z.string().optional(),
    conflictingAgent: z.string().optional(),
    suggestedAction: z.string().optional(),
  }),
  z.object({
    type: z.literal('patch_result'),
    success: z.boolean(),
    path: z.string(),
    version: z.number().optional(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('blueprint'),
    blueprint: BlueprintSchema,
  }),
  z.object({
    type: z.literal('events'),
    events: z.array(EventSchema),
    cursor: z.number(),
  }),
  z.object({
    type: z.literal('subscribed'),
    eventTypes: z.array(EventTypeSchema),
  }),
  z.object({
    type: z.literal('event'),
    event: EventSchema,
  }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
    code: z.string().optional(),
  }),
  z.object({
    type: z.literal('ack'),
  }),
]);
export type Response = z.infer<typeof ResponseSchema>;

// ========================================
// CONFLICT RESOLUTION
// ========================================

export const ConflictSchema = z.object({
  id: z.string(),
  type: z.enum(['lock', 'file', 'intent']),
  agents: z.array(z.string()),
  target: z.string(),
  description: z.string(),
  resolution: z.enum(['pending', 'negotiated', 'forced', 'manual']).optional(),
  resolvedAt: z.number().optional(),
});
export type Conflict = z.infer<typeof ConflictSchema>;

// ========================================
// SIMULATION TYPES
// ========================================

export const SimulationScenarioSchema = z.object({
  name: z.string(),
  description: z.string(),
  agents: z.array(z.object({
    name: z.string(),
    role: AgentRole,
    type: AgentType,
  })),
  steps: z.array(z.object({
    agent: z.string(),
    action: z.string(),
    params: z.record(z.any()),
    expectedOutcome: z.string().optional(),
    delay: z.number().optional(),
  })),
  successCriteria: z.array(z.string()),
  timeout: z.number().default(30000),
});
export type SimulationScenario = z.infer<typeof SimulationScenarioSchema>;

export const SimulationResultSchema = z.object({
  scenario: z.string(),
  success: z.boolean(),
  duration: z.number(),
  events: z.array(EventSchema),
  errors: z.array(z.string()),
  summary: z.string(),
});
export type SimulationResult = z.infer<typeof SimulationResultSchema>;
