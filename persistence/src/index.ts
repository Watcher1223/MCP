// Synapse Persistence Layer
// PostgreSQL + Redis for production-grade state management

import { Pool, PoolClient } from 'pg';
import { createClient, RedisClientType } from 'redis';
import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';

// Types
export interface Workspace {
  id: string;
  name: string;
  slug: string;
  apiKey?: string;
  settings: Record<string, any>;
  createdAt: Date;
}

export interface Agent {
  id: string;
  workspaceId: string;
  externalId: string;
  name: string;
  role: string;
  type: 'realtime' | 'stateless' | 'observer';
  environment: string;
  capabilities: string[];
  subscriptions: string[];
  metadata: Record<string, any>;
  sessionToken?: string;
  lastSeen: Date;
  isOnline: boolean;
}

export interface Intent {
  id: string;
  workspaceId: string;
  agentId: string;
  action: string;
  description: string;
  targets: string[];
  concepts: string[];
  priority: number;
  status: 'pending' | 'active' | 'completed' | 'cancelled';
  result?: any;
  createdAt: Date;
  completedAt?: Date;
}

export interface Lock {
  id: string;
  workspaceId: string;
  agentId: string;
  targetType: string;
  targetPath: string;
  targetIdentifier?: string;
  intentId?: string;
  expiresAt: Date;
}

export interface FileState {
  id: string;
  workspaceId: string;
  path: string;
  content: string;
  checksum: string;
  version: number;
  lastModifiedBy: string;
}

export interface SynapseEvent {
  id: string;
  workspaceId: string;
  cursor: number;
  type: string;
  agentId?: string;
  data: Record<string, any>;
  concepts: string[];
  createdAt: Date;
}

export interface Reaction {
  id: string;
  workspaceId: string;
  agentId: string;
  triggerConcepts: string[];
  triggerEventTypes: string[];
  actionType: string;
  actionConfig: Record<string, any>;
  priority: number;
  enabled: boolean;
}

// Database connection
export class Database extends EventEmitter {
  private pool: Pool;
  private redis: RedisClientType;
  private pubsub: RedisClientType;
  private ready = false;

  constructor(
    private pgUrl: string = process.env.DATABASE_URL || 'postgresql://localhost:5432/synapse',
    private redisUrl: string = process.env.REDIS_URL || 'redis://localhost:6379'
  ) {
    super();
    this.pool = new Pool({ connectionString: pgUrl, max: 20 });
    this.redis = createClient({ url: redisUrl }) as RedisClientType;
    this.pubsub = this.redis.duplicate() as RedisClientType;
  }

  async connect(): Promise<void> {
    await this.redis.connect();
    await this.pubsub.connect();

    // Subscribe to events channel
    await this.pubsub.pSubscribe('synapse:*', (message, channel) => {
      const [, workspaceId, eventType] = channel.split(':');
      try {
        const data = JSON.parse(message);
        this.emit('event', { workspaceId, type: eventType, data });
      } catch (e) {
        // Ignore parse errors
      }
    });

    this.ready = true;
  }

  async disconnect(): Promise<void> {
    await this.pool.end();
    await this.pubsub.quit();
    await this.redis.quit();
  }

  // Workspace operations
  async createWorkspace(name: string, slug: string): Promise<{ workspace: Workspace; apiKey: string }> {
    const apiKey = `syn_${randomBytes(24).toString('hex')}`;
    const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
    const apiKeyPrefix = apiKey.slice(0, 8);

    const result = await this.pool.query(
      `INSERT INTO workspaces (name, slug, api_key_hash, api_key_prefix)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, slug, settings, created_at`,
      [name, slug, apiKeyHash, apiKeyPrefix]
    );

    return {
      workspace: this.mapWorkspace(result.rows[0]),
      apiKey
    };
  }

  async getWorkspaceByApiKey(apiKey: string): Promise<Workspace | null> {
    const prefix = apiKey.slice(0, 8);
    const hash = createHash('sha256').update(apiKey).digest('hex');

    const result = await this.pool.query(
      `SELECT id, name, slug, settings, created_at
       FROM workspaces
       WHERE api_key_prefix = $1 AND api_key_hash = $2`,
      [prefix, hash]
    );

    return result.rows[0] ? this.mapWorkspace(result.rows[0]) : null;
  }

  async getWorkspaceBySlug(slug: string): Promise<Workspace | null> {
    const result = await this.pool.query(
      `SELECT id, name, slug, settings, created_at
       FROM workspaces WHERE slug = $1`,
      [slug]
    );
    return result.rows[0] ? this.mapWorkspace(result.rows[0]) : null;
  }

