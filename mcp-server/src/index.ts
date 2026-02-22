// Synapse MCP Server
// Model Context Protocol adapter for AI agents

import express from 'express';
import { Logger } from '../../shared/utils.js';

const log = new Logger('MCP-Server');

interface MCPTool {
  name: string;
  description: string;
  inputSchema: object;
}

interface MCPRequest {
  jsonrpc: string;
  id: string | number;
  method: string;
  params?: any;
}

interface MCPResponse {
  jsonrpc: string;
  id: string | number;
  result?: any;
  error?: { code: number; message: string };
}

class SynapseMCPServer {
  private app: express.Application;
  private hubUrl: string;

  constructor(port: number = 3101, hubUrl: string = 'http://localhost:3100') {
    this.hubUrl = hubUrl;
    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();

    this.app.listen(port, () => {
      log.success(`Synapse MCP Server running on port ${port}`);
    });
  }

  private setupRoutes(): void {
    // MCP endpoint
    this.app.post('/mcp', async (req, res) => {
      const request = req.body as MCPRequest;
      const response = await this.handleMCPRequest(request);
      res.json(response);
    });

    // List tools
    this.app.get('/tools', (req, res) => {
      res.json({ tools: this.getTools() });
    });

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok' });
    });
  }

  private getTools(): MCPTool[] {
    return [
      {
        name: 'synapse_get_blueprint',
        description: 'Get the current shared working memory state including all agents, locks, intents, and files',
        inputSchema: {
          type: 'object',
          properties: {
            sinceCursor: {
              type: 'number',
              description: 'Only get updates since this cursor position',
            },
          },
        },
      },
      {
        name: 'synapse_broadcast_intent',
        description: 'Broadcast your intent to other agents so they know what you plan to do',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              description: 'What action you intend to take (e.g., "implement_feature", "refactor_code")',
            },
            targets: {
              type: 'array',
              items: { type: 'string' },
              description: 'File paths or semantic targets affected by this intent',
            },
            description: {
              type: 'string',
              description: 'Detailed description of what you plan to do',
            },
            priority: {
              type: 'number',
              description: 'Priority level (0-10, higher = more urgent)',
            },
          },
          required: ['action', 'targets', 'description'],
        },
      },
      {
        name: 'synapse_request_lock',
        description: 'Request exclusive access to a file or code section before editing',
        inputSchema: {
          type: 'object',
          properties: {
            targetType: {
              type: 'string',
              enum: ['file', 'function', 'class', 'module'],
              description: 'Type of lock target',
            },
            path: {
              type: 'string',
              description: 'Path to the file or module',
            },
            identifier: {
              type: 'string',
              description: 'Specific function or class name (optional)',
            },
            ttl: {
              type: 'number',
              description: 'Lock duration in milliseconds (default: 30000)',
            },
          },
          required: ['targetType', 'path'],
        },
      },
      {
        name: 'synapse_release_lock',
        description: 'Release a previously acquired lock',
        inputSchema: {
          type: 'object',
          properties: {
            lockId: {
              type: 'string',
              description: 'The ID of the lock to release',
            },
          },
          required: ['lockId'],
        },
      },
      {
        name: 'synapse_file_patch',
        description: 'Create, modify, or delete a file in the shared workspace',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path',
            },
            operation: {
              type: 'string',
              enum: ['create', 'modify', 'delete'],
              description: 'Operation to perform',
            },
            content: {
              type: 'string',
              description: 'File content (for create/modify)',
            },
            lockId: {
              type: 'string',
              description: 'Lock ID if you have exclusive access',
            },
          },
          required: ['path', 'operation'],
        },
      },
      {
        name: 'synapse_get_events',
        description: 'Get recent events from other agents',
        inputSchema: {
          type: 'object',
          properties: {
            sinceCursor: {
              type: 'number',
              description: 'Get events after this cursor position',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of events to return',
            },
          },
          required: ['sinceCursor'],
        },
      },
      {
        name: 'synapse_report_test',
        description: 'Report test execution results',
        inputSchema: {
          type: 'object',
          properties: {
            testName: {
              type: 'string',
              description: 'Name of the test',
            },
            status: {
              type: 'string',
              enum: ['started', 'passed', 'failed'],
              description: 'Test status',
            },
            details: {
              type: 'string',
              description: 'Additional details',
            },
            errors: {
              type: 'array',
              items: { type: 'string' },
              description: 'Error messages if failed',
            },
          },
          required: ['testName', 'status'],
        },
      },
    ];
  }

  private async handleMCPRequest(request: MCPRequest): Promise<MCPResponse> {
    const { id, method, params } = request;

    try {
      switch (method) {
        case 'tools/list':
          return {
            jsonrpc: '2.0',
            id,
            result: { tools: this.getTools() },
          };

        case 'tools/call':
          const result = await this.callTool(params.name, params.arguments);
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
          };

        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          };
      }
    } catch (error: any) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: error.message },
      };
    }
  }

  private async callTool(name: string, args: any): Promise<any> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (args.agentId) {
      headers['X-Agent-Id'] = args.agentId;
    }

    switch (name) {
      case 'synapse_get_blueprint': {
        const url = args.sinceCursor
          ? `${this.hubUrl}/api/blueprint?since=${args.sinceCursor}`
          : `${this.hubUrl}/api/blueprint`;
        const response = await fetch(url);
        return response.json();
      }

      case 'synapse_broadcast_intent': {
        const response = await fetch(`${this.hubUrl}/api/intent`, {
          method: 'POST',
          headers,
          body: JSON.stringify(args),
        });
        return response.json();
      }

      case 'synapse_request_lock': {
        const response = await fetch(`${this.hubUrl}/api/lock`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            target: {
              type: args.targetType,
              path: args.path,
              identifier: args.identifier,
            },
            ttl: args.ttl,
          }),
        });
        return response.json();
      }

      case 'synapse_release_lock': {
        const response = await fetch(`${this.hubUrl}/api/lock/${args.lockId}`, {
          method: 'DELETE',
          headers,
        });
        return response.json();
      }

      case 'synapse_file_patch': {
        const response = await fetch(`${this.hubUrl}/api/file`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            patch: {
              path: args.path,
              operation: args.operation,
              content: args.content,
            },
            lockId: args.lockId,
          }),
        });
        return response.json();
      }

      case 'synapse_get_events': {
        const url = `${this.hubUrl}/api/events?since=${args.sinceCursor}&limit=${args.limit || 100}`;
        const response = await fetch(url);
        return response.json();
      }

      case 'synapse_report_test': {
        const response = await fetch(`${this.hubUrl}/api/test`, {
          method: 'POST',
          headers,
          body: JSON.stringify(args),
        });
        return response.json();
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}

// Run if executed directly
const isMain = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isMain) {
  const port = parseInt(process.env.MCP_PORT || '3101');
  const hubUrl = process.env.HUB_URL || 'http://localhost:3100';
  new SynapseMCPServer(port, hubUrl);
}

export default SynapseMCPServer;
