// Synapse MCP Entry Point
// Run with: npm run dev or npx tsx mcp/server.ts
// This file re-exports from server.ts for convenience

export { httpServer, wss, state, updateWidgetState, tools, executeTool } from "./server.js";