  // Agent operations
  async upsertAgent(workspaceId: string, agent: Partial<Agent>): Promise<Agent> {
    const sessionToken = agent.sessionToken || `sess_${randomBytes(16).toString('hex')}`;

    const result = await this.pool.query(
      `INSERT INTO agents (workspace_id, external_id, name, role, type, environment, capabilities, subscriptions, metadata, session_token, is_online, last_seen)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, NOW())
       ON CONFLICT (workspace_id, external_id) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, agents.name),
         role = COALESCE(EXCLUDED.role, agents.role),
         type = COALESCE(EXCLUDED.type, agents.type),
         environment = COALESCE(EXCLUDED.environment, agents.environment),
         capabilities = COALESCE(EXCLUDED.capabilities, agents.capabilities),
         subscriptions = COALESCE(EXCLUDED.subscriptions, agents.subscriptions),
         metadata = agents.metadata || EXCLUDED.metadata,
         session_token = EXCLUDED.session_token,
         is_online = true,
         last_seen = NOW()
       RETURNING *`,
      [
        workspaceId,
        agent.externalId,
        agent.name || 'Agent',
        agent.role || 'coder',
        agent.type || 'realtime',
        agent.environment || 'unknown',
        agent.capabilities || [],
        agent.subscriptions || [],
        JSON.stringify(agent.metadata || {}),
        sessionToken
      ]
    );

    const savedAgent = this.mapAgent(result.rows[0]);

    // Publish agent connected event
    await this.publishEvent(workspaceId, 'agent_connected', {
      agent: savedAgent
    }, ['agent', 'presence']);

    // Cache in Redis for fast lookup
    await this.redis.hSet(`workspace:${workspaceId}:agents`, savedAgent.id, JSON.stringify(savedAgent));
    await this.redis.expire(`workspace:${workspaceId}:agents`, 3600);

    return savedAgent;
  }

