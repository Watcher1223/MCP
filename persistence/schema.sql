-- Synapse Production Schema
-- PostgreSQL 14+

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Workspaces (multi-tenant isolation)
CREATE TABLE workspaces (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    api_key_hash VARCHAR(255) NOT NULL,
    api_key_prefix VARCHAR(8) NOT NULL,
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_workspaces_slug ON workspaces(slug);
CREATE INDEX idx_workspaces_api_key_prefix ON workspaces(api_key_prefix);

-- Agents
CREATE TABLE agents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    external_id VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'coder',
    type VARCHAR(50) NOT NULL DEFAULT 'realtime',
    environment VARCHAR(100),
    capabilities TEXT[] DEFAULT '{}',
    subscriptions TEXT[] DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    session_token VARCHAR(255),
    last_seen TIMESTAMPTZ DEFAULT NOW(),
    is_online BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(workspace_id, external_id)
);

CREATE INDEX idx_agents_workspace ON agents(workspace_id);
CREATE INDEX idx_agents_online ON agents(workspace_id, is_online);
CREATE INDEX idx_agents_role ON agents(workspace_id, role);
CREATE INDEX idx_agents_session ON agents(session_token);

-- Intents
CREATE TABLE intents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
    action VARCHAR(255) NOT NULL,
    description TEXT,
    targets TEXT[] DEFAULT '{}',
    concepts TEXT[] DEFAULT '{}',
    priority INTEGER DEFAULT 5,
    status VARCHAR(50) DEFAULT 'pending',
    result JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_intents_workspace ON intents(workspace_id);
CREATE INDEX idx_intents_agent ON intents(agent_id);
CREATE INDEX idx_intents_status ON intents(workspace_id, status);
CREATE INDEX idx_intents_concepts ON intents USING GIN(concepts);

-- Locks
CREATE TABLE locks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
    target_type VARCHAR(50) NOT NULL,
    target_path VARCHAR(1000) NOT NULL,
    target_identifier VARCHAR(255),
    intent_id UUID REFERENCES intents(id),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(workspace_id, target_path, target_identifier)
);

CREATE INDEX idx_locks_workspace ON locks(workspace_id);
CREATE INDEX idx_locks_agent ON locks(agent_id);
CREATE INDEX idx_locks_expires ON locks(expires_at);

-- Files (shared memory)
CREATE TABLE files (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    path VARCHAR(1000) NOT NULL,
    content TEXT,
    checksum VARCHAR(64),
    version INTEGER DEFAULT 1,
    last_modified_by UUID REFERENCES agents(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(workspace_id, path)
);

CREATE INDEX idx_files_workspace ON files(workspace_id);
CREATE INDEX idx_files_path ON files(workspace_id, path);

-- Events (audit log + replay)
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    cursor BIGSERIAL,
    type VARCHAR(100) NOT NULL,
    agent_id UUID REFERENCES agents(id),
    data JSONB NOT NULL DEFAULT '{}',
    concepts TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_events_workspace ON events(workspace_id);
CREATE INDEX idx_events_cursor ON events(workspace_id, cursor);
CREATE INDEX idx_events_type ON events(workspace_id, type);
CREATE INDEX idx_events_concepts ON events USING GIN(concepts);
CREATE INDEX idx_events_created ON events(created_at);

-- Reactions (automatic task triggers)
CREATE TABLE reactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
    trigger_concepts TEXT[] NOT NULL,
    trigger_event_types TEXT[] DEFAULT '{}',
    action_type VARCHAR(100) NOT NULL,
    action_config JSONB DEFAULT '{}',
    priority INTEGER DEFAULT 5,
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_reactions_workspace ON reactions(workspace_id);
CREATE INDEX idx_reactions_agent ON reactions(agent_id);
CREATE INDEX idx_reactions_concepts ON reactions USING GIN(trigger_concepts);

-- Knowledge (agent memory accumulation)
CREATE TABLE knowledge (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id UUID REFERENCES agents(id),
    concept VARCHAR(255) NOT NULL,
    fact TEXT NOT NULL,
    confidence FLOAT DEFAULT 1.0,
    source_event_id UUID REFERENCES events(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ
);

CREATE INDEX idx_knowledge_workspace ON knowledge(workspace_id);
CREATE INDEX idx_knowledge_concept ON knowledge(workspace_id, concept);
CREATE INDEX idx_knowledge_agent ON knowledge(agent_id);

-- API Keys (for enterprise)
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    key_hash VARCHAR(255) NOT NULL,
    key_prefix VARCHAR(8) NOT NULL,
    permissions TEXT[] DEFAULT '{read,write}',
    rate_limit INTEGER DEFAULT 1000,
    last_used TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix);

-- Audit Log
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id UUID REFERENCES agents(id),
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(100),
    resource_id UUID,
    details JSONB DEFAULT '{}',
    ip_address INET,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_workspace ON audit_log(workspace_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);

-- Functions
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_workspaces_updated
    BEFORE UPDATE ON workspaces
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_agents_updated
    BEFORE UPDATE ON agents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_files_updated
    BEFORE UPDATE ON files
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Cleanup expired locks
CREATE OR REPLACE FUNCTION cleanup_expired_locks()
RETURNS void AS $$
BEGIN
    DELETE FROM locks WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;
