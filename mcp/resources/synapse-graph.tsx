// Synapse Live Collaboration Graph Widget
// Renders in ChatGPT, Claude, and other MCP clients

import React, { useEffect, useState, useRef, useCallback } from "react";
import { McpUseProvider, useWidget, type WidgetMetadata } from "mcp-use/react";
import { z } from "zod";

// Widget props schema
const propsSchema = z.object({
  agents: z.array(z.object({
    id: z.string(),
    type: z.literal("agent"),
    label: z.string(),
    status: z.string().optional(),
    role: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  })).default([]),
  locks: z.array(z.object({
    id: z.string(),
    type: z.literal("lock"),
    label: z.string(),
    status: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  })).default([]),
  intents: z.array(z.object({
    id: z.string(),
    type: z.literal("intent"),
    label: z.string(),
    status: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  })).default([]),
  edges: z.array(z.object({
    id: z.string(),
    source: z.string(),
    target: z.string(),
    type: z.enum(["working_on", "depends_on", "updated", "owns", "targets"]),
    animated: z.boolean().optional(),
  })).default([]),
  recentEvents: z.array(z.object({
    id: z.string(),
    type: z.string(),
    agent: z.string(),
    description: z.string(),
    timestamp: z.number(),
  })).default([]),
  lastUpdate: z.number().optional(),
});

type WidgetProps = z.infer<typeof propsSchema>;

export const widgetMetadata: WidgetMetadata = {
  description: "Live collaboration graph showing agents coordinating in real-time",
  props: propsSchema,
};

// Node component with animations
const GraphNode: React.FC<{
  node: WidgetProps["agents"][0];
  isNew?: boolean;
}> = ({ node, isNew }) => {
  const [scale, setScale] = useState(isNew ? 0 : 1);

  useEffect(() => {
    if (isNew) {
      setTimeout(() => setScale(1), 50);
    }
  }, [isNew]);

  const roleColors: Record<string, string> = {
    planner: "#a371f7",
    coder: "#58a6ff",
    tester: "#3fb950",
    refactor: "#f78166",
    observer: "#8b949e",
  };

  const typeColors: Record<string, string> = {
    agent: roleColors[node.role || ""] || "#58a6ff",
    lock: "#d29922",
    intent: "#8b949e",
  };

  const color = typeColors[node.type] || "#8b949e";
  const isActive = node.status === "active";

  return (
    <div
      style={{
        position: "absolute",
        left: node.x || 50,
        top: node.y || 50,
        padding: "8px 16px",
        background: `${color}15`,
        border: `2px solid ${color}`,
        borderRadius: 8,
        fontSize: 12,
        fontWeight: 500,
        transform: `scale(${scale})`,
        transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
        cursor: "pointer",
        zIndex: 10,
        boxShadow: isActive ? `0 0 12px ${color}40` : "none",
        animation: isActive ? "pulse 2s infinite" : "none",
      }}
    >
      <div>{node.label}</div>
      {node.role && (
        <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>
          {node.role}
        </div>
      )}
    </div>
  );
};

// Edge component
const GraphEdge: React.FC<{
  edge: WidgetProps["edges"][0];
  nodes: (WidgetProps["agents"][0] | WidgetProps["locks"][0] | WidgetProps["intents"][0])[];
}> = ({ edge, nodes }) => {
  const source = nodes.find((n) => n.id === edge.source);
  const target = nodes.find((n) => n.id === edge.target);

  if (!source || !target) return null;

  const x1 = (source.x || 50) + 40;
  const y1 = (source.y || 50) + 15;
  const x2 = (target.x || 50) + 40;
  const y2 = (target.y || 50) + 15;

  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);

  return (
    <div
      style={{
        position: "absolute",
        left: x1,
        top: y1,
        width: length,
        height: 2,
        background: edge.animated
          ? "linear-gradient(90deg, #484f58 50%, transparent 50%)"
          : "#484f58",
        backgroundSize: edge.animated ? "10px 2px" : undefined,
        transform: `rotate(${angle}deg)`,
        transformOrigin: "left center",
        animation: edge.animated ? "flow 0.5s linear infinite" : "none",
        zIndex: 1,
      }}
    />
  );
};

// Event item component
const EventItem: React.FC<{
  event: WidgetProps["recentEvents"][0];
  isNew?: boolean;
}> = ({ event, isNew }) => {
  return (
    <div
      style={{
        padding: "4px 8px",
        borderLeft: `2px solid ${isNew ? "#58a6ff" : "#484f58"}`,
        marginBottom: 4,
        fontSize: 11,
        opacity: 0.8,
        animation: isNew ? "fadeIn 0.3s ease" : "none",
      }}
    >
      {event.description}
    </div>
  );
};