  async getAgent(workspaceId: string, agentId: string): Promise<Agent | null> {
    // Try cache first
    const cached = await this.redis.hGet(`workspace:${workspaceId}:agents`, agentId);
    if (cached) {
      return JSON.parse(cached);
    }

    const result = await this.pool.query(
      `SELECT * FROM agents WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, agentId]
    );
    return result.rows[0] ? this.mapAgent(result.rows[0]) : null;
  }

  async getAgentBySession(sessionToken: string): Promise<Agent | null> {
    const result = await this.pool.query(
      `SELECT * FROM agents WHERE session_token = $1`,
      [sessionToken]
    );
    return result.rows[0] ? this.mapAgent(result.rows[0]) : null;
  }

  async getOnlineAgents(workspaceId: string): Promise<Agent[]> {
    const result = await this.pool.query(
      `SELECT * FROM agents WHERE workspace_id = $1 AND is_online = true ORDER BY last_seen DESC`,
      [workspaceId]
    );
    return result.rows.map(this.mapAgent);
  }

  async getAllAgents(workspaceId: string): Promise<Agent[]> {
    const result = await this.pool.query(
      `SELECT * FROM agents WHERE workspace_id = $1 ORDER BY last_seen DESC`,
      [workspaceId]
    );
    return result.rows.map(this.mapAgent);
  }

  async updateAgent(workspaceId: string, agentId: string, updates: Partial<Agent>): Promise<Agent | null> {
    const setClauses: string[] = [];
    const values: any[] = [workspaceId, agentId];
    let paramIndex = 3;

    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      values.push(updates.name);
    }
    if (updates.role !== undefined) {
      setClauses.push(`role = $${paramIndex++}`);
      values.push(updates.role);
    }
    if (updates.subscriptions !== undefined) {
      setClauses.push(`subscriptions = $${paramIndex++}`);
      values.push(updates.subscriptions);
    }
    if (updates.capabilities !== undefined) {
      setClauses.push(`capabilities = $${paramIndex++}`);
      values.push(updates.capabilities);
    }
    if (updates.isOnline !== undefined) {
      setClauses.push(`is_online = $${paramIndex++}`);
      values.push(updates.isOnline);
    }

    setClauses.push('last_seen = NOW()');

    if (setClauses.length === 1) return this.getAgent(workspaceId, agentId);

    const result = await this.pool.query(
      `UPDATE agents SET ${setClauses.join(', ')} WHERE workspace_id = $1 AND id = $2 RETURNING *`,
      values
    );

    if (result.rows[0]) {
      const agent = this.mapAgent(result.rows[0]);
      await this.redis.hSet(`workspace:${workspaceId}:agents`, agentId, JSON.stringify(agent));

      await this.publishEvent(workspaceId, 'agent_updated', { agent }, ['agent', 'presence']);
      return agent;
    }
    return null;
  }

  async setAgentOffline(workspaceId: string, agentId: string): Promise<void> {
    await this.pool.query(
      `UPDATE agents SET is_online = false WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, agentId]
    );
    await this.redis.hDel(`workspace:${workspaceId}:agents`, agentId);
    await this.publishEvent(workspaceId, 'agent_disconnected', { agentId }, ['agent', 'presence']);
  }

  // Intent operations
  async createIntent(workspaceId: string, agentId: string, intent: Partial<Intent>): Promise<Intent> {
    const result = await this.pool.query(
      `INSERT INTO intents (workspace_id, agent_id, action, description, targets, concepts, priority, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING *`,
      [
        workspaceId,
        agentId,
        intent.action,
        intent.description || '',
        intent.targets || [],
        intent.concepts || [],
        intent.priority || 5
      ]
    );

    const savedIntent = this.mapIntent(result.rows[0]);

    await this.publishEvent(workspaceId, 'intent_broadcast', {
      intent: savedIntent
    }, ['intent', ...savedIntent.concepts]);

    return savedIntent;
  }

  async updateIntent(workspaceId: string, intentId: string, updates: Partial<Intent>): Promise<Intent | null> {
    const setClauses: string[] = [];
    const values: any[] = [workspaceId, intentId];
    let paramIndex = 3;

    if (updates.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      values.push(updates.status);
      if (updates.status === 'completed' || updates.status === 'cancelled') {
        setClauses.push(`completed_at = NOW()`);
      }
    }
    if (updates.result !== undefined) {
      setClauses.push(`result = $${paramIndex++}`);
      values.push(JSON.stringify(updates.result));
    }

    if (setClauses.length === 0) return null;

    const result = await this.pool.query(
      `UPDATE intents SET ${setClauses.join(', ')} WHERE workspace_id = $1 AND id = $2 RETURNING *`,
      values
    );

    if (result.rows[0]) {
      const intent = this.mapIntent(result.rows[0]);
      const eventType = updates.status === 'completed' ? 'intent_completed' :
                       updates.status === 'cancelled' ? 'intent_cancelled' : 'intent_updated';

      await this.publishEvent(workspaceId, eventType, { intent }, ['intent', ...intent.concepts]);
      return intent;
    }
    return null;
  }

  async getActiveIntents(workspaceId: string): Promise<Intent[]> {
    const result = await this.pool.query(
      `SELECT * FROM intents WHERE workspace_id = $1 AND status IN ('pending', 'active') ORDER BY priority DESC, created_at`,
      [workspaceId]
    );
    return result.rows.map(this.mapIntent);
  }

  // Lock operations
  async acquireLock(
    workspaceId: string,
    agentId: string,
    target: { type: string; path: string; identifier?: string },
    ttlMs: number = 30000,
    intentId?: string
  ): Promise<{ success: boolean; lockId?: string; reason?: string; holder?: string }> {
    const expiresAt = new Date(Date.now() + ttlMs);

    // Clean up expired locks first
    await this.pool.query(`DELETE FROM locks WHERE expires_at < NOW()`);

    // Check for existing lock
    const existing = await this.pool.query(
      `SELECT l.*, a.name as agent_name FROM locks l
       JOIN agents a ON l.agent_id = a.id
       WHERE l.workspace_id = $1 AND l.target_path = $2 AND (l.target_identifier = $3 OR l.target_identifier IS NULL)`,
      [workspaceId, target.path, target.identifier || null]
    );

    if (existing.rows[0]) {
      return {
        success: false,
        reason: 'Lock held by another agent',
        holder: existing.rows[0].agent_name
      };
    }

    try {
      const result = await this.pool.query(
        `INSERT INTO locks (workspace_id, agent_id, target_type, target_path, target_identifier, intent_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [workspaceId, agentId, target.type, target.path, target.identifier, intentId, expiresAt]
      );

      const lockId = result.rows[0].id;

      await this.publishEvent(workspaceId, 'lock_acquired', {
        lockId,
        agentId,
        target,
        expiresAt
      }, ['lock', target.path]);

      // Set Redis key for fast lock check
      await this.redis.set(
        `lock:${workspaceId}:${target.path}:${target.identifier || ''}`,
        JSON.stringify({ lockId, agentId }),
        { PX: ttlMs }
      );

      return { success: true, lockId };
    } catch (e: any) {
      if (e.code === '23505') { // Unique violation
        return { success: false, reason: 'Lock already exists' };
      }
      throw e;
    }
  }

  async releaseLock(workspaceId: string, lockId: string, agentId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM locks WHERE id = $1 AND workspace_id = $2 AND agent_id = $3 RETURNING target_path, target_identifier`,
      [lockId, workspaceId, agentId]
    );

    if (result.rows[0]) {
      const { target_path, target_identifier } = result.rows[0];
      await this.redis.del(`lock:${workspaceId}:${target_path}:${target_identifier || ''}`);
      await this.publishEvent(workspaceId, 'lock_released', { lockId, agentId }, ['lock', target_path]);
      return true;
    }
    return false;
  }

  async getActiveLocks(workspaceId: string): Promise<Lock[]> {
    const result = await this.pool.query(
      `SELECT * FROM locks WHERE workspace_id = $1 AND expires_at > NOW()`,
      [workspaceId]
    );
    return result.rows.map(this.mapLock);
  }

  // File operations
  async upsertFile(workspaceId: string, agentId: string, path: string, content: string): Promise<FileState> {
    const checksum = createHash('md5').update(content).digest('hex');

    const result = await this.pool.query(
      `INSERT INTO files (workspace_id, path, content, checksum, last_modified_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, path) DO UPDATE SET
         content = EXCLUDED.content,
         checksum = EXCLUDED.checksum,
         version = files.version + 1,
         last_modified_by = EXCLUDED.last_modified_by,
         updated_at = NOW()
       RETURNING *`,
      [workspaceId, path, content, checksum, agentId]
    );

    const file = this.mapFile(result.rows[0]);

    await this.publishEvent(workspaceId, 'file_modified', {
      path,
      checksum,
      version: file.version,
      agentId
    }, ['file', path, this.extractConcepts(path, content)].flat());

    return file;
  }

  async getFile(workspaceId: string, path: string): Promise<FileState | null> {
    const result = await this.pool.query(
      `SELECT * FROM files WHERE workspace_id = $1 AND path = $2`,
      [workspaceId, path]
    );
    return result.rows[0] ? this.mapFile(result.rows[0]) : null;
  }

  async getFiles(workspaceId: string): Promise<Record<string, FileState>> {
    const result = await this.pool.query(
      `SELECT * FROM files WHERE workspace_id = $1`,
      [workspaceId]
    );
    const files: Record<string, FileState> = {};
    for (const row of result.rows) {
      const file = this.mapFile(row);
      files[file.path] = file;
    }
    return files;
  }

  // Event operations
  async publishEvent(
    workspaceId: string,
    type: string,
    data: Record<string, any>,
    concepts: string[] = []
  ): Promise<SynapseEvent> {
    const result = await this.pool.query(
      `INSERT INTO events (workspace_id, type, agent_id, data, concepts)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [workspaceId, type, data.agentId || data.agent?.id, JSON.stringify(data), concepts]
    );

    const event = this.mapEvent(result.rows[0]);

    // Publish to Redis for real-time distribution
    await this.redis.publish(`synapse:${workspaceId}:${type}`, JSON.stringify(event));
    await this.redis.publish(`synapse:${workspaceId}:all`, JSON.stringify(event));

    // Also publish to concept-specific channels
    for (const concept of concepts) {
      await this.redis.publish(`synapse:${workspaceId}:concept:${concept}`, JSON.stringify(event));
    }

    return event;
  }

  async getEventsSince(workspaceId: string, cursor: number, limit: number = 100): Promise<SynapseEvent[]> {
    const result = await this.pool.query(
      `SELECT * FROM events WHERE workspace_id = $1 AND cursor > $2 ORDER BY cursor LIMIT $3`,
      [workspaceId, cursor, limit]
    );
    return result.rows.map(this.mapEvent);
  }

  async getEventsByConcept(workspaceId: string, concept: string, limit: number = 50): Promise<SynapseEvent[]> {
    const result = await this.pool.query(
      `SELECT * FROM events WHERE workspace_id = $1 AND $2 = ANY(concepts) ORDER BY cursor DESC LIMIT $3`,
      [workspaceId, concept, limit]
    );
    return result.rows.map(this.mapEvent);
  }

  // Reaction operations
  async createReaction(workspaceId: string, agentId: string, reaction: Partial<Reaction>): Promise<Reaction> {
    const result = await this.pool.query(
      `INSERT INTO reactions (workspace_id, agent_id, trigger_concepts, trigger_event_types, action_type, action_config, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        workspaceId,
        agentId,
        reaction.triggerConcepts || [],
        reaction.triggerEventTypes || [],
        reaction.actionType || 'notify',
        JSON.stringify(reaction.actionConfig || {}),
        reaction.priority || 5
      ]
    );
    return this.mapReaction(result.rows[0]);
  }

  async getReactionsForConcepts(workspaceId: string, concepts: string[]): Promise<Reaction[]> {
    const result = await this.pool.query(
      `SELECT * FROM reactions
       WHERE workspace_id = $1 AND enabled = true AND trigger_concepts && $2
       ORDER BY priority DESC`,
      [workspaceId, concepts]
    );
    return result.rows.map(this.mapReaction);
  }

  async getReactionsForEventType(workspaceId: string, eventType: string): Promise<Reaction[]> {
    const result = await this.pool.query(
      `SELECT * FROM reactions
       WHERE workspace_id = $1 AND enabled = true AND $2 = ANY(trigger_event_types)
       ORDER BY priority DESC`,
      [workspaceId, eventType]
    );
    return result.rows.map(this.mapReaction);
  }

  // Blueprint (full state snapshot)
  async getBlueprint(workspaceId: string): Promise<{
    agents: Agent[];
    intents: Intent[];
    locks: Lock[];
    files: Record<string, FileState>;
    cursor: number;
  }> {
    const [agents, intents, locks, files, cursorResult] = await Promise.all([
      this.getOnlineAgents(workspaceId),
      this.getActiveIntents(workspaceId),
      this.getActiveLocks(workspaceId),
      this.getFiles(workspaceId),
      this.pool.query(`SELECT COALESCE(MAX(cursor), 0) as cursor FROM events WHERE workspace_id = $1`, [workspaceId])
    ]);

    return {
      agents,
      intents,
      locks,
      files,
      cursor: parseInt(cursorResult.rows[0].cursor)
    };
  }

  // Helper to extract concepts from file path and content
  private extractConcepts(path: string, content: string): string[] {
    const concepts: string[] = [];

    // Path-based concepts
    if (path.includes('/api/')) concepts.push('api');
    if (path.includes('/components/')) concepts.push('frontend', 'components');
    if (path.includes('/models/') || path.includes('/schema')) concepts.push('schema', 'database');
    if (path.includes('/test')) concepts.push('tests');
    if (path.includes('.ts') || path.includes('.js')) concepts.push('code');

    // Content-based concepts
    if (content.includes('export default')) concepts.push('module');
    if (content.includes('async function') || content.includes('Promise')) concepts.push('async');
    if (content.includes('class ')) concepts.push('class');
    if (content.includes('interface ') || content.includes('type ')) concepts.push('types');

    return [...new Set(concepts)];
  }

  // Mappers
  private mapWorkspace(row: any): Workspace {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      settings: row.settings || {},
      createdAt: row.created_at
    };
  }

  private mapAgent(row: any): Agent {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      externalId: row.external_id,
      name: row.name,
      role: row.role,
      type: row.type,
      environment: row.environment,
      capabilities: row.capabilities || [],
      subscriptions: row.subscriptions || [],
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata || {},
      sessionToken: row.session_token,
      lastSeen: row.last_seen,
      isOnline: row.is_online
    };
  }

  private mapIntent(row: any): Intent {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      agentId: row.agent_id,
      action: row.action,
      description: row.description,
      targets: row.targets || [],
      concepts: row.concepts || [],
      priority: row.priority,
      status: row.status,
      result: row.result,
      createdAt: row.created_at,
      completedAt: row.completed_at
    };
  }

  private mapLock(row: any): Lock {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      agentId: row.agent_id,
      targetType: row.target_type,
      targetPath: row.target_path,
      targetIdentifier: row.target_identifier,
      intentId: row.intent_id,
      expiresAt: row.expires_at
    };
  }

  private mapFile(row: any): FileState {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      path: row.path,
      content: row.content,
      checksum: row.checksum,
      version: row.version,
      lastModifiedBy: row.last_modified_by
    };
  }

  private mapEvent(row: any): SynapseEvent {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      cursor: parseInt(row.cursor),
      type: row.type,
      agentId: row.agent_id,
      data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
      concepts: row.concepts || [],
      createdAt: row.created_at
    };
  }

  private mapReaction(row: any): Reaction {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      agentId: row.agent_id,
      triggerConcepts: row.trigger_concepts || [],
      triggerEventTypes: row.trigger_event_types || [],
      actionType: row.action_type,
      actionConfig: typeof row.action_config === 'string' ? JSON.parse(row.action_config) : row.action_config,
      priority: row.priority,
      enabled: row.enabled
    };
  }
}

export default Database;
