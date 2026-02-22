// Stigmergy MCP Server - Shared Cognition Layer for AI Agents
// Built with mcp-use SDK for ChatGPT, Claude, Cursor, VS Code
//
// This file is the thin orchestrator that imports and wires all modules.

// Polyfill crypto.randomUUID for Node 18
import * as nodeCrypto from "crypto";
if (typeof globalThis.crypto === "undefined") {
  (globalThis as any).crypto = nodeCrypto;
} else if (typeof globalThis.crypto.randomUUID === "undefined") {
  (globalThis.crypto as any).randomUUID = () => nodeCrypto.randomUUID();
}

import { MCPServer } from "mcp-use/server";
import express from "express";
import cors from "cors";
import * as http from "http";

import { Logger } from "../shared/utils.js";
import { workspace, clientAgents, sseClients, bumpVersion, setBumpHook, initDemoData } from "./workspace.js";
import { DocSessionManager } from "./doc-session-manager.js";
import { startLockCleanup } from "./locks.js";
import { startPresenceCleanup } from "./presence.js";
import { registerCoordinationTools, startWorkCleanup } from "./tools/coordination.js";
import { registerLockTools } from "./tools/locks.js";
import { registerCoeditingTools } from "./tools/coediting.js";
import { registerIntentTools } from "./tools/intents.js";
import { registerGraphTools, registerListAllTools, buildWidgetGraphData } from "./tools/graph.js";
import { registerMissionTools } from "./tools/mission.js";
import { registerWarRoomTools } from "./tools/warroom.js";
import { registerCommandCenterTools } from "./tools/command-center.js";
import { registerGoogleTools, isGoogleConfigured } from "./tools/google-integration.js";
import { registerMeetingPrepTools } from "./tools/meeting-prep.js";
import { registerHttpRoutes } from "./http-routes.js";
import { setupCollabWs } from "./collab-ws.js";
import { warRoomCards, commandCenter, meetingKit } from "./workspace.js";

const log = new Logger("Stigmergy");

// Fly.io/mcp-use expects port 3000; locally we use 3200
const PORT = parseInt(process.env.PORT || "3200", 10);
const HOST = process.env.HOST || "0.0.0.0";
// In production (single port), API_PORT = PORT. Locally we use PORT+1 for API.
const API_PORT = process.env.PORT ? PORT : PORT + 1;

// ========================================
// INITIALIZATION
// ========================================

if (process.env.DEMO_MODE === "1") {
  initDemoData();
  log.info("DEMO_MODE=1 — loaded demo agents, work items, and intents.");
}

const docManager = new DocSessionManager();

// Wire SSE broadcast to fire on version bumps, debounced to max ~10 events/sec
{
  let sseTimer: ReturnType<typeof setTimeout> | null = null;
  const SSE_MIN_INTERVAL_MS = 100;

  setBumpHook(() => {
    if (sseClients.size === 0) return;
    if (sseTimer) return; // already scheduled
    sseTimer = setTimeout(() => {
      sseTimer = null;
      if (sseClients.size === 0) return;
      const data = JSON.stringify(buildWidgetGraphData(workspace, docManager));
      const frame = `data: ${data}\n\n`;
      sseClients.forEach(res => {
        res.write(frame);
      });
    }, SSE_MIN_INTERVAL_MS);
  });
}

startLockCleanup(workspace, bumpVersion);
startPresenceCleanup(workspace, bumpVersion);
startWorkCleanup(workspace, bumpVersion);

// ========================================
// MCP SERVER
// ========================================

// NOTE: We do NOT pass OAuth to MCPServer. mcp-use OAuth gates ALL /mcp routes with 401,
// which blocks ChatGPT from connecting. Gmail/Calendar use the manual flow instead:
// check_email/google_login returns a link -> user signs in -> google_auth_callback with code.
const server = new MCPServer({
  name: "stigmergy",
  version: "3.0.0",
  description: "Stigmergy - MCP Apps Hackathon: Multi-agent coordination (ChatGPT + Claude + Cursor) inside one chat. When user adds Stigmergy, call stigmergy-dashboard first to show the agents sidebar. Backend endpoint flow: ChatGPT ideates → call set_target with backend_task → Cursor polls and codes. Meeting Kit: ChatGPT builds kit; Claude researches. Email: gmail_create_draft or gmail_send_reply. When returning Google sign-in links, paste the full URL.",
});

// Register all MCP tools
// IMPORTANT: Register high-value tools FIRST — ChatGPT may truncate tool lists (~21 tools).
// Priority: email/travel/meeting (user-facing) before workspace coordination.
registerListAllTools(server);
registerGoogleTools(server, bumpVersion);
registerCommandCenterTools(server, bumpVersion);
registerMeetingPrepTools(server, bumpVersion);
registerWarRoomTools(server, bumpVersion);
registerMissionTools(server, workspace, clientAgents, bumpVersion);
registerCoordinationTools(server, workspace, clientAgents, bumpVersion);
registerLockTools(server, workspace, clientAgents, bumpVersion);
registerIntentTools(server, workspace, clientAgents, bumpVersion);
registerCoeditingTools(server, workspace, clientAgents, docManager, bumpVersion, API_PORT);
registerGraphTools(server, workspace, docManager);

// ========================================
// MCP RESOURCES
// ========================================

server.resource({
  name: "workspace",
  description: "Current workspace state",
  uri: "stigmergy://workspace",
  mimeType: "application/json",
}, async () => {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        target: workspace.target,
        agents: Array.from(workspace.agents.values()),
        locks: Array.from(workspace.locks.values()),
        intents: workspace.intents.slice(-20),
        workQueue: workspace.workQueue,
        version: workspace.version,
      }, null, 2),
    }]
  };
});

server.resource({
  name: "message-board",
  description: "Recent intents/messages",
  uri: "stigmergy://intents",
  mimeType: "application/json",
}, async () => {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(workspace.intents.slice(-50), null, 2),
    }]
  };
});

// ========================================
// MCP-UI RESOURCE - Dashboard (ChatGPT, Inspector)
// ========================================