// Stats component
const Stats: React.FC<{
  agents: number;
  locks: number;
  intents: number;
}> = ({ agents, locks, intents }) => (
  <div
    style={{
      display: "flex",
      gap: 16,
      marginBottom: 16,
      fontSize: 12,
    }}
  >
    <div
      style={{
        padding: "8px 16px",
        background: "var(--node-bg, #161b22)",
        borderRadius: 4,
      }}
    >
      <div style={{ fontWeight: "bold", fontSize: 18 }}>{agents}</div>
      Agents
    </div>
    <div
      style={{
        padding: "8px 16px",
        background: "var(--node-bg, #161b22)",
        borderRadius: 4,
      }}
    >
      <div style={{ fontWeight: "bold", fontSize: 18 }}>{locks}</div>
      Locks
    </div>
    <div
      style={{
        padding: "8px 16px",
        background: "var(--node-bg, #161b22)",
        borderRadius: 4,
      }}
    >
      <div style={{ fontWeight: "bold", fontSize: 18 }}>{intents}</div>
      Intents
    </div>
  </div>
);

// Main widget component
const SynapseGraphWidget: React.FC = () => {
  const { props, isPending, theme, callTool } = useWidget<WidgetProps>();
  const [prevIds, setPrevIds] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);

  // Track new nodes for animation
  const currentIds = new Set([
    ...(props?.agents || []).map((a) => a.id),
    ...(props?.locks || []).map((l) => l.id),
    ...(props?.intents || []).map((i) => i.id),
  ]);

  const newIds = new Set(
    [...currentIds].filter((id) => !prevIds.has(id))
  );

  useEffect(() => {
    setPrevIds(currentIds);
  }, [props]);

  // Auto-refresh periodically (every 5s to reduce load)
  useEffect(() => {
    const interval = setInterval(() => {
      callTool?.("subscribe_changes", { sinceCursor: 0, limit: 10 });
    }, 5000);
    return () => clearInterval(interval);
  }, [callTool]);

  if (isPending) {
    return (
      <McpUseProvider autoSize>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: 200,
            color: "#8b949e",
          }}
        >
          Connecting to Synapse...
        </div>
      </McpUseProvider>
    );
  }

  const allNodes = [
    ...(props?.agents || []),
    ...(props?.locks || []),
    ...(props?.intents || []),
  ];

  const isDark = theme === "dark" || theme === undefined;

  return (
    <McpUseProvider autoSize>
      <div
        style={{
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          background: isDark ? "#0d1117" : "#ffffff",
          color: isDark ? "#c9d1d9" : "#24292f",
          padding: 16,
          minHeight: 400,
        }}
      >
        <style>
          {`
            @keyframes pulse {
              0%, 100% { box-shadow: 0 0 0 0 rgba(88, 166, 255, 0.4); }
              50% { box-shadow: 0 0 0 8px rgba(88, 166, 255, 0); }
            }
            @keyframes flow {
              0% { background-position: 0 0; }
              100% { background-position: 10px 0; }
            }
            @keyframes fadeIn {
              from { opacity: 0; transform: translateX(-10px); }
              to { opacity: 0.8; transform: translateX(0); }
            }
          `}
        </style>

        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            marginBottom: 8,
          }}
        >
          Synapse Collaboration Graph
        </div>

        <Stats
          agents={props?.agents?.length || 0}
          locks={props?.locks?.length || 0}
          intents={props?.intents?.length || 0}
        />

        <div
          ref={containerRef}
          style={{
            position: "relative",
            width: "100%",
            height: 300,
            border: `1px solid ${isDark ? "#484f58" : "#d0d7de"}`,
            borderRadius: 8,
            overflow: "hidden",
            background: isDark ? "#0d1117" : "#ffffff",
          }}
        >
          {/* Render edges first */}
          {(props?.edges || []).map((edge) => (
            <GraphEdge key={edge.id} edge={edge} nodes={allNodes} />
          ))}

          {/* Render nodes */}
          {allNodes.map((node) => (
            <GraphNode
              key={node.id}
              node={node}
              isNew={newIds.has(node.id)}
            />
          ))}

          {/* Empty state */}
          {allNodes.length === 0 && (
            <div
              style={{
                position: "absolute",
                top: "50%",
                left: "50%",
                transform: "translate(-50%, -50%)",
                color: "#8b949e",
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: 24, marginBottom: 8 }}>No agents connected</div>
              <div style={{ fontSize: 12 }}>
                Use register_agent or spawn_role_agent to add collaborators
              </div>
            </div>
          )}
        </div>

        {/* Recent events */}
        <div style={{ marginTop: 16, maxHeight: 120, overflowY: "auto" }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              marginBottom: 8,
            }}
          >
            Recent Activity
          </div>
          {(props?.recentEvents || []).slice(-5).reverse().map((event, i) => (
            <EventItem key={event.id} event={event} isNew={i === 0} />
          ))}
          {(props?.recentEvents?.length || 0) === 0 && (
            <div style={{ fontSize: 11, color: "#8b949e" }}>
              No recent activity
            </div>
          )}
        </div>
      </div>
    </McpUseProvider>
  );
};

export default SynapseGraphWidget;
