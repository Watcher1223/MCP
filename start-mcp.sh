#!/bin/bash
# Synapse MCP Server Startup Script

cd /var/www/synapse

echo "Starting Synapse MCP Server..."
echo ""
echo "Widget:    http://localhost:3200/widget"
echo "MCP API:   http://localhost:3200/mcp"
echo "WebSocket: ws://localhost:3200"
echo ""

npx tsx mcp/server.ts