const DASHBOARD_API_PORT = process.env.API_PORT || "3201";
const DASHBOARD_URL = process.env.SYNAPSE_DASHBOARD_URL || `http://localhost:${DASHBOARD_API_PORT}`;
// MCP endpoint base — always the main PORT, not the API port.
// In production SYNAPSE_DASHBOARD_URL and MCP are on the same host; locally MCP is PORT (3200).
const MCP_BASE_URL = (process.env.SYNAPSE_DASHBOARD_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");

const DASHBOARD_HTML = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/><title>Agents</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0d1117;color:#c9d1d9;padding:10px;font-size:12px;min-height:100vh;overflow-wrap:break-word;word-break:break-word}
.sidebar-title{font-size:11px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid #30363d}
.agent-row{display:flex;flex-direction:column;gap:2px;padding:8px 10px;background:#161b22;border:1px solid #30363d;border-radius:6px;margin-bottom:6px}
.agent-name{color:#58a6ff;font-weight:600;font-size:12px}
.agent-meta{font-size:10px;color:#8b949e}
.agent-task{font-size:11px;color:#c9d1d9;margin-top:4px;padding-left:8px;border-left:2px solid #484f58}
.agent-task.working{border-color:#22c55e;color:#7ee787}
.agent-task.idle{color:#8b949e;font-style:italic}
.status-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px}
.status-dot.working{background:#22c55e}
.status-dot.idle{background:#6b7280}
.status-dot.waiting{background:#d29922}
.target-bar{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:8px 10px;margin-bottom:10px}
.target-bar .label{font-size:10px;color:#8b949e;text-transform:uppercase}
.target-bar .value{color:#a371f7;font-weight:600}
.work-item{font-size:10px;padding:4px 8px;background:#0d1117;border-radius:4px;margin-top:4px;border-left:2px solid #484f58;padding-left:8px}
.work-item.assigned{border-color:#22c55e}
.work-item.pending{border-color:#6b7280}
.activity{font-size:10px;border-left:2px solid #484f58;padding:4px 8px;margin:2px 0;opacity:0.9}
</style>
</head>
<body>
<div style="background:linear-gradient(90deg,#7c3aed,#a855f7);color:white;padding:5px 10px;font-size:10px;font-weight:600;text-align:center">MCP Apps Hackathon Feb 21 • YC SF • Manufact</div>
<div style="margin:8px 0;padding:8px;background:#161b22;border:1px solid #30363d;border-radius:6px;font-size:10px">
  <div style="color:#8b949e;margin-bottom:4px">Backend Endpoint: ChatGPT ideates → Cursor codes</div>
  <div style="display:flex;gap:6px;flex-wrap:wrap">
    <button onclick="typeof copyBackendChatGPTPrompt==='function'&&copyBackendChatGPTPrompt()" style="padding:4px 10px;background:#7c3aed;color:white;border:none;border-radius:4px;font-size:10px;cursor:pointer">Copy ChatGPT Prompt</button>
    <button onclick="typeof copyBackendCursorPrompt==='function'&&copyBackendCursorPrompt()" style="padding:4px 10px;background:#22c55e;color:white;border:none;border-radius:4px;font-size:10px;cursor:pointer">Copy Cursor Prompt</button>
  </div>
</div>
<div class="sidebar-title" style="display:flex;align-items:center;justify-content:space-between">
  <span>Active Agents</span>
  <button class="mk-btn mk-btn-icon" onclick="window.openai&&window.openai.requestDisplayMode&&window.openai.requestDisplayMode('fullscreen')" title="Fullscreen" style="padding:2px 6px;font-size:12px">⛶</button>
</div>
<div id="root">Loading...</div>
<script>
(function(){
  const BAKED_API = '${DASHBOARD_URL}';
  const MCP_BASE = '${MCP_BASE_URL}';
  const origin = window.location.origin;
  const isLocalhost = origin.includes('localhost') || origin.includes('127.0.0.1');
  const inChatGPT = !!(window.openai && window.openai.callTool);
  const API = isLocalhost && !inChatGPT ? BAKED_API : (isLocalhost ? null : origin);
  const callTool = inChatGPT ? window.openai.callTool.bind(window.openai) : null;
  const followUp = (window.openai&&window.openai.sendFollowUpMessage) ? function(m){window.openai.sendFollowUpMessage({prompt:m})} : function(){};
  const MCP_URL = MCP_BASE + '/mcp';
  function esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML}
  window.copyBackendChatGPTPrompt = function(){
    var p = [
      'When the user asks you to ideate a backend endpoint, do this:',
      '1. Design the endpoint (method, path, request/response, validation).',
      '2. Call set_target with the spec so Cursor can implement it:',
      '   set_target({',
      '     target: "POST /api/users (or whatever endpoint)",',
      '     backend_task: "Implement POST /api/users: validate email, hash password, create user in DB, return 201. Use the framework in the project."',
      '   })',
      '3. Tell the user: "I\'ve queued the task. Copy the Cursor prompt from the Stigmergy dashboard and paste it in Cursor — Cursor will implement it."',
      '',
      'When the user asks "what did Cursor build?" or "what did Cursor implement?" or "show me what was completed":',
      '  Call read_intents({}) or get_graph_widget({}). read_intents returns recent activity like "[completed] Cursor Agent: Implemented POST /api/users". Summarize what Cursor (or any agent) built.',
    ].join('\n');
    try{navigator.clipboard.writeText(p)}catch(e){}
    followUp('ChatGPT prompt copied. Paste this in ChatGPT so it knows to ideate and call set_target. Then copy the Cursor prompt for Cursor.');
  };
  window.copyBackendCursorPrompt = function(){
    var p = [
      'Add Stigmergy MCP to Cursor (same URL as ChatGPT). ChatGPT has queued a backend task — you will implement it.',
      '',
      'PREREQUISITE: Add Stigmergy MCP: ' + MCP_URL,
      '',
      'STEP 1 — Join as backend (you\'re the coder):',
      '  join_workspace({ "name": "Cursor Agent", "client": "cursor", "role": "backend", "autonomous": true })',
      '',
      'STEP 2 — Poll for the task ChatGPT created:',
      '  poll_work({ "role": "backend" })',
      '  You\'ll get the backend_task spec (e.g. "Implement POST /api/users...").',
      '',
      'STEP 3 — Implement it:',
      '  Write the code in the project. Create the endpoint, add validation, etc.',
      '',
      'STEP 4 — Mark done:',
      '  complete_work({ "work_id": "<id from poll_work>", "result": "Implemented POST /api/users" })',
      '',
      'We share context: ChatGPT ideated, you code. Same workspace.',
    ].join('\n');
    try{navigator.clipboard.writeText(p)}catch(e){}
    followUp('Cursor prompt copied. Paste in Cursor — Cursor will join, poll for the backend task, and implement it.');
  };
  function parseToolResult(r){
    if(!r)return null;
    let raw = r?.content?.[0]?.text ?? r?.result?.content?.[0]?.text ?? (typeof r==='string'?r:null);
    if(!raw)return null;
    try{return JSON.parse(raw)}catch(e){return null}
  }
  async function getData(){
    if(API){
      try{
        const res=await fetch(API+'/api/graph?format=widget');
        if(res.ok)return await res.json();
      }catch(e){}
    }
    if(inChatGPT&&callTool){
      try{
        const r=await callTool('get_graph_widget',{});
        return parseToolResult(r)
      }catch(e){return null}
    }
    return null
  }
  function render(d){
    if(!d){document.getElementById('root').innerHTML='<div class="agent-row">No agents yet. Add Stigmergy and start coordinating.</div>';return}
    let h='';
    if(d.target){h+='<div class="target-bar"><div class="label">Target</div><div class="value">'+esc(d.target)+'</div></div>'}
    const agents=d.agents||[];
    if(agents.length===0){h+='<div class="agent-row"><span class="agent-name">No active agents</span><div class="agent-task idle">Agents appear when they join the workspace</div></div>'}
    agents.forEach(function(a){
      const task=a.currentTask||(a.status==='working'?'Working...':'Idle');
      const statusCls=a.status==='working'?'working':a.status==='waiting'?'waiting':'idle';
      h+='<div class="agent-row">';
      h+='<span class="agent-name"><span class="status-dot '+a.status+'"></span>'+esc(a.label)+'</span>';
      h+='<span class="agent-meta">'+esc(a.role)+' • '+esc(a.status)+'</span>';
      h+='<div class="agent-task '+statusCls+'">'+esc(task)+'</div>';
      const myWork=(d.workQueue||[]).filter(function(w){return w.assignedTo===a.id&&w.status!=='completed'});
      myWork.forEach(function(w){h+='<div class="work-item assigned">'+esc(w.description)+'</div>'});
      h+='</div>'
    });
    const pending=(d.workQueue||[]).filter(function(w){return w.status==='pending'});
    if(pending.length>0){h+='<div class="sidebar-title" style="margin-top:12px">Pending</div>';pending.slice(0,3).forEach(function(w){h+='<div class="work-item pending">'+esc(w.description)+'</div>'})}
    if((d.recentEvents||[]).length>0){h+='<div class="sidebar-title" style="margin-top:12px">Recent</div>';(d.recentEvents||[]).slice().reverse().slice(0,5).forEach(function(e){h+='<div class="activity">'+esc(e.agent)+': '+esc(e.description)+'</div>'})}
    document.getElementById('root').innerHTML=h||'No activity yet.'
  }
  async function refresh(){
    try{
      const d=await getData();
      render(d);
    }catch(e){
      const root=document.getElementById('root');
      if(root)root.innerHTML='<div class="agent-row"><span class="agent-name">Connection issue</span><div class="agent-task idle">Retrying...</div></div>';
    }
  }
  refresh();setInterval(refresh,inChatGPT?3000:2000)
})();
</script>
</body>
</html>`;

server.uiResource({
  type: "mcpApps",
  name: "stigmergy-dashboard",
  title: "Agents Sidebar",
  description: "CRITICAL: Call this IMMEDIATELY when the user adds Stigmergy to the chat. This is the agents sidebar — shows active agents, what each is working on, target, work queue, and recent activity. Always show this widget first, before any other response. The user expects to see the agents sidebar as soon as they connect.",
  htmlTemplate: DASHBOARD_HTML,
  metadata: {
    description: "Stigmergy collaboration state: target, agents, locked files, recent activity",
    csp: {
      connectDomains: [
        "http://localhost:3200", "http://localhost:3201", "http://127.0.0.1:3200", "http://127.0.0.1:3201",
        "https://*.run.mcp-use.com", "https://*.fly.dev",
      ],
      resourceDomains: ["*"],
    },
    prefersBorder: true,
    autoResize: true,
  },
  toolOutput: () => ({
    content: [{
      type: "text" as const,
      text: `Stigmergy dashboard opened. Target: ${workspace.target || "none"}. Agents: ${workspace.agents.size}. Locks: ${workspace.locks.size}.`,
    }],
  }),
});

// ========================================
// MISSION CONTROL WIDGET - Morphing UI for Multi-Agent Coordination
// ========================================

const MISSION_CONTROL_HTML = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>Mission Control</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --idle-color: #6b7280;
  --planning-color: #14b8a6;
  --executing-color: #22c55e;
  --conflict-color: #f97316;
  --complete-color: #a855f7;
  --bg-dark: #0d1117;
  --bg-card: #161b22;
  --border: #30363d;
  --text-primary: #c9d1d9;
  --text-secondary: #8b949e;
}
body {
  font-family: system-ui, -apple-system, sans-serif;
  background: var(--bg-dark);
  color: var(--text-primary);
  padding: 12px;
  min-height: 100vh;
}

/* State-based border and effects */
.mission-container {
  border: 2px solid var(--idle-color);
  border-radius: 12px;
  padding: 16px;
  transition: border-color 0.3s, box-shadow 0.3s;
}
.mission-container.idle { border-color: var(--idle-color); }
.mission-container.planning {
  border-color: var(--planning-color);
  box-shadow: 0 0 20px rgba(20, 184, 166, 0.3);
}
.mission-container.executing {
  border-color: var(--executing-color);
  animation: pulse-green 2s ease-in-out infinite;
}
.mission-container.conflict {
  border-color: var(--conflict-color);
  animation: shake 0.5s ease-in-out infinite, pulse-orange 1s ease-in-out infinite;
}
.mission-container.complete {
  border-color: var(--complete-color);
  box-shadow: 0 0 30px rgba(168, 85, 247, 0.4);
}

@keyframes pulse-green {
  0%, 100% { box-shadow: 0 0 10px rgba(34, 197, 94, 0.3); }
  50% { box-shadow: 0 0 25px rgba(34, 197, 94, 0.5); }
}
@keyframes pulse-orange {
  0%, 100% { box-shadow: 0 0 10px rgba(249, 115, 22, 0.4); }
  50% { box-shadow: 0 0 30px rgba(249, 115, 22, 0.7); }
}
@keyframes shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-2px); }
  75% { transform: translateX(2px); }
}

/* Header */
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
.header h1 {
  font-size: 16px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}
.status-badge {
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.status-badge.idle { background: var(--idle-color); color: white; }
.status-badge.planning { background: var(--planning-color); color: white; }
.status-badge.executing { background: var(--executing-color); color: white; }
.status-badge.conflict { background: var(--conflict-color); color: white; }
.status-badge.complete { background: var(--complete-color); color: white; }

/* Target input section */
.target-section {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 16px;
}
.target-section label {
  font-size: 11px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.target-input-row {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
.target-input-row input {
  flex: 1;
  background: var(--bg-dark);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 12px;
  color: var(--text-primary);
  font-size: 13px;
}
.target-input-row input:focus {
  outline: none;
  border-color: var(--planning-color);
}
.btn {
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-primary {
  background: var(--executing-color);
  color: white;
}
.btn-primary:hover { background: #16a34a; }
.btn-danger {
  background: var(--conflict-color);
  color: white;
}
.btn-danger:hover { background: #ea580c; }
.btn-secondary {
  background: var(--border);
  color: var(--text-primary);
}
.btn-secondary:hover { background: #484f58; }

/* Agent telemetry cards */
.agents-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}
.agent-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  position: relative;
}
.agent-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  border-radius: 8px 8px 0 0;
}
.agent-card.chatgpt::before { background: #10a37f; }
.agent-card.claude::before { background: #f97316; }
.agent-card.cursor::before { background: #3b82f6; }
.agent-card.vscode::before { background: #007acc; }
.agent-card.terminal::before { background: #6b7280; }
.agent-name {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 2px;
}
.agent-role {
  font-size: 10px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}
.agent-status {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  display: inline-block;
}
.agent-status.idle { background: #374151; color: #9ca3af; }
.agent-status.working { background: #166534; color: #86efac; }
.agent-status.waiting { background: #854d0e; color: #fde047; }
.agent-task {
  font-size: 9px;
  color: var(--text-secondary);
  margin-top: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Conflict/Approval alerts */
.alerts-section {
  margin-bottom: 16px;
}
.alert {
  background: var(--bg-card);
  border: 1px solid var(--conflict-color);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 8px;
}
.alert-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.alert-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--conflict-color);
}
.alert-desc {
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
.alert-actions {
  display: flex;
  gap: 6px;
}
.alert-actions .btn {
  padding: 6px 12px;
  font-size: 11px;
}

/* Progress bar */
.progress-section {
  margin-bottom: 16px;
}
.progress-bar {
  height: 6px;
  background: var(--border);
  border-radius: 3px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: var(--executing-color);
  transition: width 0.3s;
}
.progress-label {
  font-size: 10px;
  color: var(--text-secondary);
  margin-top: 4px;
  display: flex;
  justify-content: space-between;
}

/* Activity feed */
.activity-section {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  max-height: 150px;
  overflow-y: auto;
}
.activity-item {
  font-size: 11px;
  padding: 4px 0;
  border-bottom: 1px solid var(--border);
  display: flex;
  gap: 6px;
}
.activity-item:last-child { border-bottom: none; }
.activity-agent {
  font-weight: 500;
  color: var(--planning-color);
  white-space: nowrap;
}
.activity-desc {
  color: var(--text-secondary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Locks section */
.locks-section {
  margin-bottom: 16px;
}
.locks-section h3 {
  font-size: 11px;
  color: var(--text-secondary);
  text-transform: uppercase;
  margin-bottom: 6px;
}
.lock-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 4px;
  font-size: 11px;
}
.lock-path { color: #d29922; font-family: monospace; }
.lock-holder { color: var(--text-secondary); }

/* Empty state */
.empty-state {
  text-align: center;
  padding: 30px;
  color: var(--text-secondary);
}
.empty-state .icon {
  font-size: 32px;
  margin-bottom: 8px;
}
</style>
</head>
<body>
<div id="mission-root" class="mission-container idle">
  <div class="empty-state">
    <div class="icon">⏳</div>
    <div>Connecting to Mission Control...</div>
  </div>
</div>

<script>
(function() {
  const BAKED_API = '${DASHBOARD_URL}';
  const origin = window.location.origin;
  const isLocalhost = origin.includes('localhost') || origin.includes('127.0.0.1');
  const inChatGPT = !!(window.openai && window.openai.callTool);
  const API = isLocalhost && !inChatGPT ? BAKED_API : (isLocalhost ? null : origin);
  const root = document.getElementById('mission-root');

  // ChatGPT window.openai API hooks (with HTTP fallback for inspector/standalone)
  const useCallTool = inChatGPT
    ? (tool, args) => window.openai.callTool(tool, args)
    : (tool, args) => fetch(API + '/api/execute', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, arguments: args })
      }).then(r => r.json());

  const sendFollowUpMessage = (window.openai && window.openai.sendFollowUpMessage)
    ? (msg) => window.openai.sendFollowUpMessage({ prompt: msg })
    : (msg) => console.log('followUp:', msg);

  const setState = (window.openai && window.openai.setWidgetState)
    ? (s) => window.openai.setWidgetState(s)
    : (s) => {};

  let currentState = null;
  let eventSource = null;

  function getClientColor(client) {
    const colors = {
      chatgpt: '#10a37f',
      claude: '#f97316',
      cursor: '#3b82f6',
      vscode: '#007acc',
      terminal: '#6b7280'
    };
    return colors[client] || '#6b7280';
  }

  function render(data) {
    currentState = data;
    const state = data.missionState || 'idle';

    // Update container class for visual state
    root.className = 'mission-container ' + state;
    setState({ phase: state, conflicts: data.conflicts || [] });

    let html = '';

    // Header with status badge
    html += '<div class="header">';
    html += '<h1>🎯 Mission Control</h1>';
    html += '<span class="status-badge ' + state + '">' + state.toUpperCase() + '</span>';
    html += '</div>';

    // Target input section
    html += '<div class="target-section">';
    html += '<label>Current Target</label>';
    html += '<div class="target-input-row">';
    html += '<input type="text" id="target-input" placeholder="Enter mission target..." value="' + (data.target || '') + '"/>';
    html += '<button class="btn btn-primary" onclick="setTarget()">Set Target</button>';
    html += '</div></div>';

    // Agent telemetry cards
    const agents = data.agents || [];
    if (agents.length > 0) {
      html += '<div class="agents-grid">';
      agents.forEach(a => {
        html += '<div class="agent-card ' + a.client + '">';
        html += '<div class="agent-name">' + a.name + '</div>';
        html += '<div class="agent-role">' + a.role + ' · ' + a.client + '</div>';
        html += '<span class="agent-status ' + a.status + '">' + a.status + '</span>';
        if (a.currentTask) {
          html += '<div class="agent-task" title="' + a.currentTask + '">' + a.currentTask + '</div>';
        }
        html += '</div>';
      });
      html += '</div>';
    } else {
      html += '<div class="empty-state" style="padding:20px"><div class="icon">👥</div><div>Waiting for agents to join...</div></div>';
    }

    // Conflicts and Approval Gates
    const conflicts = data.conflicts || [];
    const approvals = data.approvalGates || [];
    if (conflicts.length > 0 || approvals.length > 0) {
      html += '<div class="alerts-section">';

      conflicts.forEach(c => {
        html += '<div class="alert">';
        html += '<div class="alert-header">';
        html += '<span class="alert-title">⚠️ ' + c.type.replace(/_/g, ' ').toUpperCase() + '</span>';
        html += '</div>';
        html += '<div class="alert-desc">' + c.description + '</div>';
        if (c.involvedFiles && c.involvedFiles.length > 0) {
          html += '<div class="alert-desc">Files: ' + c.involvedFiles.join(', ') + '</div>';
        }
        html += '<div class="alert-actions">';
        if (c.type === 'lock_collision' && c.involvedFiles) {
          html += '<button class="btn btn-danger" onclick="forceUnlock(\\'' + c.involvedFiles[0] + '\\')">Force Unlock</button>';
        }
        html += '<button class="btn btn-primary" onclick="resolveConflict(\\'' + c.id + '\\')">Resolve</button>';
        html += '</div></div>';
      });

      approvals.forEach(a => {
        html += '<div class="alert">';
        html += '<div class="alert-header">';
        html += '<span class="alert-title">⏳ APPROVAL NEEDED</span>';
        html += '</div>';
        html += '<div class="alert-desc">' + a.description + '</div>';
        html += '<div class="alert-desc">Requested by: ' + a.requestedByName + '</div>';
        html += '<div class="alert-actions">';
        html += '<button class="btn btn-primary" onclick="approveGate(\\'' + a.id + '\\', true)">✓ Approve</button>';
        html += '<button class="btn btn-danger" onclick="approveGate(\\'' + a.id + '\\', false)">✗ Reject</button>';
        html += '</div></div>';
      });

      html += '</div>';
    }

    // Progress bar
    const progress = data.workProgress || { total: 0, completed: 0, inProgress: 0, pending: 0 };
    if (progress.total > 0) {
      const pct = Math.round((progress.completed / progress.total) * 100);
      html += '<div class="progress-section">';
      html += '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div>';
      html += '<div class="progress-label">';
      html += '<span>' + progress.completed + '/' + progress.total + ' tasks complete</span>';
      html += '<span>' + pct + '%</span>';
      html += '</div></div>';
    }

    // Locks section
    const locks = data.locks || [];
    if (locks.length > 0) {
      html += '<div class="locks-section">';
      html += '<h3>🔒 Active Locks</h3>';
      locks.forEach(l => {
        html += '<div class="lock-item">';
        html += '<span class="lock-path">' + l.path + '</span>';
        html += '<span class="lock-holder">' + l.agentName + ' (' + l.expiresIn + 's)</span>';
        html += '<button class="btn btn-secondary" onclick="forceUnlock(\\'' + l.path + '\\')" style="padding:4px 8px;font-size:10px">Force</button>';
        html += '</div>';
      });
      html += '</div>';
    }

    // Activity feed
    const activity = data.recentActivity || [];
    if (activity.length > 0) {
      html += '<div class="activity-section">';
      activity.slice().reverse().forEach(a => {
        html += '<div class="activity-item">';
        html += '<span class="activity-agent">' + a.agentName + '</span>';
        html += '<span class="activity-desc">' + a.description + '</span>';
        html += '</div>';
      });
      html += '</div>';
    }

    root.innerHTML = html;
  }

  // Action handlers
  window.setTarget = async function() {
    const input = document.getElementById('target-input');
    const target = input.value.trim();
    if (!target) return;

    try {
      await useCallTool('set_target', { target });
      sendFollowUpMessage('Target set to: ' + target + '. Backend and frontend tasks queued for autonomous agents.');
    } catch (e) {
      console.error('setTarget error:', e);
    }
  };

  window.forceUnlock = async function(path) {
    try {
      const result = await fetch(API + '/api/mission/force-unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, reason: 'Force unlocked via Mission Control' })
      }).then(r => r.json());

      if (result.success) {
        sendFollowUpMessage('Force unlocked ' + path + ' (was held by ' + result.previousHolder + ')');
      }
      refresh();
    } catch (e) {
      console.error('forceUnlock error:', e);
    }
  };

  window.approveGate = async function(gateId, approved) {
    try {
      const result = await fetch(API + '/api/mission/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gate_id: gateId, approved })
      }).then(r => r.json());

      if (result.success) {
        sendFollowUpMessage(approved ? 'Approved request: ' + gateId : 'Rejected request: ' + gateId);
      }
      refresh();
    } catch (e) {
      console.error('approveGate error:', e);
    }
  };

  window.resolveConflict = async function(conflictId) {
    const resolution = prompt('Enter resolution description:');
    if (!resolution) return;

    try {
      const result = await fetch(API + '/api/mission/resolve-conflict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conflict_id: conflictId, resolution })
      }).then(r => r.json());

      if (result.success) {
        sendFollowUpMessage('Conflict resolved: ' + resolution);
      }
      refresh();
    } catch (e) {
      console.error('resolveConflict error:', e);
    }
  };

  // Fetch and render
  async function refresh() {
    try {
      if (inChatGPT) {
        // In ChatGPT: get mission state via MCP tool call
        const result = await useCallTool('get_mission_state', {});
        let state;
        if (result && result.content && result.content[0]) {
          state = JSON.parse(result.content[0].text);
        } else if (typeof result === 'string') {
          state = JSON.parse(result);
        } else {
          state = result;
        }
        if (state) render(state);
      } else {
        const r = await fetch(API + '/api/mission/state');
        render(await r.json());
      }
    } catch (e) {
      console.error('refresh error:', e);
      root.innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><div>Connection error. Start server: npm run mcp</div></div>';
    }
  }

  // Initialize with polling (SSE doesn't work in ChatGPT iframe)
  refresh();
  if (inChatGPT) {
    setInterval(refresh, 3000);
  } else {
    try {
      eventSource = new EventSource(API + '/api/events/stream');
      eventSource.onmessage = function() { refresh(); };
      eventSource.onerror = function() {
        eventSource.close();
        setInterval(refresh, 2000);
      };
    } catch (e) {
      setInterval(refresh, 2000);
    }
  }
})();
</script>
</body>
</html>`;

server.uiResource({
  type: "mcpApps",
  name: "mission-control",
  title: "Mission Control",
  description: "Real-time multi-agent coordination dashboard with interactive controls. Morphs between states: Idle, Planning, Executing, Conflict, Complete. Approve/reject requests, resolve conflicts, force unlock files.",
  htmlTemplate: MISSION_CONTROL_HTML,
  metadata: {
    description: "Mission Control for multi-agent coordination: visual state morphing, conflict resolution, approval gates, agent telemetry",
    csp: {
      connectDomains: [
        "http://localhost:3200", "http://localhost:3201", "http://127.0.0.1:3200", "http://127.0.0.1:3201",
        "https://*.run.mcp-use.com", "https://*.fly.dev",
      ],
      resourceDomains: ["*"],
    },
    prefersBorder: true,
    autoResize: true,
  },
  toolOutput: () => {
    const { computeMissionState, conflicts, approvalGates } = require("./workspace.js");
    const state = computeMissionState();
    const pendingConflicts = conflicts.filter((c: any) => c.status === "pending").length;
    const pendingApprovals = approvalGates.filter((a: any) => a.status === "pending").length;
    let msg = `Mission Control opened. State: ${state}. Target: ${workspace.target || "none"}. Agents: ${workspace.agents.size}.`;
    if (pendingConflicts > 0) msg += ` ⚠️ ${pendingConflicts} conflicts pending.`;
    if (pendingApprovals > 0) msg += ` ⏳ ${pendingApprovals} approvals pending.`;
  return {
    content: [{
      type: "text" as const,
        text: msg,
      }],
    };
  },
});

// ========================================
// WAR ROOM WIDGET - Universal Collaboration Canvas
// ========================================

const WAR_ROOM_HTML = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>War Room</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d1117;--bg-card:#161b22;--bg-hover:#1c2333;--border:#30363d;
  --text:#c9d1d9;--text-dim:#8b949e;--text-faint:#484f58;
  --accent:#58a6ff;--green:#22c55e;--orange:#f97316;--purple:#a855f7;
  --red:#f85149;--yellow:#d29922;--teal:#14b8a6;
}
body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);padding:0;min-height:100vh;overflow-x:hidden}

/* ===== Header ===== */
.wr-header{
  display:flex;justify-content:space-between;align-items:center;
  padding:14px 16px;border-bottom:1px solid var(--border);
  background:linear-gradient(135deg,rgba(88,166,255,.05),rgba(168,85,247,.05));
}
.wr-title{font-size:15px;font-weight:700;display:flex;align-items:center;gap:8px}
.wr-title svg{width:18px;height:18px;stroke:var(--accent);fill:none;stroke-width:2}
.wr-badge{
  font-size:10px;padding:3px 8px;border-radius:10px;font-weight:600;
  background:rgba(88,166,255,.15);color:var(--accent);letter-spacing:.3px;
}
.wr-actions{display:flex;gap:6px}

/* ===== Kanban ===== */
.kanban{display:grid;grid-template-columns:1fr 1fr 1fr;gap:0;min-height:300px}
.column{
  border-right:1px solid var(--border);padding:12px 10px;min-height:250px;
  transition:background .2s;
}
.column:last-child{border-right:none}
.column.drag-over{background:rgba(88,166,255,.05)}
.col-header{
  display:flex;justify-content:space-between;align-items:center;
  margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border);
}
.col-title{
  font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;
  display:flex;align-items:center;gap:6px;
}
.col-title.todo{color:var(--orange)}
.col-title.doing{color:var(--accent)}
.col-title.done{color:var(--green)}
.col-count{
  font-size:10px;padding:2px 7px;border-radius:8px;
  background:rgba(255,255,255,.06);color:var(--text-dim);font-weight:600;
}
.col-dot{width:6px;height:6px;border-radius:50%;display:inline-block}
.col-dot.todo{background:var(--orange)}
.col-dot.doing{background:var(--accent);animation:pulse-dot 1.5s infinite}
.col-dot.done{background:var(--green)}
@keyframes pulse-dot{0%,100%{opacity:1}50%{opacity:.4}}

/* ===== Card ===== */
.card{
  background:var(--bg-card);border:1px solid var(--border);border-radius:10px;
  padding:12px;margin-bottom:8px;cursor:grab;
  transition:all .2s;position:relative;overflow:hidden;
}
.card:hover{border-color:var(--accent);transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.3)}
.card.dragging{opacity:.5;transform:rotate(2deg)}
.card.executing{border-color:var(--orange);animation:exec-pulse 1s infinite}
@keyframes exec-pulse{0%,100%{box-shadow:0 0 0 0 rgba(249,115,22,.2)}50%{box-shadow:0 0 12px 4px rgba(249,115,22,.15)}}

/* Card type indicator */
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.card.type-command::before{background:linear-gradient(90deg,var(--green),var(--teal))}
.card.type-task::before{background:linear-gradient(90deg,var(--accent),var(--purple))}
.card.type-info::before{background:linear-gradient(90deg,var(--yellow),var(--orange))}

.card-top{display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:6px}
.card-title{font-size:12px;font-weight:600;line-height:1.3;flex:1}
.card-icon{
  width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;
  font-size:13px;flex-shrink:0;
}
.card-icon.command{background:rgba(34,197,94,.12);color:var(--green)}
.card-icon.task{background:rgba(88,166,255,.12);color:var(--accent)}
.card-icon.info{background:rgba(210,153,34,.12);color:var(--yellow)}

.card-content{font-size:11px;color:var(--text-dim);line-height:1.45;margin-bottom:8px;max-height:60px;overflow:hidden}
.card-meta{display:flex;justify-content:space-between;align-items:center;gap:4px}
.card-tag{
  font-size:9px;padding:2px 7px;border-radius:4px;font-weight:600;
  background:rgba(255,255,255,.06);color:var(--text-dim);text-transform:uppercase;letter-spacing:.3px;
}

/* Terminal output */
.card-terminal{
  background:#000;border-radius:6px;padding:8px 10px;margin:8px 0;
  font-family:'SF Mono','Fira Code',monospace;font-size:10px;line-height:1.5;
  color:var(--green);max-height:120px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;
}
.card-terminal.error{color:var(--red)}
.card-terminal .prompt{color:var(--text-faint);user-select:none}

/* Buttons */
.btn{
  padding:6px 12px;border:none;border-radius:6px;font-size:10px;font-weight:600;
  cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;gap:4px;
}
.btn svg{width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:2}
.btn-exec{background:var(--green);color:#000}
.btn-exec:hover{background:#16a34a;transform:translateY(-1px)}
.btn-exec:disabled{opacity:.5;cursor:not-allowed;transform:none}
.btn-done{background:rgba(88,166,255,.15);color:var(--accent)}
.btn-done:hover{background:rgba(88,166,255,.25)}
.btn-ghost{background:transparent;color:var(--text-dim);padding:4px 6px}
.btn-ghost:hover{color:var(--text);background:rgba(255,255,255,.06)}
.btn-clear{background:rgba(248,81,73,.1);color:var(--red);border:1px solid rgba(248,81,73,.2)}
.btn-clear:hover{background:rgba(248,81,73,.2)}

/* Spinner */
.spinner{display:inline-block;width:12px;height:12px;border:2px solid rgba(0,0,0,.2);border-top-color:#000;border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* Empty state */
.empty{text-align:center;padding:30px 10px;color:var(--text-faint);font-size:11px}
.empty svg{width:24px;height:24px;stroke:var(--text-faint);fill:none;stroke-width:1.5;margin-bottom:6px}

/* Responsive */
@media(max-width:500px){.kanban{grid-template-columns:1fr}.column{border-right:none;border-bottom:1px solid var(--border)}}
</style>
</head>
<body>
<div id="wr-root">
  <div class="wr-header">
    <div class="wr-title">
      <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
      War Room
    </div>
    <span class="wr-badge">Loading...</span>
  </div>
  <div class="kanban">
    <div class="column"><div class="empty"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg><div>Connecting...</div></div></div>
    <div class="column"></div>
    <div class="column"></div>
  </div>
</div>

<script>
(function(){
  const BAKED_API = '${DASHBOARD_URL}';
  const origin = window.location.origin;
  const isLocalhost = origin.includes('localhost') || origin.includes('127.0.0.1');
  const inChatGPT = !!(window.openai && window.openai.callTool);
  const API = isLocalhost && !inChatGPT ? BAKED_API : (isLocalhost ? null : origin);
  const root = document.getElementById('wr-root');

  // === Icon SVGs (Lucide-style) ===
  const ICONS = {
    database: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
    globe: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    terminal: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
    code: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
    utensils: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg>',
    plane: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></svg>',
    search: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
    alert: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    rocket: '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" stroke-width="2"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>',
    play: '<svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
    checkCircle: '<svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    x: '<svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  };

  function getIcon(hint) {
    return ICONS[hint] || ICONS.rocket;
  }

  function getTypeIcon(type) {
    if (type === 'command') return ICONS.terminal;
    if (type === 'info') return ICONS.search;
    return ICONS.check;
  }

  // === ChatGPT window.openai API hooks (with HTTP fallback) ===
  const callTool = inChatGPT
    ? (name, args) => window.openai.callTool(name, args)
    : (name, args) => fetch(API + '/api/execute', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ tool: name, arguments: args })
      }).then(r => r.json());

  const sendFollowUp = (window.openai && window.openai.sendFollowUpMessage)
    ? (msg) => window.openai.sendFollowUpMessage({ prompt: msg })
    : (msg) => console.log('followUp:', msg);

  const widgetSetState = (window.openai && window.openai.setWidgetState)
    ? (s) => window.openai.setWidgetState(s)
    : (s) => {};

  let cards = [];
  let draggedId = null;

  // === Render ===
  function render() {
    const todo = cards.filter(c => c.column === 'todo');
    const doing = cards.filter(c => c.column === 'doing');
    const done = cards.filter(c => c.column === 'done');
    const total = cards.length;
    const doneCount = done.length;

    let html = '';

    // Header
    html += '<div class="wr-header">';
    html += '<div class="wr-title">';
    html += '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
    html += 'War Room';
    html += '</div>';
    html += '<div class="wr-actions">';
    if (total > 0) {
      html += '<span class="wr-badge">' + doneCount + '/' + total + ' done</span>';
      html += '<button class="btn btn-clear" onclick="clearBoard()">' + ICONS.trash + ' Clear</button>';
    } else {
      html += '<span class="wr-badge">Ready</span>';
    }
    html += '</div></div>';

    // Kanban columns
    html += '<div class="kanban">';
    html += renderColumn('todo', 'To Do', todo);
    html += renderColumn('doing', 'In Progress', doing);
    html += renderColumn('done', 'Done', done);
    html += '</div>';

    root.innerHTML = html;
  }

  function renderColumn(id, label, items) {
    let h = '<div class="column" id="col-' + id + '" ondragover="handleDragOver(event)" ondrop="handleDrop(event, \\'' + id + '\\')" ondragenter="this.classList.add(\\'drag-over\\')" ondragleave="this.classList.remove(\\'drag-over\\')">';
    h += '<div class="col-header">';
    h += '<span class="col-title ' + id + '"><span class="col-dot ' + id + '"></span>' + label + '</span>';
    h += '<span class="col-count">' + items.length + '</span>';
    h += '</div>';

    if (items.length === 0) {
      h += '<div class="empty"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg><div>' + (id === 'todo' ? 'Ask the AI to add tasks' : id === 'doing' ? 'Drag cards here' : 'Completed tasks appear here') + '</div></div>';
    } else {
      items.forEach(c => { h += renderCard(c); });
    }

    h += '</div>';
    return h;
  }

  function renderCard(c) {
    const typeClass = 'type-' + c.type;
    const execClass = c.executing ? ' executing' : '';
    let h = '<div class="card ' + typeClass + execClass + '" draggable="true" ondragstart="handleDragStart(event, \\'' + c.id + '\\')" ondragend="handleDragEnd(event)" data-id="' + c.id + '">';

    // Top row
    h += '<div class="card-top">';
    h += '<div class="card-title">' + esc(c.title) + '</div>';
    h += '<div class="card-icon ' + c.type + '">' + (c.icon ? getIcon(c.icon) : getTypeIcon(c.type)) + '</div>';
    h += '</div>';

    // Content
    if (c.content) {
      h += '<div class="card-content">' + esc(c.content) + '</div>';
    }

    // Terminal output
    if (c.type === 'command' && c.output) {
      h += '<div class="card-terminal' + (c.status === 'error' ? ' error' : '') + '">';
      h += '<span class="prompt">$ ' + esc(c.command || '') + '</span>\\n' + esc(c.output);
      h += '</div>';
    }

    // Command display (before execution)
    if (c.type === 'command' && c.command && !c.output && !c.executing) {
      h += '<div class="card-terminal"><span class="prompt">$ ' + esc(c.command) + '</span></div>';
    }

    // Meta + actions
    h += '<div class="card-meta">';
    if (c.category) {
      h += '<span class="card-tag">' + esc(c.category) + '</span>';
    } else {
      h += '<span class="card-tag">' + c.type + '</span>';
    }

    h += '<div style="display:flex;gap:4px">';
    if (c.type === 'command' && c.command && c.column !== 'done') {
      if (c.executing) {
        h += '<button class="btn btn-exec" disabled><span class="spinner"></span> Running</button>';
      } else {
        h += '<button class="btn btn-exec" onclick="executeCard(\\'' + c.id + '\\')">' + ICONS.play + ' Execute</button>';
      }
    }
    if (c.column !== 'done' && c.type !== 'command') {
      h += '<button class="btn btn-done" onclick="completeCard(\\'' + c.id + '\\')">' + ICONS.checkCircle + ' Done</button>';
    }
    h += '<button class="btn btn-ghost" onclick="dismissCard(\\'' + c.id + '\\')">' + ICONS.x + '</button>';
    h += '</div></div>';

    h += '</div>';
    return h;
  }

  function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // === Drag & Drop ===
  window.handleDragStart = function(e, id) {
    draggedId = id;
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => { const el = document.querySelector('[data-id="'+id+'"]'); if(el) el.classList.add('dragging'); }, 0);
  };
  window.handleDragEnd = function(e) {
    document.querySelectorAll('.card.dragging').forEach(el => el.classList.remove('dragging'));
    document.querySelectorAll('.column.drag-over').forEach(el => el.classList.remove('drag-over'));
    draggedId = null;
  };
  window.handleDragOver = function(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
  window.handleDrop = async function(e, col) {
    e.preventDefault();
    document.querySelectorAll('.column.drag-over').forEach(el => el.classList.remove('drag-over'));
    if (!draggedId) return;
    const card = cards.find(c => c.id === draggedId);
    if (!card || card.column === col) return;

    card.column = col;
    card.status = col === 'done' ? 'done' : col === 'doing' ? 'active' : 'pending';
    render();

    try {
      await callTool('move_card', { card_id: draggedId, column: col });
      sendFollowUp('Card "' + card.title + '" moved to ' + col + '.');
    } catch(err) {
      console.error('move failed:', err);
    }
    draggedId = null;
  };

  // === Card actions ===
  window.executeCard = async function(id) {
    const card = cards.find(c => c.id === id);
    if (!card) return;
    card.executing = true;
    card.column = 'doing';
    card.status = 'active';
    render();

    try {
      const result = await callTool('execute_action', { card_id: id, action: 'run' });
      let parsed = result;
      if (result && result.content && result.content[0]) {
        try { parsed = JSON.parse(result.content[0].text); } catch(e) { parsed = { output: result.content[0].text }; }
      }

      card.executing = false;
      if (parsed.output || parsed.status === 'done') {
        card.output = parsed.output || '(completed)';
        card.column = 'done';
        card.status = 'done';
      } else if (parsed.error) {
        card.output = parsed.error || 'Failed';
        card.status = 'error';
      }
      render();

      sendFollowUp(
        card.status === 'done'
          ? 'I executed the command on card "' + card.title + '". Result: ' + (card.output||'').slice(0,300)
          : 'Command on card "' + card.title + '" failed: ' + (card.output||'').slice(0,200) + '. What should we do?'
      );
    } catch(err) {
      card.executing = false;
      card.output = 'Error: ' + (err.message||err);
      render();
    }
  };

  window.completeCard = async function(id) {
    const card = cards.find(c => c.id === id);
    if (!card) return;
    card.column = 'done';
    card.status = 'done';
    render();

    try {
      await callTool('execute_action', { card_id: id, action: 'complete' });
      sendFollowUp('Marked "' + card.title + '" as done.');
    } catch(err) { console.error(err); }
  };

  window.dismissCard = async function(id) {
    cards = cards.filter(c => c.id !== id);
    render();
    try {
      await callTool('execute_action', { card_id: id, action: 'dismiss' });
    } catch(err) { console.error(err); }
  };

  window.clearBoard = async function() {
    cards = [];
    render();
    try {
      await callTool('clear_board', {});
      sendFollowUp('War Room board cleared. Ready for new tasks.');
    } catch(err) { console.error(err); }
  };

  // === Data fetching ===
  async function refresh() {
    try {
      if (inChatGPT) {
        // In ChatGPT: get cards via MCP tool call
        const result = await callTool('list_cards', {});
        let data;
        if (result && result.content && result.content[0]) {
          data = JSON.parse(result.content[0].text);
        } else if (typeof result === 'string') {
          data = JSON.parse(result);
        } else {
          data = result;
        }
        cards = (data && data.cards) || [];
      } else {
        const r = await fetch(API + '/api/warroom/cards');
        const data = await r.json();
        cards = data.cards || [];
      }
      widgetSetState({
        cardCount: cards.length,
        todoCount: cards.filter(c => c.column === 'todo').length,
        doingCount: cards.filter(c => c.column === 'doing').length,
        doneCount: cards.filter(c => c.column === 'done').length,
      });
      render();
    } catch(e) {
      console.error('refresh error:', e);
    }
  }

  // Start polling or SSE
  refresh();
  if (inChatGPT) {
    setInterval(refresh, 3000);
  } else {
    try {
      const es = new EventSource(API + '/api/events/stream');
      es.onmessage = function() { refresh(); };
      es.onerror = function() { es.close(); setInterval(refresh, 2000); };
    } catch(e) { setInterval(refresh, 2000); }
  }
})();
</script>
</body>
</html>`;

server.uiResource({
  type: "mcpApps",
  name: "war-room",
  title: "War Room",
  description: "Universal Collaboration Canvas — a Kanban board inside the chat. Use this to visualize and manage ANY kind of task: technical (terminal commands, git, DB migrations) or general (trip planning, research, brainstorming). Cards can be dragged between columns. Command cards have an Execute button that runs real shell commands. Always use the War Room to show progress visually instead of just writing text.",
  htmlTemplate: WAR_ROOM_HTML,
  metadata: {
    description: "War Room: Interactive Kanban board for visualizing tasks, running commands, and tracking progress — right inside the chat",
    csp: {
      connectDomains: [
        "http://localhost:3200", "http://localhost:3201", "http://127.0.0.1:3200", "http://127.0.0.1:3201",
        "https://*.run.mcp-use.com", "https://*.fly.dev",
      ],
      resourceDomains: ["*"],
    },
    prefersBorder: true,
    autoResize: true,
  },
  toolOutput: () => {
    const cardArr = Array.from(warRoomCards.values());
    const todo = cardArr.filter(c => c.column === "todo").length;
    const doing = cardArr.filter(c => c.column === "doing").length;
    const done = cardArr.filter(c => c.column === "done").length;
    return {
      content: [{
        type: "text" as const,
        text: `War Room opened. ${cardArr.length} cards: ${todo} todo, ${doing} in progress, ${done} done.`,
      }],
    };
  },
});

// ========================================
// COMMAND CENTER WIDGET — Stateful Omni-Agent Dashboard
// ========================================

const COMMAND_CENTER_HTML = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>Command Center</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0b0e14;--bg2:#111620;--bg3:#181d28;--bdr:#252d3a;
  --tx:#d1d5db;--tx2:#8b949e;--tx3:#5a6270;
  --blue:#3b82f6;--green:#22c55e;--orange:#f97316;--purple:#a855f7;
  --red:#ef4444;--yellow:#eab308;--teal:#14b8a6;--pink:#ec4899;
}
body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--tx);min-height:100vh;overflow-x:hidden}

/* ─── Top Bar ─── */
.cc-bar{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--bdr);background:var(--bg2)}
.cc-logo{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:700}
.cc-logo svg{width:18px;height:18px;stroke:var(--blue);fill:none;stroke-width:2}
.cc-status{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cc-account{font-size:11px;color:var(--green);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-account.cc-not-connected{color:var(--tx3)}
.cc-toolbar{display:flex;gap:8px;padding:8px 16px;border-bottom:1px solid var(--bdr);background:var(--bg2)}
.cc-pill{font-size:10px;padding:3px 10px;border-radius:10px;font-weight:600;letter-spacing:.3px}
.cc-pill.idle{background:rgba(34,197,94,.12);color:var(--green)}
.cc-pill.processing{background:rgba(59,130,246,.15);color:var(--blue);animation:cc-pulse 1.2s infinite}
.cc-pill.awaiting_user{background:rgba(249,115,22,.12);color:var(--orange)}
.cc-pill.done{background:rgba(168,85,247,.12);color:var(--purple)}
@keyframes cc-pulse{0%,100%{opacity:1}50%{opacity:.5}}
.cc-msg{font-size:11px;color:var(--tx2);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-btn-icon{background:rgba(255,255,255,.06);border:1px solid var(--bdr);border-radius:6px;color:var(--tx2);padding:4px 8px;font-size:12px;cursor:pointer}
.cc-btn-icon:hover{color:var(--tx);border-color:var(--blue)}

/* ─── Module Tabs ─── */
.cc-tabs{display:flex;gap:4px;padding:8px 16px;border-bottom:1px solid var(--bdr);background:var(--bg2);overflow-x:auto}
.cc-tab{font-size:11px;padding:5px 14px;border-radius:6px;cursor:pointer;transition:all .15s;display:flex;align-items:center;gap:5px;background:rgba(255,255,255,.04);color:var(--tx2);border:1px solid transparent;white-space:nowrap}
.cc-tab:hover{background:rgba(255,255,255,.08);color:var(--tx)}
.cc-tab.active{background:rgba(59,130,246,.12);color:var(--blue);border-color:rgba(59,130,246,.25)}
.cc-tab svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2}
.cc-tab-x{margin-left:4px;opacity:.5;cursor:pointer;font-size:13px;line-height:1}
.cc-tab-x:hover{opacity:1;color:var(--red)}

/* ─── Grid ─── */
.cc-grid{display:grid;gap:0;min-height:260px}
.cc-grid.cols-1{grid-template-columns:1fr}
.cc-grid.cols-2{grid-template-columns:1fr 1fr}
.cc-grid.cols-3{grid-template-columns:1fr 1fr 1fr}
.cc-grid.cols-4{grid-template-columns:1fr 1fr 1fr 1fr}
.cc-grid.cols-5{grid-template-columns:1fr 1fr 1fr 1fr 1fr}

.cc-panel{border-right:1px solid var(--bdr);padding:12px;overflow-y:auto;max-height:400px}
.cc-panel:last-child{border-right:none}
.cc-panel-hdr{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--tx3);margin-bottom:10px;display:flex;justify-content:space-between;align-items:center}
.cc-panel-count{font-size:10px;padding:1px 6px;border-radius:6px;background:rgba(255,255,255,.06);color:var(--tx2)}

/* ─── Email Cards ─── */
.em{background:var(--bg3);border:1px solid var(--bdr);border-radius:8px;padding:10px 12px;margin-bottom:6px;cursor:pointer;transition:all .15s;position:relative}
.em:hover{border-color:var(--blue);background:rgba(59,130,246,.04)}
.em.unread{border-left:3px solid var(--blue)}
.em-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.em-from{font-size:11px;font-weight:600}
.em-date{font-size:9px;color:var(--tx3)}
.em-subj{font-size:12px;font-weight:500;margin-bottom:3px;line-height:1.3}
.em-prev{font-size:10px;color:var(--tx2);line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.em-labels{display:flex;gap:3px;margin-top:6px;flex-wrap:wrap}
.em-label{font-size:8px;padding:2px 6px;border-radius:3px;background:rgba(255,255,255,.06);color:var(--tx2);text-transform:uppercase;letter-spacing:.3px}
.em-actions{display:flex;gap:4px;margin-top:6px}
.em-star{position:absolute;top:10px;right:10px;cursor:pointer;font-size:14px;opacity:.4;transition:opacity .15s}
.em-star:hover,.em-star.on{opacity:1;color:var(--yellow)}

/* ─── Flight Cards ─── */
.fl{background:var(--bg3);border:1px solid var(--bdr);border-radius:8px;padding:10px;margin-bottom:6px;transition:all .15s;cursor:pointer}
.fl:hover{border-color:var(--purple)}
.fl.selected{border-color:var(--green);background:rgba(34,197,94,.05);box-shadow:0 0 12px rgba(34,197,94,.1)}
.fl-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.fl-airline{font-size:11px;font-weight:600;display:flex;align-items:center;gap:4px}
.fl-price{font-size:14px;font-weight:700;color:var(--green)}
.fl-route{display:flex;align-items:center;gap:8px;font-size:11px;margin-bottom:4px}
.fl-city{font-weight:600;font-size:12px}
.fl-time{font-size:10px;color:var(--tx2)}
.fl-arrow{color:var(--tx3);flex-shrink:0}
.fl-meta{font-size:9px;color:var(--tx3);display:flex;gap:10px}
.fl-book{margin-top:6px}

/* ─── Calendar ─── */
.ev{background:var(--bg3);border:1px solid var(--bdr);border-radius:8px;padding:10px;margin-bottom:6px;display:flex;gap:10px;align-items:flex-start}
.ev-color{width:4px;border-radius:2px;min-height:36px;flex-shrink:0}
.ev-body{flex:1}
.ev-title{font-size:12px;font-weight:600;margin-bottom:2px}
.ev-detail{font-size:10px;color:var(--tx2);display:flex;gap:8px;flex-wrap:wrap}

/* ─── Terminal ─── */
.tm{background:#000;border-radius:6px;padding:8px 10px;margin-bottom:6px;font-family:'SF Mono','Fira Code',monospace;font-size:10px;line-height:1.5;max-height:150px;overflow-y:auto}
.tm-cmd{color:var(--tx3)}
.tm-out{color:var(--green);white-space:pre-wrap;word-break:break-all}
.tm-err{color:var(--red)}

/* ─── Buttons ─── */
.btn{padding:5px 10px;border:none;border-radius:5px;font-size:10px;font-weight:600;cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;gap:3px}
.btn svg{width:11px;height:11px;stroke:currentColor;fill:none;stroke-width:2}
.btn-blue{background:var(--blue);color:#fff}
.btn-blue:hover{background:#2563eb}
.btn-green{background:var(--green);color:#000}
.btn-green:hover{background:#16a34a}
.btn-ghost{background:transparent;color:var(--tx2);padding:4px 6px}
.btn-ghost:hover{color:var(--tx);background:rgba(255,255,255,.06)}
.btn-red{background:rgba(239,68,68,.12);color:var(--red);border:1px solid rgba(239,68,68,.2)}
.btn-red:hover{background:rgba(239,68,68,.2)}

/* ─── Empty ─── */
.cc-empty{text-align:center;padding:40px 16px;color:var(--tx3)}
.cc-empty svg{width:32px;height:32px;stroke:var(--tx3);fill:none;stroke-width:1.5;margin-bottom:8px}
.cc-empty h3{font-size:13px;color:var(--tx2);margin-bottom:4px}
.cc-empty p{font-size:11px}

/* ─── Action Log ─── */
.cc-log{padding:8px 16px;border-top:1px solid var(--bdr);background:var(--bg2)}
.cc-log-item{font-size:10px;color:var(--tx2);padding:2px 0;display:flex;align-items:center;gap:6px}
.cc-log-dot{width:5px;height:5px;border-radius:50%;flex-shrink:0}
</style>
</head>
<body>
<div id="cc-root">
  <div class="cc-bar">
    <div class="cc-logo">
      <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>
      Command Center
    </div>
    <div class="cc-status">
      <span class="cc-pill idle">IDLE</span>
      <span class="cc-msg">Connecting...</span>
    </div>
  </div>
  <div class="cc-empty" style="padding:60px"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg><h3>Loading Command Center...</h3><p>Waiting for data from server</p></div>
</div>

<script>
(function(){
  const BAKED_API = '${DASHBOARD_URL}';
  const origin = window.location.origin;
  const isLocalhost = origin.includes('localhost') || origin.includes('127.0.0.1');
  const inChatGPT = !!(window.openai && window.openai.callTool);
  const API = isLocalhost && !inChatGPT ? BAKED_API : (isLocalhost ? null : origin);
  const root = document.getElementById('cc-root');

  // ─── Icons ───
  const I = {
    mail:'<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" fill="none" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>',
    plane:'<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" fill="none" stroke-width="2"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></svg>',
    cal:'<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" fill="none" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    term:'<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" fill="none" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
    star:'<svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    archive:'<svg viewBox="0 0 24 24" width="11" height="11" stroke="currentColor" fill="none" stroke-width="2"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>',
    check:'<svg viewBox="0 0 24 24" width="11" height="11" stroke="currentColor" fill="none" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
    x:'<svg viewBox="0 0 24 24" width="11" height="11" stroke="currentColor" fill="none" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    arrowR:'<svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
    clock:'<svg viewBox="0 0 24 24" width="10" height="10" stroke="currentColor" fill="none" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    mapPin:'<svg viewBox="0 0 24 24" width="10" height="10" stroke="currentColor" fill="none" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    hotel:'<svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" fill="none" stroke-width="2"><path d="M18 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2Z"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M12 14h.01"/><path d="M16 10h.01"/><path d="M16 14h.01"/><path d="M8 10h.01"/><path d="M8 14h.01"/></svg>',
    bed:'<svg viewBox="0 0 24 24" width="10" height="10" stroke="currentColor" fill="none" stroke-width="2"><path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/></svg>',
  };

  const modIcon = { email: I.mail, travel: I.plane, hotels: I.hotel, calendar: I.cal, terminal: I.term };
  const modLabel = { email: 'Inbox', travel: 'Flights', hotels: 'Hotels', calendar: 'Calendar', terminal: 'Terminal' };

  // ─── ChatGPT window.openai API hooks (with HTTP fallback) ───
  const callTool = inChatGPT
    ? (n, a) => window.openai.callTool(n, a)
    : (n, a) => fetch(API+'/api/execute',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tool:n,arguments:a})}).then(r=>r.json());
  const followUp = (window.openai && window.openai.sendFollowUpMessage)
    ? (msg) => window.openai.sendFollowUpMessage({prompt:msg})
    : (msg) => console.log('followUp:',msg);
  const setWState = (window.openai && window.openai.setWidgetState)
    ? (s) => window.openai.setWidgetState(s)
    : (s) => {};

  let data = null;

  function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

  // ─── Render ───
  function render(d) {
    data = d;
    const mods = d.activeModules || [];
    const st = d.status || 'idle';
    setWState({ modules: mods.length, status: st, emails: d.data.emails.length, flights: d.data.flights.length, hotels: (d.data.hotels||[]).length, events: d.data.events.length });

    let h = '';

    // Top bar
    const conn = d.googleConnection || {};
    h += '<div class="cc-bar">';
    h += '<div class="cc-logo"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>Command Center</div>';
    h += '<div class="cc-status">';
    if (conn.connected && conn.email) {
      h += '<span class="cc-account" title="Connected account">'+I.mail+' '+esc(conn.email)+'</span>';
    } else if (conn.connected === false) {
      h += '<span class="cc-account cc-not-connected">Not connected</span>';
    }
    h += '<span class="cc-pill '+st+'">'+st.toUpperCase().replace('_',' ')+'</span>';
    h += '<span class="cc-msg">'+esc(d.statusMessage||'')+'</span>';
    if (inChatGPT && window.openai && window.openai.requestDisplayMode) {
      h += '<button class="cc-btn-icon" onclick="window.openai.requestDisplayMode(\\'fullscreen\\')" title="Fullscreen">⛶</button>';
    }
    h += '</div></div>';

    // Module tabs + toolbar
    if (mods.length > 0) {
      h += '<div class="cc-tabs">';
      mods.forEach(m => {
        h += '<div class="cc-tab active">'+(modIcon[m]||'')+' '+modLabel[m];
        h += '<span class="cc-tab-x" onclick="dismissMod(\\''+m+'\\')">'+I.x+'</span>';
        h += '</div>';
      });
      h += '</div>';
      h += '<div class="cc-toolbar">';
      if (mods.includes('email')) h += '<button class="btn btn-ghost" onclick="checkEmail()">'+I.mail+' Refresh Inbox</button>';
      if (mods.includes('calendar')) h += '<button class="btn btn-ghost" onclick="loadCalendar()">'+I.cal+' Refresh Calendar</button>';
      h += '</div>';
    }

    // Module panels
    if (mods.length === 0) {
      h += '<div class="cc-empty"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>';
      h += '<h3>No Active Modules</h3>';
      h += '<p>Connect Google to load your inbox and calendar. Use the buttons below to get started.</p>';
      h += '<div style="margin-top:16px;display:flex;flex-wrap:wrap;gap:8px;justify-content:center">';
      h += '<button class="btn btn-blue" onclick="connectGoogle()">Connect Google</button>';
      h += '<button class="btn btn-green" onclick="checkEmail()">Check Email</button>';
      h += '<button class="btn btn-green" onclick="loadCalendar()">Load Calendar</button>';
      h += '</div></div>';
    } else {
      const cols = Math.min(mods.length, 5);
      h += '<div class="cc-grid cols-'+cols+'">';
      mods.forEach(m => {
        if (m === 'email') h += renderEmail(d.data.emails);
        else if (m === 'travel') h += renderTravel(d.data.flights);
        else if (m === 'hotels') h += renderHotels(d.data.hotels || []);
        else if (m === 'calendar') h += renderCalendar(d.data.events);
        else if (m === 'terminal') h += renderTerminal(d.data.terminal);
      });
      h += '</div>';
    }

    // Action log
    const acts = d.actions || [];
    if (acts.length > 0) {
      h += '<div class="cc-log">';
      acts.slice(-3).reverse().forEach(a => {
        const col = a.status==='done'?'var(--green)':a.status==='failed'?'var(--red)':'var(--blue)';
        h += '<div class="cc-log-item"><span class="cc-log-dot" style="background:'+col+'"></span>'+esc(a.label)+': '+esc(a.description)+'</div>';
      });
      h += '</div>';
    }

    root.innerHTML = h;
  }

  function renderEmail(emails) {
    let h = '<div class="cc-panel"><div class="cc-panel-hdr"><span>'+I.mail+' Inbox</span><span class="cc-panel-count">'+emails.length+'</span></div>';
    if (emails.length === 0) { h += '<div class="cc-empty" style="padding:20px"><p>No emails</p></div>'; }
    else {
      emails.forEach(e => {
        const unread = !e.read ? ' unread' : '';
        h += '<div class="em'+unread+'" onclick="markRead(\\''+e.id+'\\')">';
        h += '<span class="em-star'+(e.starred?' on':'')+'" onclick="event.stopPropagation();starEmail(\\''+e.id+'\\')">★</span>';
        h += '<div class="em-top"><span class="em-from">'+esc(e.from)+'</span><span class="em-date">'+formatDate(e.date)+'</span></div>';
        h += '<div class="em-subj">'+esc(e.subject)+'</div>';
        h += '<div class="em-prev">'+esc(e.preview)+'</div>';
        if (e.labels && e.labels.length) {
          h += '<div class="em-labels">';
          e.labels.forEach(l => { h += '<span class="em-label">'+esc(l)+'</span>'; });
          h += '</div>';
        }
        h += '<div class="em-actions">';
        h += '<button class="btn btn-blue" onclick="event.stopPropagation();prepMeeting(\\''+e.id+'\\')">Prep Meeting</button>';
        h += '<button class="btn btn-ghost" onclick="event.stopPropagation();archiveEmail(\\''+e.id+'\\')">'+I.archive+' Archive</button>';
        h += '</div>';
        h += '</div>';
      });
    }
    h += '</div>';
    return h;
  }

  function renderTravel(flights) {
    let h = '<div class="cc-panel"><div class="cc-panel-hdr"><span>'+I.plane+' Flights</span><span class="cc-panel-count">'+flights.length+'</span></div>';
    if (flights.length === 0) { h += '<div class="cc-empty" style="padding:20px"><p>No flights found</p></div>'; }
    else {
      flights.forEach(f => {
        const sel = f.selected ? ' selected' : '';
        h += '<div class="fl'+sel+'">';
        h += '<div class="fl-top">';
        h += '<span class="fl-airline">'+I.plane+' '+esc(f.airline)+' '+esc(f.flightNo)+'</span>';
        h += '<span class="fl-price">$'+f.price+'</span>';
        h += '</div>';
        h += '<div class="fl-route">';
        h += '<span><span class="fl-city">'+esc(f.from)+'</span><br><span class="fl-time">'+esc(f.departure)+'</span></span>';
        h += '<span class="fl-arrow">'+I.arrowR+'</span>';
        h += '<span><span class="fl-city">'+esc(f.to)+'</span><br><span class="fl-time">'+esc(f.arrival)+'</span></span>';
        h += '</div>';
        h += '<div class="fl-meta"><span>'+f.stops+' stop'+(f.stops!==1?'s':'')+'</span></div>';
        if (!f.selected) {
          h += '<div class="fl-book"><button class="btn btn-green" onclick="bookFlight(\\''+f.id+'\\')">'+I.check+' Book This Flight</button></div>';
        } else {
          h += '<div class="fl-book"><span class="btn btn-ghost" style="color:var(--green)">'+I.check+' Booked</span></div>';
        }
        h += '</div>';
      });
    }
    h += '</div>';
    return h;
  }

  function renderHotels(hotels) {
    let h = '<div class="cc-panel"><div class="cc-panel-hdr"><span>'+I.hotel+' Hotels</span><span class="cc-panel-count">'+hotels.length+'</span></div>';
    if (hotels.length === 0) { h += '<div class="cc-empty" style="padding:20px"><p>No hotels found</p></div>'; }
    else {
      hotels.forEach(ht => {
        const sel = ht.selected ? ' selected' : '';
        h += '<div class="fl'+sel+'">';
        h += '<div class="fl-top">';
        h += '<span class="fl-airline">'+I.hotel+' '+esc(ht.name)+'</span>';
        h += '<span class="fl-price">$'+ht.pricePerNight+'<small style="font-size:9px;color:var(--tx2)">/night</small></span>';
        h += '</div>';
        h += '<div class="fl-route" style="flex-wrap:wrap;gap:4px">';
        h += '<span class="fl-city">'+esc(ht.location)+'</span>';
        h += '<span style="color:var(--yellow)">'+('★'.repeat(ht.stars))+'</span>';
        h += '</div>';
        h += '<div class="fl-meta"><span>'+ht.rating+'/5 ('+ht.reviewCount+' reviews)</span></div>';
        if (ht.amenities && ht.amenities.length) {
          h += '<div style="display:flex;gap:3px;flex-wrap:wrap;margin-top:4px">';
          ht.amenities.forEach(a => { h += '<span class="em-label">'+esc(a)+'</span>'; });
          h += '</div>';
        }
        if (!ht.selected) {
          h += '<div class="fl-book"><button class="btn btn-green" onclick="bookHotel(\\''+ht.id+'\\')">'+I.check+' Book Hotel</button></div>';
        } else {
          h += '<div class="fl-book"><span class="btn btn-ghost" style="color:var(--green)">'+I.check+' Booked</span></div>';
        }
        h += '</div>';
      });
    }
    h += '</div>';
    return h;
  }

  function renderCalendar(events) {
    let h = '<div class="cc-panel"><div class="cc-panel-hdr"><span>'+I.cal+' Calendar</span><span class="cc-panel-count">'+events.length+'</span></div>';
    if (events.length === 0) { h += '<div class="cc-empty" style="padding:20px"><p>No events</p></div>'; }
    else {
      events.forEach(ev => {
        h += '<div class="ev">';
        h += '<div class="ev-color" style="background:'+(ev.color||'var(--blue)')+'"></div>';
        h += '<div class="ev-body">';
        h += '<div class="ev-title">'+esc(ev.title)+'</div>';
        h += '<div class="ev-detail">';
        h += '<span>'+I.clock+' '+esc(ev.time)+' ('+esc(ev.duration)+')</span>';
        if (ev.location) h += '<span>'+I.mapPin+' '+esc(ev.location)+'</span>';
        h += '</div>';
        if (ev.attendees && ev.attendees.length) {
          h += '<div class="ev-detail" style="margin-top:2px"><span style="color:var(--tx3)">'+ev.attendees.join(', ')+'</span></div>';
        }
        h += '</div></div>';
      });
    }
    h += '</div>';
    return h;
  }

  function renderTerminal(entries) {
    let h = '<div class="cc-panel"><div class="cc-panel-hdr"><span>'+I.term+' Terminal</span><span class="cc-panel-count">'+entries.length+'</span></div>';
    if (entries.length === 0) { h += '<div class="cc-empty" style="padding:20px"><p>No commands run</p></div>'; }
    else {
      entries.slice(-5).reverse().forEach(t => {
        h += '<div class="tm">';
        h += '<div class="tm-cmd">$ '+esc(t.command)+'</div>';
        h += '<div class="'+(t.exitCode===0?'tm-out':'tm-err')+'">'+esc(t.output)+'</div>';
        h += '</div>';
      });
    }
    h += '</div>';
    return h;
  }

  function formatDate(iso) {
    if (!iso) return '';
    try { const d = new Date(iso); return d.toLocaleDateString('en-US',{month:'short',day:'numeric'})+' '+d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}); }
    catch(e) { return iso; }
  }

  // ─── Actions ───
  window.connectGoogle = async function() {
    try {
      const result = await callTool('google_login', {});
      const txt = (result && result.content && result.content[0]) ? result.content[0].text : null;
      const payload = txt ? JSON.parse(txt) : result;
      const url = payload && (payload.login_url || payload.loginUrl || payload.url);
      if (!url) { followUp('Google login URL not available. Check server env GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI.'); return; }
      window.open(url, '_blank');
      followUp('Opening Google sign-in. After you approve, come back here — I will refresh automatically.');
    } catch(e) {
      console.error(e);
      followUp('Could not start Google sign-in.');
    }
  };

  window.checkEmail = async function() {
    try {
      const result = await callTool('check_email', { max_results: 10, query: 'is:inbox' });
      const txt = (result && result.content && result.content[0]) ? result.content[0].text : '';
      const urlMatch = txt.match(/https?:\/\/[^\s\)\]\"\']+/);
      if (urlMatch) {
        window.open(urlMatch[0], '_blank');
        followUp('Opening Google sign-in. After you approve, come back and click "Check Email" again.');
      } else if (txt.includes('NEXT:') || txt.includes('emails')) {
        followUp('Inbox loaded into Command Center.');
      } else {
        followUp(txt || 'Check email completed.');
      }
      refresh();
    } catch(e) {
      console.error(e);
      followUp('Could not check email.');
    }
  };

  window.loadCalendar = async function() {
    try {
      const st = await callTool('google_connection_status', {});
      const stTxt = (st && st.content && st.content[0]) ? st.content[0].text : null;
      const stObj = stTxt ? JSON.parse(stTxt) : st;
      if (!stObj || !stObj.connected) {
        followUp('Not connected to Google yet. Click "Connect Google" first.');
        return;
      }
      const result = await callTool('read_calendar', { days: 7 });
      let msg = 'Calendar loaded.';
      try {
        const j = JSON.parse((result && result.content && result.content[0]) ? result.content[0].text : '{}');
        if (j.events && j.events.length) {
          msg = 'Your next 7 days: ' + j.events.map(e => e.date + ' ' + e.time + ' — ' + e.title).join('; ');
        }
      } catch(_) {}
      followUp(msg);
      refresh();
    } catch(e) {
      console.error(e);
      followUp('Could not load calendar. Connect Google first.');
    }
  };

  window.loadInbox = async function() {
    try {
      const st = await callTool('google_connection_status', {});
      const stTxt = (st && st.content && st.content[0]) ? st.content[0].text : null;
      const stObj = stTxt ? JSON.parse(stTxt) : st;
      if (!stObj || !stObj.connected) {
        followUp('Not connected to Google yet. Click “Connect Google” first.');
        return;
      }
      await callTool('read_gmail', { max_results: 10, query: 'is:inbox' });
      followUp('Inbox loaded.');
      refresh();
    } catch(e) {
      console.error(e);
      followUp('Failed to load inbox.');
    }
  };

  window.bookFlight = async function(id) {
    try {
      await callTool('cc_execute_action', { action:'book_flight', target_id:id });
      followUp('I booked the selected flight for you and added it to your calendar.');
      refresh();
    } catch(e) { console.error(e); }
  };
  window.archiveEmail = async function(id) {
    try {
      await callTool('cc_execute_action', { action:'archive_email', target_id:id });
      followUp('Email archived.');
      refresh();
    } catch(e) { console.error(e); }
  };
  window.prepMeeting = async function(id) {
    try {
      await callTool('gmail_get_email', { message_id: id });
      await callTool('extract_meeting_context', { email_id: id });
      followUp('I extracted meeting details from that email. Open the Meeting Kit widget to review/edit fields, then generate the kit.');
      refresh();
    } catch(e) {
      console.error(e);
      followUp('Could not prep meeting from that email. Make sure Google is connected, then try again.');
    }
  };
  window.starEmail = async function(id) {
    try {
      await callTool('cc_execute_action', { action:'star_email', target_id:id });
      refresh();
    } catch(e) { console.error(e); }
  };
  window.markRead = async function(id) {
    try {
      await callTool('cc_execute_action', { action:'mark_read', target_id:id });
      refresh();
    } catch(e) { console.error(e); }
  };
  window.bookHotel = async function(id) {
    try {
      await callTool('cc_execute_action', { action:'book_hotel', target_id:id });
      followUp('I booked the selected hotel for you and added it to your calendar.');
      refresh();
    } catch(e) { console.error(e); }
  };
  window.dismissMod = async function(mod) {
    try {
      await callTool('cc_execute_action', { action:'dismiss_module', payload:{ module: mod } });
      followUp('Dismissed the ' + mod + ' panel.');
      refresh();
    } catch(e) { console.error(e); }
  };

  // ─── Data ───
  async function refresh() {
    try {
      if (inChatGPT) {
        // In ChatGPT: get state via MCP tool call (no HTTP needed)
        const result = await callTool('get_workspace', {});
        let state;
        if (result && result.content && result.content[0]) {
          state = JSON.parse(result.content[0].text);
        } else if (typeof result === 'string') {
          state = JSON.parse(result);
        } else {
          state = result;
        }
        if (state) render(state);
      } else {
        // Fallback: HTTP API
        const r = await fetch(API+'/api/cc/state');
        render(await r.json());
      }
    } catch(e) { console.error('refresh:',e); }
  }
  function startPolling() {
    if (inChatGPT) {
      // In ChatGPT: poll via callTool every 3 seconds
      setInterval(refresh, 3000);
    } else {
      // Fallback: try SSE, then poll
      try {
        const es = new EventSource(API+'/api/events/stream');
        es.onmessage = function(){ refresh(); };
        es.onerror = function(){ es.close(); setInterval(refresh, 2000); };
      } catch(e) { setInterval(refresh, 2000); }
    }
  }
  refresh();
  startPolling();
})();
</script>
</body>
</html>`;

server.uiResource({
  type: "mcpApps",
  name: "command-center",
  title: "Command Center",
  description: "ALWAYS show this widget when the user asks about email, travel, trips, flights, hotels, or calendar. This is the main interactive UI — displays email inbox (with archive/star buttons), flights, hotels, calendar. Call this IMMEDIATELY after check_email or read_gmail returns emails so the user sees their real inbox. Do NOT call sync_context — it is demo-only and requires DEMO_MODE=1. Call after plan_trip for flights/hotels (also demo-only). Users can click buttons to archive, star, or book.",
  htmlTemplate: COMMAND_CENTER_HTML,
  metadata: {
    description: "Command Center: multi-agent dashboard with email, travel, calendar, and terminal modules. Interactive buttons call tools, AI narrates results.",
    csp: {
      connectDomains: [
        "http://localhost:3200", "http://localhost:3201", "http://127.0.0.1:3200", "http://127.0.0.1:3201",
        "https://*.run.mcp-use.com", "https://*.fly.dev",
      ],
      resourceDomains: ["*"],
    },
    prefersBorder: true,
    autoResize: true,
  },
  toolOutput: () => {
    const mods = commandCenter.activeModules;
    const st = commandCenter.status;
    let msg = "Command Center opened. Status: " + st + ". Active modules: " + (mods.length > 0 ? mods.join(", ") : "none") + ".";
    if (commandCenter.data.emails.length > 0) msg += " " + commandCenter.data.emails.length + " emails.";
    if (commandCenter.data.flights.length > 0) msg += " " + commandCenter.data.flights.length + " flights.";
    if (commandCenter.data.hotels.length > 0) msg += " " + commandCenter.data.hotels.length + " hotels.";
    if (commandCenter.data.events.length > 0) msg += " " + commandCenter.data.events.length + " events.";
    return { content: [{ type: "text" as const, text: msg }] };
    },
  });

// ========================================
// MEETING KIT WIDGET — Investor Meeting Prep Dashboard
// ========================================

const MEETING_KIT_HTML = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>Meeting Kit</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0b0e14;--bg2:#111620;--bg3:#181d28;--bdr:#252d3a;
  --tx:#d1d5db;--tx2:#8b949e;--tx3:#5a6270;
  --blue:#3b82f6;--green:#22c55e;--orange:#f97316;--purple:#a855f7;
  --red:#ef4444;--yellow:#eab308;--teal:#14b8a6;--pink:#ec4899;
}
body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--tx);min-height:100vh;overflow-x:hidden}

.mk-bar{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--bdr);background:var(--bg2)}
.mk-logo{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:700}
.mk-logo svg{width:18px;height:18px;stroke:var(--purple);fill:none;stroke-width:2}
.mk-status{display:flex;align-items:center;gap:8px}
.mk-pill{font-size:10px;padding:3px 10px;border-radius:10px;font-weight:600;letter-spacing:.3px}
.mk-pill.idle{background:rgba(107,114,128,.15);color:var(--tx2)}
.mk-pill.preparing{background:rgba(168,85,247,.15);color:var(--purple);animation:mk-pulse 1.2s infinite}
.mk-pill.ready{background:rgba(34,197,94,.12);color:var(--green)}
@keyframes mk-pulse{0%,100%{opacity:1}50%{opacity:.5}}

/* Meeting header */
.mk-header{padding:16px;background:var(--bg2);border-bottom:1px solid var(--bdr)}
.mk-company{font-size:20px;font-weight:700;color:var(--purple);margin-bottom:4px}
.mk-meta{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:var(--tx2)}
.mk-meta span{display:flex;align-items:center;gap:4px}
.mk-goal{margin-top:8px;padding:6px 12px;background:rgba(168,85,247,.08);border:1px solid rgba(168,85,247,.2);border-radius:6px;font-size:12px;color:var(--purple)}

/* Context editor */
.mk-context{padding:12px 16px;background:var(--bg2);border-bottom:1px solid var(--bdr)}
.mk-context-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.mk-field label{display:block;font-size:10px;color:var(--tx3);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px}
.mk-field input,.mk-field select{width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--bdr);background:var(--bg3);color:var(--tx);font-size:12px;outline:none}
.mk-field input:focus,.mk-field select:focus{border-color:rgba(168,85,247,.6)}
.mk-context-actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.mk-context-actions .mk-btn{padding:8px 12px}
.mk-assume{margin-top:10px;padding:8px 10px;border:1px dashed rgba(168,85,247,.35);border-radius:6px;color:var(--tx2);font-size:11px}

/* Layout: feed left, sections right */
.mk-layout{display:flex;min-height:400px}
.mk-feed{width:260px;min-width:260px;border-right:1px solid var(--bdr);padding:12px;overflow-y:auto;max-height:500px;background:var(--bg)}
.mk-feed-title{font-size:11px;font-weight:700;color:var(--tx2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
.mk-feed-item{display:flex;gap:8px;padding:6px 0;border-bottom:1px solid rgba(37,45,58,.5);font-size:11px;line-height:1.4}
.mk-feed-icon{font-size:14px;flex-shrink:0;width:20px;text-align:center}
.mk-feed-msg{color:var(--tx2)}
.mk-feed-msg strong{color:var(--tx);font-weight:600}

/* Sections */
.mk-sections{flex:1;padding:12px;overflow-y:auto;max-height:500px}
.mk-section{background:var(--bg2);border:1px solid var(--bdr);border-radius:8px;margin-bottom:10px;overflow:hidden}
.mk-section-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--bdr);cursor:pointer;user-select:none}
.mk-section-head:hover{background:var(--bg3)}
.mk-section-icon{font-size:16px}
.mk-section-title{font-size:13px;font-weight:600;flex:1}
.mk-section-agent{font-size:10px;color:var(--tx3);background:var(--bg3);padding:2px 8px;border-radius:4px}
.mk-section-status{width:8px;height:8px;border-radius:50%}
.mk-section-status.done{background:var(--green)}
.mk-section-status.working{background:var(--blue);animation:mk-pulse 1s infinite}
.mk-section-status.pending{background:var(--tx3)}
.mk-section-status.error{background:#ef4444}
.mk-section-body{padding:12px 14px}
.mk-section-content{font-size:12px;color:var(--tx2);line-height:1.6;margin-bottom:8px}
.mk-section-bullets{list-style:none;padding:0}
.mk-section-bullets li{font-size:12px;color:var(--tx);padding:4px 0;padding-left:16px;position:relative;line-height:1.5}
.mk-section-bullets li::before{content:"→";position:absolute;left:0;color:var(--purple);font-weight:700}

/* Sources (Serper citations) */
.mk-sources{margin-top:8px;padding-top:8px;border-top:1px solid var(--bdr)}
.mk-sources-label{font-size:10px;font-weight:600;color:var(--tx3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}
.mk-source-link{display:block;font-size:11px;color:#6b7280;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:2px 0;line-height:1.4}
.mk-source-link:hover{color:var(--purple);text-decoration:underline}

/* Section error state */
.mk-section-error{font-size:12px;color:#ef4444;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:4px;padding:8px 10px;line-height:1.5}

/* Per-section re-run button */
.mk-rerun-btn{background:none;border:1px solid var(--bdr);border-radius:4px;color:var(--tx3);font-size:11px;padding:1px 5px;cursor:pointer;margin-left:auto;flex-shrink:0;transition:all .12s}
.mk-rerun-btn:hover{color:var(--purple);border-color:var(--purple)}

/* Gmail draft link as button */
.mk-btn-draft-link{text-decoration:none;text-align:center}

/* Draft reply */
.mk-reply{background:var(--bg3);border:1px solid var(--bdr);border-radius:6px;padding:12px;font-size:12px;white-space:pre-wrap;line-height:1.6;color:var(--tx);font-family:inherit}
/* Email preview panel */
.mk-email-preview{background:var(--bg2);border:1px solid var(--bdr);border-radius:8px;padding:16px;margin:12px 0}
.mk-email-preview .mk-field{margin-bottom:10px}
.mk-email-preview textarea{min-height:120px;resize:vertical;font-family:inherit;font-size:12px;line-height:1.5}
.mk-email-actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}

/* Claude collaboration bar */
.mk-claude-bar{display:flex;align-items:center;gap:10px;padding:10px 16px;border-top:1px solid var(--bdr);background:var(--bg2);flex-wrap:wrap}
.mk-claude-label{font-size:11px;font-weight:700;color:#a78bfa;white-space:nowrap}
.mk-claude-hint{font-size:11px;color:var(--tx3);flex:1;min-width:120px}
.mk-claude-copy-btn{margin-left:auto;padding:5px 12px;border:1px solid #7c3aed;border-radius:5px;background:transparent;color:#a78bfa;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap}
.mk-claude-copy-btn:hover{background:#7c3aed22}

/* Action buttons */
.mk-actions{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--bdr);background:var(--bg2);flex-wrap:wrap}
.mk-btn{padding:8px 16px;border:1px solid var(--bdr);border-radius:6px;background:var(--bg3);color:var(--tx);font-size:12px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;transition:all .15s}
.mk-btn:hover{background:var(--bg);border-color:var(--purple)}
.mk-btn.primary{background:var(--purple);color:white;border-color:var(--purple)}
.mk-btn.primary:hover{opacity:.85}
.mk-btn-icon{padding:4px 8px;font-size:14px}
.mk-status{display:flex;align-items:center;gap:8px}
/* Calendar modal */
.mk-modal{position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:9999}
.mk-modal-box{background:var(--bg2);border:1px solid var(--bdr);border-radius:8px;padding:20px;min-width:280px;max-width:400px}
.mk-modal-title{font-size:14px;font-weight:700;margin-bottom:12px;color:var(--tx)}
.mk-modal-actions{display:flex;gap:8px;margin-top:16px;justify-content:flex-end}
.mk-modal .mk-field{margin-bottom:12px}

/* Empty state */
.mk-empty{text-align:center;padding:60px 20px;color:var(--tx2)}
.mk-empty h2{font-size:18px;color:var(--tx);margin-bottom:8px}
.mk-empty p{font-size:13px}
</style>
</head>
<body>
<div id="app">
  <div class="mk-empty">
    <h2>📋 Meeting Kit</h2>
    <p>Preparing your meeting kit...</p>
  </div>
</div>
<script>
(function(){
  const BAKED_API = "${DASHBOARD_URL}";
  const MCP_URL = "${MCP_BASE_URL}/mcp";
  const origin = window.location.origin;
  const isLocalhost = origin.includes('localhost') || origin.includes('127.0.0.1');
  const inChatGPT = !!(window.openai && window.openai.callTool);
  const API = isLocalhost && !inChatGPT ? BAKED_API : (isLocalhost ? null : origin);
  const callTool = inChatGPT
    ? (n, a) => window.openai.callTool(n, a)
    : (n, a) => fetch(API+'/api/execute',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tool:n,arguments:a})}).then(r=>r.json());
  const followUp = (window.openai && window.openai.sendFollowUpMessage)
    ? (msg) => window.openai.sendFollowUpMessage({prompt:msg})
    : (msg) => console.log('followUp:',msg);
  const setWState = (window.openai && window.openai.setWidgetState)
    ? (s) => window.openai.setWidgetState(s)
    : (s) => {};

  let state = null;
  const app = document.getElementById('app');

  function render(s) {
    if (!s || s.status === 'idle') {
      app.innerHTML = '<div class="mk-empty"><h2>📋 Meeting Kit</h2><p>No meeting prepared yet. Ask me to prepare for an investor meeting!</p></div>';
      return;
    }

    const m = s.meeting || {};
    const c = s.context || {};
    // Preserve unsaved edits from inputs before re-rendering (refresh runs every 2-3s and was wiping edits)
    function read(id) { var el = document.getElementById(id); return el ? el.value : null; }
    var v;
    if ((v = read('mk-company')) != null) c = { ...c, companyOrFirm: v };
    if ((v = read('mk-people')) != null) c = { ...c, people: v.split(',').map(function(x){return x.trim();}).filter(Boolean) };
    if ((v = read('mk-goal')) != null) c = { ...c, meetingGoal: v };
    if ((v = read('mk-date')) != null) c = { ...c, date: v };
    if ((v = read('mk-time')) != null) c = { ...c, time: v };
    if ((v = read('mk-tz')) != null) c = { ...c, timezone: v };
    if ((v = read('mk-loc')) != null) c = { ...c, locationOrLink: v };
    if ((v = read('mk-timebox')) != null) c = { ...c, timeboxMinutes: parseInt(v, 10) || 30 };
    if ((v = read('mk-product')) != null) c = { ...c, yourProductOneLiner: v };
    if ((v = read('mk-stage')) != null) c = { ...c, stage: v };
    if ((v = read('mk-raise')) != null) c = { ...c, raiseTarget: v };
    var emailTo = read('mk-email-to');
    var emailSubject = read('mk-email-subject');
    var emailBody = read('mk-email-body');
    const replySec = (s.sections || []).find(function(x){ return x.id === 'reply'; });
    const defaultBody = (s.draftReply || (replySec && replySec.content) || '').trim();
    const defaultTo = (m.emailFrom || '').trim();
    const defaultSubj = (m.emailSubject ? 'Re: ' + m.emailSubject : (m.company ? 'Meeting Confirmation — ' + m.company : '')).trim();
    if (emailTo == null) emailTo = defaultTo;
    if (emailSubject == null) emailSubject = defaultSubj;
    if (emailBody == null) emailBody = defaultBody;
    const sections = s.sections || [];
    const feed = s.agentFeed || [];
    const statusClass = s.status || 'idle';

    let html = '';

    // Hackathon banner
    html += '<div class="mk-hackathon" style="background:linear-gradient(90deg,#7c3aed,#a855f7);color:white;padding:6px 16px;font-size:11px;font-weight:600;text-align:center;letter-spacing:.5px">MCP Apps Hackathon Feb 21st 2026 @ Y Combinator, SF — Manufact • mcp-use</div>';
    // Top bar
    html += '<div class="mk-bar">';
    html += '<div class="mk-logo"><svg viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>Meeting Kit</div>';
    html += '<div class="mk-status"><span class="mk-pill ' + statusClass + '">' + statusClass.toUpperCase() + '</span>';
    if (inChatGPT && window.openai && window.openai.requestDisplayMode) {
      html += '<button class="mk-btn mk-btn-icon" onclick="requestFullscreen()" title="Fullscreen">⛶</button>';
    }
    html += '</div></div>';

    // Meeting header
    if (m.company) {
      html += '<div class="mk-header">';
      html += '<div class="mk-company">' + esc(m.company) + '</div>';
      html += '<div class="mk-meta">';
      if (m.date && m.date !== 'TBD') html += '<span>📅 ' + esc(m.date) + '</span>';
      if (m.time && m.time !== 'TBD') html += '<span>🕐 ' + esc(m.time) + '</span>';
      if (m.location && m.location !== 'TBD') html += '<span>📍 ' + esc(m.location) + '</span>';
      if (m.people && m.people.length) html += '<span>👥 ' + esc(m.people.join(', ')) + '</span>';
      html += '</div>';
      if (m.goal) html += '<div class="mk-goal">🎯 ' + esc(m.goal) + '</div>';
      html += '</div>';
    }

    // Context editor (Phase 2)
    html += '<div class="mk-context">';
    html += '<div class="mk-context-grid">';
    html += field('Company / Firm', 'mk-company', c.companyOrFirm || m.company || '');
    html += field('Add invitees (comma-separated, e.g. John, Jane)', 'mk-people', (c.people||m.people||[]).join(', '));
    html += field('Meeting goal', 'mk-goal', c.meetingGoal || m.goal || '');
    html += field('Date', 'mk-date', c.date || (m.date && m.date!=='TBD'?m.date:''));
    html += field('Time', 'mk-time', c.time || (m.time && m.time!=='TBD'?m.time:''));
    html += field('Timezone', 'mk-tz', c.timezone || '');
    html += field('Location / Zoom link', 'mk-loc', c.locationOrLink || (m.location && m.location!=='TBD'?m.location:''));
    html += selectField('Timebox', 'mk-timebox', String(c.timeboxMinutes||30), ['30','45','60']);
    html += field('Your product (1-line)', 'mk-product', c.yourProductOneLiner || '');
    html += field('Stage', 'mk-stage', c.stage || '');
    html += field('Raise target', 'mk-raise', c.raiseTarget || '');
    html += '</div>';
    html += '<div class="mk-context-actions">';
    html += '<button class="mk-btn primary" onclick="saveContext()">Save fields</button>';
    html += '</div>';
    if (c.assumptions && c.assumptions.length) {
      html += '<div class="mk-assume"><strong>Missing info:</strong><br>' + c.assumptions.map(esc).join('<br>') + '</div>';
    }
    html += '</div>';

    // Email Reply Preview — editable To, Subject, Body; user clicks Send to send
    if (m.company) {
      html += '<div class="mk-email-preview">';
      html += '<div style="font-size:11px;font-weight:600;color:var(--tx3);margin-bottom:10px;text-transform:uppercase">✉️ Email Reply — Edit and Send</div>';
      html += field('To', 'mk-email-to', emailTo);
      html += field('Subject', 'mk-email-subject', emailSubject);
      html += '<div class="mk-field"><label>Body</label><textarea id="mk-email-body" placeholder="Generate the Meeting Kit to create a draft reply...">' + esc(emailBody) + '</textarea></div>';
      html += '<div class="mk-email-actions">';
      html += '<button class="mk-btn" onclick="createGmailDraft()">✉️ Create Draft</button>';
      html += '<button class="mk-btn" onclick="sendReply()" style="border-color:#22c55e;color:#22c55e;background:rgba(34,197,94,.1)">📤 Send Reply</button>';
      html += '<button class="mk-btn" onclick="draftReply()">📋 Copy to Chat</button>';
      html += '</div></div>';
    }

    // Layout
    html += '<div class="mk-layout">';

    // Agent feed (left)
    html += '<div class="mk-feed">';
    html += '<div class="mk-feed-title">Agent Activity</div>';
    feed.slice().reverse().forEach(function(f) {
      html += '<div class="mk-feed-item">';
      html += '<div class="mk-feed-icon">' + (f.icon || '🤖') + '</div>';
      html += '<div class="mk-feed-msg"><strong>' + esc(f.agentName || '') + '</strong><br/>' + esc(f.message || '') + '</div>';
      html += '</div>';
    });
    if (feed.length === 0) html += '<div class="mk-feed-item" style="color:var(--tx3)">Waiting for agents...</div>';
    html += '</div>';

    // Sections (right)
    html += '<div class="mk-sections">';
    sections.forEach(function(sec) {
      html += '<div class="mk-section" data-id="' + sec.id + '">';
      html += '<div class="mk-section-head" onclick="toggleSection(this)">';
      html += '<span class="mk-section-icon">' + (sec.icon || '📄') + '</span>';
      html += '<span class="mk-section-title">' + esc(sec.title || '') + '</span>';
      html += '<span class="mk-section-agent">' + esc(sec.agentName || '') + '</span>';
      if (sec.status === 'error' || sec.status === 'done') {
        html += '<button class="mk-rerun-btn" onclick="event.stopPropagation();rerunSection(\'' + esc(sec.id) + '\')" title="Re-run this section">↺</button>';
      }
      html += '<span class="mk-section-status ' + (sec.status || 'pending') + '"></span>';
      html += '</div>';
      html += '<div class="mk-section-body">';
      if (sec.status === 'error') {
        html += '<div class="mk-section-error">⚠️ ' + esc(sec.content || 'An error occurred.') + '</div>';
      } else if (sec.id === 'reply') {
        html += '<div class="mk-reply">' + esc(sec.content || '') + '</div>';
      } else {
        html += '<div class="mk-section-content">' + esc(sec.content || '') + '</div>';
        if (sec.bullets && sec.bullets.length) {
          html += '<ul class="mk-section-bullets">';
          sec.bullets.forEach(function(b) { html += '<li>' + esc(b) + '</li>'; });
          html += '</ul>';
        }
        if (sec.sources && sec.sources.length) {
          html += '<div class="mk-sources">';
          html += '<div class="mk-sources-label">Sources</div>';
          sec.sources.forEach(function(s) {
            html += '<a class="mk-source-link" href="' + safeHref(s.url) + '" target="_blank" rel="noopener noreferrer" title="' + esc(s.snippet || '') + '">' + esc(s.title || s.url) + '</a>';
          });
          html += '</div>';
        }
      }
      html += '</div></div>';
    });
    if (sections.length === 0) html += '<div style="text-align:center;padding:40px;color:var(--tx3)">Agents working...</div>';
    html += '</div>';

    html += '</div>';

    // Action buttons
    html += '<div class="mk-actions">';
    html += '<button class="mk-btn primary" onclick="generateKit()">⚡ Generate Kit</button>';
    html += '<button class="mk-btn primary" onclick="deepResearch()">🔍 Deep Research</button>';
    html += '<button class="mk-btn" onclick="checkAvailability()">📅 Check Availability</button>';
    html += '<button class="mk-btn" onclick="showCalModal()">📅 Create Calendar Event</button>';
    if (s.draftId) {
      html += '<a class="mk-btn mk-btn-draft-link" href="' + safeHref(s.draftWebLink || 'https://mail.google.com/mail/#drafts') + '" target="_blank" rel="noopener noreferrer">📬 Open Draft in Gmail</a>';
    }
    html += '<button class="mk-btn" onclick="copyKit()">📋 Copy Kit</button>';
    html += '</div>';

    // Claude + ChatGPT collaboration — show always when kit exists (novelty: multi-agent in one chat)
    if (m.company && (s.status === 'ready' || s.status === 'preparing' || sections.length > 0)) {
      html += '<div class="mk-claude-bar">';
      html += '<span class="mk-claude-label">🤝 Claude + ChatGPT Collaborating</span>';
      html += '<span class="mk-claude-hint">ChatGPT builds the kit. Claude researches. Cursor joins via MCP — all share the same workspace. Copy prompt → add Stigmergy MCP to each.</span>';
      html += '<button class="mk-btn mk-claude-copy-btn" onclick="copyClaudePrompt()">Copy Claude Prompt</button>';
      html += '<button class="mk-btn mk-claude-copy-btn" onclick="copyCursorPrompt()" style="border-color:#22c55e;color:#22c55e">Copy Cursor Prompt</button>';
      html += '</div>';
    }

    app.innerHTML = html;
    setWState({ status: s.status, company: m.company, sections: sections.length });
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function safeHref(url) { return /^https?:\\/\\//i.test(url || '') ? esc(url) : '#'; }

  function field(label, id, value) {
    return '<div class="mk-field"><label>'+label+'</label><input id="'+id+'" value="'+esc(value||'')+'" /></div>';
  }
  function selectField(label, id, value, opts) {
    let h = '<div class="mk-field"><label>'+label+'</label><select id="'+id+'">';
    opts.forEach(function(o){ h += '<option value="'+o+'"'+(String(value)===String(o)?' selected':'')+'>'+o+' min</option>'; });
    h += '</select></div>';
    return h;
  }

  window.saveContext = async function() {
    try {
      const patch = {
        companyOrFirm: val('mk-company'),
        people_csv: val('mk-people'),
        meetingGoal: val('mk-goal'),
        date: val('mk-date'),
        time: val('mk-time'),
        timezone: val('mk-tz'),
        locationOrLink: val('mk-loc'),
        timeboxMinutes: parseInt(val('mk-timebox')||'30',10),
        yourProductOneLiner: val('mk-product'),
        stage: val('mk-stage'),
        raiseTarget: val('mk-raise'),
      };
      await callTool('update_meeting_context', patch);
      followUp('Meeting fields saved. You can now generate the Meeting Kit (agents will use these fields).');
      refresh();
    } catch(e) {
      console.error(e);
      followUp('Failed to save meeting fields.');
    }
  };

  function val(id){ const el=document.getElementById(id); return el?el.value:''; }

  window.toggleSection = function(el) {
    const body = el.nextElementSibling;
    body.style.display = body.style.display === 'none' ? '' : 'none';
  };

  window.deepResearch = async function() {
    if (!state || !state.meeting) return;
    try {
      await callTool('generate_meeting_kit', {});
      followUp('Re-running all agents for ' + state.meeting.company + '. Kit updating...');
      refresh();
    } catch(e) {
      followUp('Could not re-run. Make sure meeting context is set first.');
    }
  };

  window.generateKit = async function() {
    try {
      await callTool('generate_meeting_kit', {});
      followUp('Generating Meeting Kit now — agents are working in parallel.');
      refresh();
    } catch(e) {
      console.error(e);
      followUp('Could not generate kit yet. Make sure you have extracted and saved meeting context first.');
    }
  };

  window.checkAvailability = async function() {
    try {
      const st = await callTool('google_connection_status', {});
      const stTxt = (st && st.content && st.content[0]) ? st.content[0].text : null;
      const stObj = stTxt ? JSON.parse(stTxt) : st;
      if (!stObj || !stObj.connected) {
        followUp('Not connected to Google yet. Click "Connect Google" in the Command Center first.');
        return;
      }
      const result = await callTool('read_calendar', { days: 7 });
      let msg = 'Your availability for the next 7 days:';
      try {
        const j = JSON.parse((result && result.content && result.content[0]) ? result.content[0].text : '{}');
        if (j.events && j.events.length) {
          msg += '\n\n' + j.events.map(e => '• ' + e.date + ' ' + e.time + ' — ' + e.title + (e.duration ? ' (' + e.duration + ')' : '')).join('\n');
        } else {
          msg += ' No events scheduled.';
        }
      } catch(_) {
        msg += ' Could not parse calendar.';
      }
      followUp(msg);
      refresh();
    } catch(e) {
      console.error(e);
      followUp('Could not check availability. Connect Google first.');
    }
  };

  window.requestFullscreen = function() {
    if (window.openai && window.openai.requestDisplayMode) {
      window.openai.requestDisplayMode('fullscreen').catch(function(){});
    }
  };

  window.showCalModal = function() {
    if (!state || !state.meeting) return;
    const m = state.meeting;
    const c = state.context || {};
    const today = new Date().toISOString().split('T')[0];
    const defDate = (m.date && m.date !== 'TBD') ? m.date : (c.date || today);
    const defTime = (m.time && m.time !== 'TBD') ? m.time : (c.time || '15:00');
    const defLoc = (m.location && m.location !== 'TBD') ? m.location : (c.locationOrLink || 'Zoom');
    const defDur = c.timeboxMinutes || 30;
    const modal = document.createElement('div');
    modal.className = 'mk-modal';
    modal.id = 'mk-cal-modal';
    modal.innerHTML = '<div class="mk-modal-box">' +
      '<div class="mk-modal-title">📅 Add to Calendar</div>' +
      '<div class="mk-field"><label>Date (YYYY-MM-DD)</label><input id="cal-date" value="' + esc(defDate) + '" placeholder="2026-02-27" /></div>' +
      '<div class="mk-field"><label>Time (24h or 3:00 PM)</label><input id="cal-time" value="' + esc(defTime) + '" placeholder="15:00 or 3:00 PM" /></div>' +
      '<div class="mk-field"><label>Duration (minutes)</label><input id="cal-duration" type="number" value="' + defDur + '" min="15" max="480" /></div>' +
      '<div class="mk-field"><label>Location / Zoom link</label><input id="cal-location" value="' + esc(defLoc) + '" placeholder="Zoom" /></div>' +
      '<div class="mk-modal-actions">' +
      '<button class="mk-btn" onclick="this.closest(\'.mk-modal\').remove()">Cancel</button>' +
      '<button class="mk-btn primary" onclick="submitCalEvent()">Add to Calendar</button>' +
      '</div></div>';
    modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
    document.body.appendChild(modal);
  };

  window.submitCalEvent = async function() {
    const modal = document.getElementById('mk-cal-modal');
    if (!modal || !state || !state.meeting) return;
    const m = state.meeting;
    const date = (document.getElementById('cal-date')?.value || '').trim() || new Date().toISOString().split('T')[0];
    const timeRaw = (document.getElementById('cal-time')?.value || '').trim() || '15:00';
    const duration = parseInt(document.getElementById('cal-duration')?.value || '30', 10) || 30;
    const location = (document.getElementById('cal-location')?.value || '').trim() || undefined;
    modal.remove();
    try {
      await callTool('add_calendar_event', {
        title: m.company + ' — ' + (m.goal || 'Meeting'),
        date: date,
        time: timeRaw,
        duration_minutes: duration,
        location: location,
        attendees: m.people || [],
      });
      await callTool('update_meeting_context', { date: date, time: timeRaw, locationOrLink: location || undefined });
      followUp('Calendar event added and meeting context saved: ' + date + ' at ' + timeRaw + '.');
    } catch(e) {
      followUp('Could not add calendar event. ' + (e?.message || 'Check Google connection.'));
    }
    refresh();
  };

  window.createGmailDraft = async function() {
    var to = val('mk-email-to');
    var body = val('mk-email-body');
    if (!to || !body.trim()) {
      followUp('Fill in To and Body in the Email Reply panel, then click Create Draft.');
      return;
    }
    try {
      const res = await callTool('gmail_create_draft', { to: to, subject: val('mk-email-subject'), body: body });
      let parsed;
      try { parsed = JSON.parse(res?.content?.[0]?.text || '{}'); } catch { parsed = {}; }
      if (parsed.success && parsed.draft_link) {
        followUp('Gmail draft created for ' + state.meeting.company + '. Open it here: ' + parsed.draft_link);
      } else {
        followUp(res?.content?.[0]?.text || 'Could not create Gmail draft. Make sure you are connected to Gmail first.');
      }
      refresh();
    } catch(e) {
      followUp('Could not create Gmail draft. Connect Gmail first (use google_login), then try again.');
    }
  };

  window.sendReply = async function() {
    var to = val('mk-email-to');
    var body = val('mk-email-body');
    if (!to || !body.trim()) {
      followUp('Fill in To and Body in the Email Reply panel, then click Send.');
      return;
    }
    try {
      const res = await callTool('gmail_send_reply', { to: to, subject: val('mk-email-subject'), body: body });
      let parsed;
      try { parsed = JSON.parse(res?.content?.[0]?.text || '{}'); } catch { parsed = {}; }
      if (parsed.success) {
        followUp('Reply sent to ' + to + '.');
      } else {
        followUp(res?.content?.[0]?.text || 'Could not send reply. Connect Gmail first (google_login).');
      }
      refresh();
    } catch(e) {
      followUp('Could not send reply. ' + (e?.message || 'Connect Gmail first.'));
    }
  };

  window.rerunSection = async function(sectionId) {
    if (!sectionId) return;
    try {
      await callTool('rerun_meeting_kit', { section_ids: [sectionId] });
      refresh();
    } catch(e) {
      followUp('Could not re-run section "' + sectionId + '". Make sure meeting context is set first.');
    }
  };

  window.draftReply = function() {
    if (!state) return;
    var body = val('mk-email-body') || state.draftReply || '';
    followUp('Here is the draft reply email for the ' + state.meeting.company + ' meeting. Please review and send it:\\n\\n' + (body || 'No draft available.'));
  };

  window.copyKit = function() {
    if (!state) return;
    let text = 'MEETING KIT: ' + state.meeting.company + '\\n';
    text += '='.repeat(40) + '\\n\\n';
    (state.sections || []).forEach(function(s) {
      text += s.icon + ' ' + s.title + '\\n';
      text += s.content + '\\n';
      if (s.bullets) s.bullets.forEach(function(b) { text += '  → ' + b + '\\n'; });
      text += '\\n';
    });
    try { navigator.clipboard.writeText(text); } catch(e) {}
    followUp('Meeting kit copied. Here is the full kit for ' + state.meeting.company + '.');
  };

  window.copyClaudePrompt = function() {
    var prompt = [
      'PREREQUISITE: Before starting, add this MCP server to Claude:',
      '  URL: ' + MCP_URL,
      '  (Claude → Settings → Integrations → Add MCP Server)',
      '',
      'You are a research agent collaborating with ChatGPT on an investor meeting kit.',
      'Your job: research 3 topics (recent news, investor thesis, competitors) and write real findings',
      'directly into the live meeting kit that ChatGPT is building.',
      '',
      'STEP 1 — Join the workspace (required):',
      '  call join_workspace({ "name": "Claude Research", "client": "claude", "role": "backend", "autonomous": true })',
      '  The response contains "pending_work_for_you" — that is your first task.',
      '  Note the work item id and context.section from the response.',
      '',
      'STEP 2 — Research the task:',
      '  Read the task description carefully. Use your knowledge and web search to produce real, specific findings.',
      '  Do NOT use placeholders or generic statements.',
      '',
      'STEP 3 — Write findings to the kit:',
      '  call update_meeting_section({',
      '    "section_id": "<context.section from task>",',
      '    "content": "<2-3 sentence factual summary>",',
      '    "bullets": ["<5-7 specific, sourced bullet points>"],',
      '    "agent_name": "Claude Code"',
      '  })',
      '',
      'STEP 4 — Complete the task:',
      '  call complete_work({ "work_id": "<id from step 1>", "result": "Research complete for <section>" })',
      '',
      'STEP 5 — Get the next task:',
      '  call poll_work({ "role": "backend" })',
      '  Repeat steps 2-5 for each task.',
      '  Stop when poll_work returns work: null. There are exactly 3 tasks.',
    ].join('\\n');
    try { navigator.clipboard.writeText(prompt); } catch(e) {}
    followUp('Claude prompt copied. Open Claude → Settings → Integrations → Add MCP Server → paste: ' + MCP_URL);
  };

  window.copyCursorPrompt = function() {
    var company = (state && state.meeting && state.meeting.company) ? state.meeting.company : 'this company';
    var prompt = [
      'Add Stigmergy MCP to Cursor (same URL as ChatGPT uses). We share the same workspace — ChatGPT is building a meeting kit for ' + company + ', Claude is researching. Join and collaborate.',
      '',
      'PREREQUISITE: Add Stigmergy MCP server to Cursor:',
      '  URL: ' + MCP_URL,
      '  (Cursor → Settings → MCP → Add server)',
      '',
      'You are Cursor Agent, collaborating with ChatGPT and Claude on the SAME meeting kit. We share context via Stigmergy.',
      '',
      'STEP 1 — Join the shared workspace:',
      '  call join_workspace({ "name": "Cursor Agent", "client": "cursor", "role": "frontend", "autonomous": true })',
      '',
      'STEP 2 — Set the same target (so we\'re all working on the same thing):',
      '  call set_target({ "target": "Meeting Kit: ' + company + '" })',
      '',
      'STEP 3 — Poll for work:',
      '  call poll_work({ "role": "frontend" })',
      '  If no frontend work, try: call poll_work({ "role": "any" })',
      '  Complete tasks with update_meeting_section and complete_work.',
      '',
      'STEP 4 — Show we share context:',
      '  call get_meeting_kit({}) to see the live kit ChatGPT and Claude are building.',
      '  You can add or update sections with update_meeting_section({ section_id, content, bullets, agent_name: "Cursor Agent" }).',
    ].join('\n');
    try { navigator.clipboard.writeText(prompt); } catch(e) {}
    followUp('Cursor prompt copied. Add Stigmergy MCP to Cursor, paste this prompt, and Cursor will join the same workspace as ChatGPT.');
  };

  async function refresh() {
    // Skip refresh while user is editing a field — prevents overwriting (e.g. time reverting to 9am)
    var active = document.activeElement;
    if (active && active.id && String(active.id).indexOf('mk-') === 0) return;
    try {
      if (inChatGPT) {
        const result = await callTool('get_meeting_kit', {});
        let s;
        if (result && result.content && result.content[0]) {
          s = JSON.parse(result.content[0].text);
        } else if (typeof result === 'string') {
          s = JSON.parse(result);
        } else { s = result; }
        if (s) { state = s; render(s); }
      } else {
        const r = await fetch(API + '/api/meeting-kit/state');
        if (r.ok) { state = await r.json(); render(state); }
      }
    } catch(e) { console.error('refresh error:', e); }
  }

  function startPolling() {
    if (inChatGPT) {
      setInterval(refresh, 3000);
    } else {
      setInterval(refresh, 2000);
    }
  }

  refresh();
  startPolling();
})();
</script>
</body>
</html>`;

server.uiResource({
  type: "mcpApps",
  name: "meeting-kit",
  title: "Meeting Kit",
  description: "Show this widget after calling extract_meeting_context or generate_meeting_kit. This is the interactive Meeting Kit dashboard — shows the company snapshot, recent news, investor thesis, competitive landscape, talking points, agenda, questions to ask, and a draft reply email. Users can click 'Generate Kit' to run all agents, 'Create Calendar Event' to add to Google Calendar, and 'Send Reply Draft' to compose a reply.",
  htmlTemplate: MEETING_KIT_HTML,
  metadata: {
    description: "Meeting Kit: AI-powered investor meeting prep with multi-agent research, live agent feed, and interactive meeting packet",
    csp: {
      connectDomains: [
        "http://localhost:3200", "http://localhost:3201", "http://127.0.0.1:3200", "http://127.0.0.1:3201",
        "https://*.run.mcp-use.com", "https://*.fly.dev",
      ],
      resourceDomains: ["*"],
    },
    prefersBorder: true,
    autoResize: true,
  },
  toolOutput: () => {
    const sections = meetingKit.sections.length;
    const company = meetingKit.meeting.company || "none";
  return {
    content: [{
      type: "text" as const,
        text: `Meeting Kit opened. Company: ${company}. Status: ${meetingKit.status}. Sections: ${sections}. ${meetingKit.statusMessage}`,
      }],
  };
  },
});

// ========================================
// HTTP API + WebSocket
// ========================================

const app = express();
app.use(cors());
app.use(express.json());

registerHttpRoutes({
  app,
  workspace,
  clientAgents,
  docManager,
  sseClients,
  bumpVersion,
  API_PORT,
  hasOAuth: false,
});

const MCP_PATHS = ["/mcp", "/sse", "/inspector", "/mcp-use"];
function isMcpPath(url: string): boolean {
  const path = url.split("?")[0];
  return MCP_PATHS.some(p => path === p || path.startsWith(p + "/"));
}

async function startServers() {
  const mcpHandler = await server.getHandler();

  const requestListener = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => {
    const url = req.url || "/";
    if (isMcpPath(url)) {
      try {
        const host = req.headers.host || "localhost";
        const fullUrl = `http://${host}${url}`;
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (v != null) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
        }
        let body: Buffer | undefined;
        if (req.method !== "GET" && req.method !== "HEAD") {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c);
          body = Buffer.concat(chunks);
        }
        const fetchReq = new Request(fullUrl, {
          method: req.method || "GET",
          headers,
          body: body && body.length > 0 ? new Uint8Array(body) : undefined,
        });
        const fetchRes = await mcpHandler(fetchReq);
        res.writeHead(fetchRes.status, Object.fromEntries(fetchRes.headers));
        if (fetchRes.body) {
          const reader = fetchRes.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        }
        res.end();
      } catch (e) {
        log.error(`MCP handler error: ${e}`);
        res.writeHead(500).end("Internal Server Error");
      }
      return;
    }
    app(req, res as any);
  };

  const httpServer = http.createServer(requestListener);
  const { collabWss, broadcastSessionList } = setupCollabWs(httpServer, docManager);

  httpServer.listen(PORT, HOST, () => {
log.info(`
╔═══════════════════════════════════════════════════════════════╗
║                    STIGMERGY MCP SERVER                       ║
║            Autonomous Agent Coordination                      ║
╠═══════════════════════════════════════════════════════════════╣
║  MCP:       http://localhost:${PORT}/mcp                         ║
║  Dashboard: http://localhost:${PORT}/  (agents, locks, activity) ║
║  API:       http://localhost:${PORT}/api/workspaces            ║
║  Collab WS: ws://localhost:${PORT}/collab                      ║
╠═══════════════════════════════════════════════════════════════╣
║  Autonomous Demo Flow:                                        ║
║    1. ChatGPT: set_target("Login", backend_task, frontend_task)║
║    2. Claude:  poll_work("backend") -> auto-assigned          ║
║    3. Claude:  complete_work(result, handoff_context)         ║
║    4. Cursor:  poll_work("frontend") -> sees backend done     ║
║    5. Cursor:  auto-picks up with API context                 ║
╠═══════════════════════════════════════════════════════════════╣
║  Co-editing: create_doc -> ws://…/collab -> join              ║
╚═══════════════════════════════════════════════════════════════╝
`);
  });

  // Graceful shutdown
  function shutdown(signal: string): void {
    log.info(`${signal} received — shutting down gracefully`);

    for (const ws of collabWss.clients) {
      ws.close(1001, "server shutting down");
    }
    collabWss.close();

    sseClients.forEach(res => res.end());
    sseClients.clear();

    httpServer.close(() => {
      log.info("HTTP server closed");
      process.exit(0);
    });

    setTimeout(() => {
      log.info("Forcing exit after timeout");
      process.exit(1);
    }, 5_000).unref();
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return { httpServer, server, app };
}

// Start (async)
const { httpServer: _hs, server: _s, app: _a } = await startServers();
export { server, app };
export const httpServer = _hs;
