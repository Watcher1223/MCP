import { MCPServer } from "mcp-use/server";
import { z } from "zod";
import type { WorkspaceState } from "../types.js";
import type { DocSessionManager } from "../doc-session-manager.js";
import { generateId, now } from "../../shared/utils.js";

/** Register create_doc, list_sessions, get_doc_content tools. */
export function registerCoeditingTools(
  server: MCPServer,
  workspace: WorkspaceState,
  clientAgents: Map<string, string>,
  docManager: DocSessionManager,
  bumpVersion: () => void,
  apiPort: number,
): void {
  server.tool({
    name: "create_doc",
    description: "Create a collaborative editing session for a file. Idempotent: returns existing session if already open. Returns the collab WebSocket URL for real-time editing.",
    schema: z.object({
      path: z.string().min(1, "path is required").describe("File path (e.g. 'src/auth.ts')"),
      initial_content: z.string().optional().describe("Seed content for new doc"),
    }),
  }, async (args: any, ctx: any) => {
    const agentId = clientAgents.get(ctx?.session?.id || "");
    const agent = agentId ? workspace.agents.get(agentId) : null;
    const { created, session } = docManager.create(args.path, args.initial_content);

    if (created) {
      workspace.intents.push({
        id: generateId(),
        agentId: agentId || "unknown",
        agentName: agent?.name || "Unknown",
        client: agent?.client || "unknown",
        action: "working",
        description: `Created doc: ${args.path}`,
        timestamp: now(),
      });
    }

    bumpVersion();
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          created,
          path: session.path,
          editors: session.editors,
          collab_url: `ws://localhost:${apiPort}/collab`,
          instruction: created
            ? "Doc created. Connect via WS and send { type: 'join', path, agentId, name, role, environment }."
            : "Doc already exists. Connect and join.",
        }, null, 2),
      }],
    };
  });

  server.tool({
    name: "list_sessions",
    description: "List all active collaborative editing sessions with their editors and activity stats.",
    schema: z.object({}),
  }, async () => {
    const sessions = docManager.listSessions();
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ count: sessions.length, sessions }, null, 2),
      }],
    };
  });

  server.tool({
    name: "get_doc_content",
    description: "Get the current plain-text content of a collaborative doc. Useful for agents that can't connect via WebSocket.",
    schema: z.object({
      path: z.string().min(1, "path is required").describe("File path of the doc session"),
    }),
  }, async (args: any) => {
    const content = docManager.getTextContent(args.path);
    if (content === null) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ error: `No active session for '${args.path}'. Call create_doc first.` }),
        }],
      };
    }
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ path: args.path, content }, null, 2),
      }],
    };
  });
}
