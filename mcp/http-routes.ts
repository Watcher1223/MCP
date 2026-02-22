import type { Response } from "express";
import type express from "express";
import type { WorkspaceState, Agent, Conflict, ApprovalGate, WarRoomCard, CardColumn } from "./types.js";
import { DEFAULT_LOCK_TTL } from "./types.js";
import type { DocSessionManager } from "./doc-session-manager.js";
import { buildWidgetGraphData, buildGraphData } from "./tools/graph.js";
import { generateId, now } from "../shared/utils.js";
import { conflicts, approvalGates, computeMissionState, warRoomCards, commandCenter, meetingKit } from "./workspace.js";
import { handleGoogleOAuthCallback, isGoogleConfigured, isGoogleRedirectConfigured, generateGoogleAuthUrlForState, getConnectionStatus } from "./tools/google-integration.js";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface HttpRouteDeps {
  app: ReturnType<typeof express>;
  workspace: WorkspaceState;
  clientAgents: Map<string, string>;
  docManager: DocSessionManager;
  sseClients: Set<Response>;
  bumpVersion: () => void;
  API_PORT: number;
  /** When true, serve OAuth metadata for ChatGPT MCP connector discovery */
  hasOAuth?: boolean;
}

/** Register all Express routes: dashboard, API endpoints, SSE, DEMO_TOOLS. */
export function registerHttpRoutes(deps: HttpRouteDeps): void {
  const { app, workspace, clientAgents, docManager, sseClients, bumpVersion, API_PORT, hasOAuth } = deps;

  // ── OAuth metadata for ChatGPT MCP connector discovery (RFC 9729) ──
  // Must be served at root so ChatGPT finds it when connecting to the MCP URL
  if (hasOAuth) {
    app.get("/.well-known/oauth-protected-resource", (req, res) => {
      const protocol = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
      const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "localhost:3200";
      const base = `${protocol}://${host}`;
      res.setHeader("Content-Type", "application/json");
      res.json({
        resource: `${base}/mcp`,
        authorization_servers: ["https://accounts.google.com"],
        scopes_supported: [
          "openid", "email", "profile",
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/calendar",
        ],
      });
    });
    app.get("/.well-known/oauth-protected-resource/mcp", (req, res) => {
      const protocol = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
      const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "localhost:3200";
      const base = `${protocol}://${host}`;
      res.setHeader("Content-Type", "application/json");
      res.json({
        resource: `${base}/mcp`,
        authorization_servers: ["https://accounts.google.com"],
        scopes_supported: [
          "openid", "email", "profile",
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/calendar",
        ],
      });
    });
  }

  // ── Short redirect for Google sign-in (prevents URL truncation in chat UIs) ──
  app.get("/auth/go", (req, res) => {
    const state = req.query.state as string;
    if (!state || !isGoogleConfigured() || !isGoogleRedirectConfigured()) {
      res.status(400).send("Invalid or missing state. Use the full sign-in link from the chat.");
      return;
    }
    const url = generateGoogleAuthUrlForState(state);
    res.redirect(302, url);
  });

  // ── Google OAuth callback (browser redirect after Google sign-in) ──
  app.get("/auth/google/callback", async (req, res) => {
    const code = req.query.code as string;
    const state = req.query.state as string | undefined;
    if (!code) {
      res.status(400).send("Missing authorization code. Please try the login flow again.");
      return;
    }

    // Preferred: exchange code server-side (no copy/paste) when state (session id) is present.
    if (state && isGoogleConfigured() && isGoogleRedirectConfigured()) {
      try {
        const { email } = await handleGoogleOAuthCallback(code, state);
        res.send(`
          <!DOCTYPE html><html><head><meta charset="utf-8"><title>Synapse - Google Connected</title>
          <style>
            body { font-family: system-ui; background: #0d1117; color: #c9d1d9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
            .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 32px; max-width: 520px; text-align: center; }
            h1 { color: #22c55e; font-size: 24px; margin-bottom: 10px; }
            p { color: #8b949e; line-height: 1.6; margin: 8px 0; }
            .check { font-size: 48px; margin-bottom: 12px; }
            .small { font-size: 12px; color: #6b7280; margin-top: 16px; }
            .btn { display: inline-block; margin-top: 14px; padding: 10px 14px; border-radius: 10px; border: 1px solid #30363d; color: #c9d1d9; text-decoration: none; }
            .btn:hover { border-color: #22c55e; }
          </style></head><body>
          <div class="card">
            <div class="check">&#x2705;</div>
            <h1>Google Connected</h1>
            <p>Signed in as <strong>${email}</strong>.</p>
            <p>Return to ChatGPT — the widget should refresh automatically.</p>
            <a class="btn" href="#" onclick="window.close();return false;">Close tab</a>
            <div class="small">If this tab doesn’t close, you can close it manually.</div>
          </div>
          <script>setTimeout(()=>{try{window.close()}catch(e){}}, 800);</script>
          </body></html>
        `);
        return;
      } catch (e: any) {
        // fall through to legacy code display
      }
    }

    // Legacy fallback: display auth code for copy/paste into ChatGPT.
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Synapse - Google Connected</title>
      <style>
        body { font-family: system-ui; background: #0d1117; color: #c9d1d9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
        .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 32px; max-width: 500px; text-align: center; }
        h1 { color: #22c55e; font-size: 24px; margin-bottom: 16px; }
        .code { background: #0d1117; border: 1px solid #30363d; padding: 12px 20px; border-radius: 8px; font-family: monospace; font-size: 14px; word-break: break-all; margin: 16px 0; cursor: pointer; }
        .code:hover { border-color: #22c55e; }
        p { color: #8b949e; line-height: 1.6; }
        .check { font-size: 48px; margin-bottom: 16px; }
      </style></head><body>
      <div class="card">
        <div class="check">&#x2705;</div>
        <h1>Google Connected!</h1>
        <p>Copy this code back to ChatGPT:</p>
        <div class="code" onclick="navigator.clipboard.writeText('${code}')" title="Click to copy">${code.substring(0, 20)}...</div>
        <p>Tell ChatGPT: <em>"The code is ${code.substring(0, 20)}..."</em></p>
        <p style="font-size:12px; margin-top:16px;">You can close this tab.</p>
      </div></body></html>`);
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      agents: workspace.agents.size,
      locks: workspace.locks.size,
      docSessions: docManager.listSessions().length,
      version: workspace.version,
    });
  });

  /** SSE stream: pushes widget graph data on every state change. */
  app.get("/api/events/stream", (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    const initial = JSON.stringify(buildWidgetGraphData(workspace, docManager));
    res.write(`data: ${initial}\n\n`);
    sseClients.add(res);
    _req.on("close", () => {
      sseClients.delete(res);
    });
  });

  // Dashboard
  app.get("/", (_req, res) => {
    res.type("text/html").send(dashboardHtml());
  });

  // Graph endpoint - supports ?format=widget
  app.get("/api/graph", (req, res) => {
    if (req.query.format === "widget") {
      return res.json(buildWidgetGraphData(workspace, docManager));
    }
    const { nodes, edges } = buildGraphData(workspace);
    res.json({ nodes, edges, version: workspace.version });
  });

  // Full state endpoint
  app.get("/api/state", (_req, res) => {
    res.json({
      target: workspace.target,
      agents: Array.from(workspace.agents.values()),
      locks: Array.from(workspace.locks.values()),
      intents: workspace.intents.slice(-20),
      workQueue: workspace.workQueue,
      version: workspace.version,
    });
  });

  // Demo compatibility: /api/execute (simple { tool, arguments, clientId } format)
  const DEMO_TOOLS = buildDemoTools(workspace, clientAgents, docManager, bumpVersion, API_PORT);

  app.post("/api/execute", async (req, res) => {
    try {
      const { tool, arguments: args = {}, clientId } = req.body as { tool?: string; arguments?: Record<string, unknown>; clientId?: string };
      if (!tool) return res.status(400).json({ error: "tool required" });
      const handler = DEMO_TOOLS[tool];
      if (!handler) return res.status(400).json({ error: `Unknown tool: ${tool}` });
      const result = await handler(args, clientId);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message) });
    }
  });

  // Frontend compatibility: /api/workspaces (single workspace as "default")
  const DEFAULT_WS_ID = "default";
  let workspaceName = process.env.DEMO_MODE === "1" ? "Demo Workspace" : "My Workspace";

  app.get("/api/workspaces", (_req, res) => {
    res.json({
      workspaces: [{
        id: DEFAULT_WS_ID,
        name: workspaceName,
        agents: workspace.agents.size,
        target: workspace.target,
      }],
    });
  });

  app.post("/api/workspaces", (req, res) => {
    const { name, reset } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });

    // Reset workspace state for fresh start
    workspaceName = name;
    workspace.agents.clear();
    workspace.locks.clear();
    workspace.intents = [];
    workspace.handoffs.clear();
    workspace.workQueue = [];
    workspace.target = null;
    workspace.version = 0;
    bumpVersion();

    res.json({
      id: DEFAULT_WS_ID,
      name: name,
      message: `Workspace "${name}" created`,
    });
  });

  // Reset workspace to clean state
  app.post("/api/workspaces/:id/reset", (req, res) => {
    workspace.agents.clear();
    workspace.locks.clear();
    workspace.intents = [];
    workspace.handoffs.clear();
    workspace.workQueue = [];
    workspace.target = null;
    workspace.version = 0;
    bumpVersion();
    res.json({ success: true, message: "Workspace reset" });
  });
  app.get("/api/workspaces/:id", (req, res) => {
    const id = req.params.id;
    if (id !== DEFAULT_WS_ID) return res.status(404).json({ error: "Workspace not found" });
    res.json({
      id: DEFAULT_WS_ID,
      name: workspaceName,
      target: workspace.target,
      agents: Array.from(workspace.agents.values()),
      locks: Array.from(workspace.locks.values()),
      intents: workspace.intents.slice(-20),
      workQueue: workspace.workQueue,
      version: workspace.version,
    });
  });
  app.get("/api/workspaces/:id/changes", (req, res) => {
    const id = req.params.id;
    if (id !== DEFAULT_WS_ID) return res.status(404).json({ error: "Workspace not found" });
    const since = parseInt(req.query.since as string) || 0;
    if (workspace.version <= since) {
      res.json({ changed: false, version: workspace.version });
      return;
    }
    res.json({
      changed: true,
      version: workspace.version,
      target: workspace.target,
      agents: Array.from(workspace.agents.values()),
      locks: Array.from(workspace.locks.values()),
      intents: workspace.intents.slice(-10),
      workQueue: workspace.workQueue,
    });
  });

  // Active co-editing sessions endpoint
  app.get("/api/sessions", (_req, res) => {
    const sessions = docManager.listSessions();
    res.json({ count: sessions.length, sessions });
  });

  // Changes endpoint (for polling)
  app.get("/api/changes", (req, res) => {
    const since = parseInt(req.query.since as string) || 0;
    if (workspace.version <= since) {
      res.json({ changed: false, version: workspace.version });
      return;
    }
    res.json({
      changed: true,
      version: workspace.version,
      target: workspace.target,
      agents: Array.from(workspace.agents.values()),
      locks: Array.from(workspace.locks.values()),
      intents: workspace.intents.slice(-10),
      workQueue: workspace.workQueue,
    });
  });

  // ========================================
  // MISSION CONTROL ENDPOINTS
  // ========================================

  // Get full mission state for widget
  app.get("/api/mission/state", (_req, res) => {
    const state = computeMissionState();
    const agents = Array.from(workspace.agents.values());
    const pendingConflicts = conflicts.filter(c => c.status === "pending");
    const pendingApprovals = approvalGates.filter(a => a.status === "pending");

    res.json({
      missionState: state,
      target: workspace.target,
      version: workspace.version,
      agents: agents.map(a => ({
        id: a.id,
        name: a.name,
        client: a.client,
        role: a.role,
        status: a.status,
        currentTask: a.currentTask,
        autonomous: a.autonomous,
      })),
      locks: Array.from(workspace.locks.values()).map(l => ({
        path: l.path,
        agentName: l.agentName,
        client: l.client,
        expiresIn: Math.max(0, Math.ceil((l.expiresAt - now()) / 1000)),
      })),
      conflicts: pendingConflicts.map(c => ({
        id: c.id,
        type: c.type,
        description: c.description,
        involvedAgents: c.involvedAgents,
        involvedFiles: c.involvedFiles,
        reportedAt: c.reportedAt,
      })),
      approvalGates: pendingApprovals.map(a => ({
        id: a.id,
        description: a.description,
        requestedByName: a.requestedByName,
        requestedAt: a.requestedAt,
        context: a.context,
      })),
      workProgress: {
        total: workspace.workQueue.length,
        completed: workspace.workQueue.filter(w => w.status === "completed").length,
        inProgress: workspace.workQueue.filter(w => w.status === "assigned").length,
        pending: workspace.workQueue.filter(w => w.status === "pending").length,
      },
      recentActivity: workspace.intents.slice(-10).map(i => ({
        agentName: i.agentName,
        client: i.client,
        action: i.action,
        description: i.description,
        timestamp: i.timestamp,
      })),
    });
  });

  // Handle approval/rejection from widget
  app.post("/api/mission/approve", (req, res) => {
    const { gate_id, approved, reason } = req.body as { gate_id?: string; approved?: boolean; reason?: string };
    if (!gate_id) return res.status(400).json({ error: "gate_id required" });

    const gate = approvalGates.find(g => g.id === gate_id);
    if (!gate) return res.status(404).json({ error: "Gate not found" });
    if (gate.status !== "pending") return res.status(400).json({ error: `Gate already ${gate.status}` });

    gate.status = approved ? "approved" : "rejected";
    gate.approvedAt = now();
    gate.approvedBy = "Human (via Mission Control)";
    if (!approved) gate.rejectionReason = reason || "Rejected via widget";

    workspace.intents.push({
      id: generateId(),
      agentId: "human",
      agentName: "Human",
      client: "chatgpt",
      action: approved ? "completed" : "blocked",
      description: approved
        ? `✅ Approved: ${gate.description}`
        : `❌ Rejected: ${gate.description}`,
      timestamp: now(),
    });

    bumpVersion();
    res.json({ success: true, gate_id, status: gate.status });
  });

  // Handle conflict resolution from widget
  app.post("/api/mission/resolve-conflict", (req, res) => {
    const { conflict_id, resolution } = req.body as { conflict_id?: string; resolution?: string };
    if (!conflict_id) return res.status(400).json({ error: "conflict_id required" });

    const conflict = conflicts.find(c => c.id === conflict_id);
    if (!conflict) return res.status(404).json({ error: "Conflict not found" });
    if (conflict.status !== "pending") return res.status(400).json({ error: `Conflict already ${conflict.status}` });

    conflict.status = "resolved";
    conflict.resolution = resolution || "Resolved via Mission Control";
    conflict.resolvedAt = now();
    conflict.resolvedBy = "Human (via Mission Control)";

    workspace.intents.push({
      id: generateId(),
      agentId: "human",
      agentName: "Human",
      client: "chatgpt",
      action: "completed",
      description: `🔧 Resolved: ${conflict.description}`,
      timestamp: now(),
    });

    bumpVersion();
    res.json({ success: true, conflict_id, status: conflict.status });
  });

  // ========================================
  // WAR ROOM ENDPOINTS
  // ========================================

  /** Get all War Room cards for the widget */
  app.get("/api/warroom/cards", (_req, res) => {
    const cards = Array.from(warRoomCards.values()).sort((a, b) => a.createdAt - b.createdAt);
    res.json({
      cards,
      columns: {
        todo: cards.filter(c => c.column === "todo"),
        doing: cards.filter(c => c.column === "doing"),
        done: cards.filter(c => c.column === "done"),
      },
    });
  });

  /** Move a card to a different column (drag-drop from widget) */
  app.post("/api/warroom/move", (req, res) => {
    const { card_id, column } = req.body as { card_id?: string; column?: CardColumn };
    if (!card_id || !column) return res.status(400).json({ error: "card_id and column required" });

    const card = warRoomCards.get(card_id);
    if (!card) return res.status(404).json({ error: "Card not found" });

    card.column = column;
    card.status = column === "done" ? "done" : column === "doing" ? "active" : "pending";
    card.updatedAt = now();
    bumpVersion();
    res.json({ success: true, card_id, column });
  });

  /** Execute a command card from the widget */
  app.post("/api/warroom/execute", async (req, res) => {
    const { card_id } = req.body as { card_id?: string };
    if (!card_id) return res.status(400).json({ error: "card_id required" });

    const card = warRoomCards.get(card_id);
    if (!card) return res.status(404).json({ error: "Card not found" });

    if (card.type === "command" && card.command) {
      card.executing = true;
      card.column = "doing";
      card.status = "active";
      bumpVersion();

      try {
        const { stdout, stderr } = await execAsync(card.command, {
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          cwd: process.cwd(),
        });
        card.output = stdout || stderr || "(no output)";
        card.executing = false;
        card.column = "done";
        card.status = "done";
        bumpVersion();
        res.json({ success: true, card_id, output: card.output, status: "done" });
      } catch (err: any) {
        card.output = err.stderr || err.message || "Command failed";
        card.executing = false;
        card.status = "active";
        bumpVersion();
        res.json({ success: false, card_id, error: card.output, status: "error" });
      }
    } else {
      // Non-command card: just mark done
      card.column = "done";
      card.status = "done";
      card.updatedAt = now();
      bumpVersion();
      res.json({ success: true, card_id, status: "done" });
    }
  });

  /** Clear all War Room cards */
  app.post("/api/warroom/clear", (_req, res) => {
    const count = warRoomCards.size;
    warRoomCards.clear();
    bumpVersion();
    res.json({ success: true, cleared: count });
  });

  // ========================================
  // COMMAND CENTER ENDPOINTS
  // ========================================

  /** Full Command Center state for widget */
  app.get("/api/cc/state", (_req, res) => {
    res.json(commandCenter);
  });

  app.get("/api/meeting-kit/state", (_req, res) => {
    res.json(meetingKit);
  });

  /** Execute an action from the Command Center widget */
  app.post("/api/cc/action", async (req, res) => {
    const { action, target_id, payload } = req.body as {
      action?: string; target_id?: string; payload?: Record<string, unknown>;
    };
    if (!action) return res.status(400).json({ error: "action required" });

    try {
      const result = await DEMO_TOOLS.cc_execute_action({ action, target_id, payload });
      res.json({ success: true, result: result.content[0]?.text });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Force unlock endpoint for widget
  app.post("/api/mission/force-unlock", (req, res) => {
    const { path, reason } = req.body as { path?: string; reason?: string };
    if (!path) return res.status(400).json({ error: "path required" });

    const lock = workspace.locks.get(path);
    if (!lock) return res.status(404).json({ error: `No lock on ${path}` });

    const previousHolder = lock.agentName;
    workspace.locks.delete(path);

    // Resolve related conflict if any
    const relatedConflict = conflicts.find(c =>
      c.status === "pending" &&
      c.type === "lock_collision" &&
      c.involvedFiles?.includes(path)
    );
    if (relatedConflict) {
      relatedConflict.status = "resolved";
      relatedConflict.resolution = reason || "Force unlocked via Mission Control";
      relatedConflict.resolvedAt = now();
      relatedConflict.resolvedBy = "Human (via Mission Control)";
    }

    workspace.intents.push({
      id: generateId(),
      agentId: "human",
      agentName: "Human",
      client: "chatgpt",
      action: "working",
      description: `🔓 Force unlocked ${path} (was ${previousHolder})`,
      timestamp: now(),
    });

    bumpVersion();
    res.json({
      success: true,
      path,
      previousHolder,
      conflictResolved: !!relatedConflict,
    });
  });
}

// ---------------------------------------------------------------------------
// Dashboard HTML
// ---------------------------------------------------------------------------

function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html>
<head><title>Stigmergy Dashboard</title>
<meta charset="utf-8"/>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#0d1117;color:#c9d1d9;margin:0;padding:16px}
h1{font-size:18px;margin:0 0 16px}
h3{font-size:14px;margin:20px 0 10px;color:#8b949e}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px}
.card h4{font-size:11px;margin:0 0 6px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px}
.lock{color:#d29922}
.lock .expiry{font-size:10px;color:#8b949e;margin-top:2px}
.agent{color:#58a6ff}
.doc{color:#22c55e}
.doc .editors{font-size:11px;color:#8b949e;margin-top:4px}
.doc .editors span{display:inline-block;padding:1px 6px;border-radius:3px;margin:2px 2px 0 0;font-size:10px}
.intent{color:#8b949e;font-size:11px;border-left:2px solid #484f58;padding-left:8px;margin:4px 0}
.target{color:#a371f7;font-weight:600}
.badge{display:inline-block;padding:1px 6px;border-radius:10px;font-size:10px;margin-left:6px}
.v{color:#484f58;font-size:10px;float:right}
</style>
</head>
<body>
<h1>Stigmergy Collaboration</h1>
<div id="root">Loading...</div>
<script>
async function refresh(){
  try{
    const r=await fetch('/api/graph?format=widget');
    render(await r.json());
  }catch(e){document.getElementById('root').innerHTML='<div style="color:#f85149">Error: '+e.message+'</div>'}
}
refresh();
const es=new EventSource('/api/events/stream');
es.onmessage=function(e){try{render(JSON.parse(e.data))}catch(err){console.error(err)}};
es.onerror=function(){console.warn('SSE failed, falling back to polling');es.close();setInterval(refresh,3000)};
function render(d){
  let h='<div class="grid">';
  h+='<div class="card"><h4>Target</h4><div class="target">'+(d.target||'No target set')+'</div><div class="v">v'+d.lastUpdate+'</div></div>';
  (d.agents||[]).forEach(a=>{h+='<div class="card"><h4>Agent</h4><div class="agent">'+a.label+'</div><div style="font-size:11px;color:#8b949e">'+a.role+' &middot; '+a.status+'</div></div>'});
  (d.locks||[]).forEach(l=>{h+='<div class="card"><h4>Lock</h4><div class="lock">'+l.label+'</div><div class="expiry">'+((l.expiresIn||'')===''?'':'expires in '+l.expiresIn)+'</div></div>'});
  h+='</div>';
  const docs=d.docSessions||[];
  h+='<h3>Collaborative Editing ('+docs.length+')</h3>';
  if(docs.length===0){h+='<div style="color:#484f58;font-size:12px">No active sessions</div>'}
  else{h+='<div class="grid">';docs.forEach(s=>{
    h+='<div class="card"><h4>Doc Session</h4><div class="doc">'+s.label+'</div>';
    h+='<div class="editors">';
    (s.editors||[]).forEach(e=>{h+='<span style="background:'+e.color+'22;color:'+e.color+'">'+e.name+' ('+e.role+')</span>'});
    if(s.editors.length===0) h+='<span style="color:#484f58">no editors</span>';
    h+='</div>';
    h+='<div style="font-size:10px;color:#484f58;margin-top:4px">'+s.updateCount+' updates</div>';
    h+='</div>'});
  h+='</div>'}
  h+='<h3>Activity</h3>';
  const ev=(d.recentEvents||[]).slice().reverse();
  if(ev.length===0){h+='<div style="color:#484f58;font-size:12px">No activity yet</div>'}
  else{ev.forEach(e=>{h+='<div class="intent">'+e.agent+': '+e.description+'</div>'})}
  document.getElementById('root').innerHTML=h;
}
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// DEMO_TOOLS (simplified HTTP handlers mirroring MCP tool logic)
// ---------------------------------------------------------------------------

type DemoHandler = (args: Record<string, unknown>, clientId?: string) => Promise<{ content: { type: string; text: string }[] }>;

function buildDemoTools(
  workspace: WorkspaceState,
  clientAgents: Map<string, string>,
  docManager: DocSessionManager,
  bumpVersion: () => void,
  API_PORT: number,
): Record<string, DemoHandler> {
  return {
    join_workspace: async (args, clientId) => {
      const a = args as { name?: string; client?: string; role?: string };
      const agent: Agent = {
        id: generateId(),
        name: (a?.name as string) || "Agent",
        client: (a?.client as Agent["client"]) || "terminal",
        role: (a?.role as Agent["role"]) || "backend",
        status: "idle",
        joinedAt: now(),
        lastSeen: now(),
        autonomous: true,
      };
      workspace.agents.set(agent.id, agent);
      if (clientId) clientAgents.set(clientId, agent.id);
      bumpVersion();
      return { content: [{ type: "text", text: JSON.stringify({ welcome: `Joined as ${agent.name}`, your_id: agent.id }) }] };
    },
    set_target: async (args) => {
      const t = args as { target?: string };
      workspace.target = t?.target as string || "Login page";
      const b = `Implement backend for ${workspace.target}`;
      const f = `Build frontend for ${workspace.target}`;
      workspace.workQueue.push({ id: generateId(), description: b, forRole: "backend", createdBy: "Planner", createdAt: now(), status: "pending", context: { target: workspace.target } });
      workspace.workQueue.push({ id: generateId(), description: f, forRole: "frontend", createdBy: "Planner", createdAt: now(), status: "pending", context: { target: workspace.target, depends_on: "backend" } });
      bumpVersion();
      return { content: [{ type: "text", text: `Target: ${workspace.target}. Tasks queued.` }] };
    },
    poll_work: async (args, clientId) => {
      const role = (args?.role as string) || "backend";
      const agentId = clientId ? clientAgents.get(clientId) : undefined;
      const agent = agentId ? workspace.agents.get(agentId) : null;
      const work = workspace.workQueue.find(w => {
        if (w.status !== "pending") return false;
        if (w.forRole !== role && w.forRole !== "any" && role !== "any") return false;
        if (w.context?.depends_on === "backend") {
          const done = workspace.workQueue.some(b => b.forRole === "backend" && b.status === "completed")
            || workspace.intents.some(i => i.action === "handoff" && i.target === "frontend");
          return done;
        }
        return true;
      });
      if (!work) return { content: [{ type: "text", text: JSON.stringify({ work: null }) }] };
      if (agent?.autonomous) {
        work.status = "assigned";
        work.assignedTo = agent.id;
        agent.status = "working";
        agent.currentTask = work.description;
        bumpVersion();
      }
      return { content: [{ type: "text", text: JSON.stringify({ work: { id: work.id, description: work.description, context: work.context } }) }] };
    },
    lock_file: async (args, clientId) => {
      const agentId = clientId ? clientAgents.get(clientId) : undefined;
      const agent = agentId ? workspace.agents.get(agentId) : null;
      const path = (args?.path as string) || "src/auth.ts";
      if (!agent) return { content: [{ type: "text", text: "Join first." }] };
      const existing = workspace.locks.get(path);
      if (existing && existing.agentId !== agentId && existing.expiresAt > now()) {
        return { content: [{ type: "text", text: `LOCKED by ${existing.agentName} (${existing.role}). Expires in ${Math.ceil((existing.expiresAt - now()) / 1000)}s.` }] };
      }
      const ttl = (args?.ttl as number) ?? DEFAULT_LOCK_TTL;
      const ts = now();
      workspace.locks.set(path, { path, agentId: agent.id, agentName: agent.name, client: agent.client, role: agent.role, lockedAt: ts, expiresAt: ts + ttl, reason: args?.reason as string });
      agent.status = "working";
      agent.currentTask = path;
      bumpVersion();
      return { content: [{ type: "text", text: `Locked: ${path} (expires in ${ttl / 1000}s)` }] };
    },
    unlock_file: async (args, clientId) => {
      const agentId = clientId ? clientAgents.get(clientId) : undefined;
      const agent = agentId ? workspace.agents.get(agentId) : null;
      const path = (args?.path as string) || "src/auth.ts";
      const lock = workspace.locks.get(path);
      if (!lock || lock.agentId !== agentId) return { content: [{ type: "text", text: "Not your lock." }] };
      workspace.locks.delete(path);
      if (agent) { agent.status = "idle"; agent.currentTask = undefined; }
      if (args?.handoff_to || args?.message) {
        workspace.intents.push({
          id: generateId(),
          agentId: agentId || "unknown",
          agentName: agent?.name || "Unknown",
          client: agent?.client || "unknown",
          action: "handoff",
          description: (args?.message as string) || `${path} ready`,
          target: args?.handoff_to as string,
          timestamp: now(),
        });
        if (args?.handoff_to) workspace.handoffs.set(path, args.handoff_to as string);
      }
      bumpVersion();
      return { content: [{ type: "text", text: `Unlocked: ${path}` }] };
    },
    complete_work: async (args, clientId) => {
      const agentId = clientId ? clientAgents.get(clientId) : undefined;
      const agent = agentId ? workspace.agents.get(agentId) : null;
      const workId = args?.work_id as string;
      const work = workspace.workQueue.find(w => w.id === workId);
      if (!work) return { content: [{ type: "text", text: "Work not found." }] };
      work.status = "completed";
      if (agent) { agent.status = "idle"; agent.currentTask = undefined; }
      workspace.intents.push({
        id: generateId(),
        agentId: agentId || "unknown",
        agentName: agent?.name || "Unknown",
        client: agent?.client || "unknown",
        action: "completed",
        description: (args?.result as string) || "Done",
        timestamp: now(),
      });
      const nextRole = work.forRole === "backend" ? "frontend" : work.forRole === "frontend" ? "tester" : null;
      if (nextRole) {
        const nextWork = workspace.workQueue.find(w => w.status === "pending" && w.forRole === nextRole);
        if (nextWork && args?.handoff_context) nextWork.context = { ...nextWork.context, ...(args.handoff_context as object) };
        workspace.intents.push({
          id: generateId(),
          agentId: agentId || "unknown",
          agentName: agent?.name || "Unknown",
          client: agent?.client || "unknown",
          action: "handoff",
          description: `Ready for ${nextRole}`,
          target: nextRole,
          timestamp: now(),
        });
      }
      bumpVersion();
      return { content: [{ type: "text", text: `Completed.${nextRole ? ` Handoff to ${nextRole}.` : ""}` }] };
    },
    post_intent: async (args, clientId) => {
      const agentId = clientId ? clientAgents.get(clientId) : undefined;
      const agent = agentId ? workspace.agents.get(agentId) : null;
      workspace.intents.push({
        id: generateId(),
        agentId: agentId || "unknown",
        agentName: agent?.name || "Unknown",
        client: agent?.client || "unknown",
        action: (args?.action as string) || "working",
        description: (args?.description as string) || "",
        timestamp: now(),
      });
      if (workspace.intents.length > 50) workspace.intents = workspace.intents.slice(-50);
      bumpVersion();
      return { content: [{ type: "text", text: "Posted." }] };
    },
    get_context: async () => {
      return { content: [{ type: "text", text: JSON.stringify({ target: workspace.target, agents: Array.from(workspace.agents.values()), locks: Array.from(workspace.locks.values()), intents: workspace.intents.slice(-5) }) }] };
    },
    create_doc: async (args) => {
      const path = (args?.path as string) || "";
      if (!path) return { content: [{ type: "text", text: JSON.stringify({ error: "path is required" }) }] };
      const { created, session } = docManager.create(path, args?.initial_content as string | undefined);
      bumpVersion();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            created,
            path: session.path,
            editors: session.editors,
            collab_url: `ws://localhost:${API_PORT}/collab`,
          }),
        }],
      };
    },
    list_sessions: async () => {
      const sessions = docManager.listSessions();
      return { content: [{ type: "text", text: JSON.stringify({ count: sessions.length, sessions }) }] };
    },
    get_doc_content: async (args) => {
      const path = (args?.path as string) || "";
      const content = docManager.getTextContent(path);
      if (content === null) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `No active session for '${path}'` }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ path, content }) }] };
    },
    renew_lock: async (args, clientId) => {
      const agentId = clientId ? clientAgents.get(clientId) : undefined;
      const path = (args?.path as string) || "";
      const lock = workspace.locks.get(path);
      if (!lock) return { content: [{ type: "text", text: `No lock on ${path}.` }] };
      if (lock.agentId !== agentId) return { content: [{ type: "text", text: `Not your lock. Held by ${lock.agentName}.` }] };
      const ttl = (args?.ttl as number) ?? DEFAULT_LOCK_TTL;
      lock.expiresAt = now() + ttl;
      bumpVersion();
      return { content: [{ type: "text", text: `Renewed: ${path} (expires in ${ttl / 1000}s)` }] };
    },
    // War Room tools (HTTP fallback for widget useCallTool)
    upsert_card: async (args) => {
      const cardId = (args.id as string) || generateId();
      const existing = warRoomCards.get(cardId);
      const ts = now();
      const card: WarRoomCard = {
        id: cardId,
        type: (args.type as any) || "task",
        title: (args.title as string) || "Untitled",
        content: (args.content as string) || "",
        status: (args.status as any) || "pending",
        column: (args.column as any) || "todo",
        command: args.command as string | undefined,
        output: existing?.output,
        executing: false,
        category: args.category as string | undefined,
        icon: args.icon as string | undefined,
        createdAt: existing?.createdAt || ts,
        updatedAt: ts,
      };
      warRoomCards.set(cardId, card);
      bumpVersion();
      return { content: [{ type: "text", text: JSON.stringify({ card_id: cardId, title: card.title, column: card.column }) }] };
    },
    execute_action: async (args) => {
      const card = warRoomCards.get(args.card_id as string);
      if (!card) return { content: [{ type: "text", text: "Card not found." }] };
      const action = (args.action as string) || "run";
      if (action === "run" && card.type === "command" && card.command) {
        card.executing = true; card.column = "doing"; card.status = "active"; bumpVersion();
        try {
          const { stdout, stderr } = await execAsync(card.command, { timeout: 30000, maxBuffer: 1024*1024 });
          card.output = stdout || stderr || "(no output)";
          card.executing = false; card.column = "done"; card.status = "done"; bumpVersion();
          return { content: [{ type: "text", text: JSON.stringify({ card_id: card.id, output: card.output, status: "done" }) }] };
        } catch (err: any) {
          card.output = err.stderr || err.message || "Failed";
          card.executing = false; bumpVersion();
          return { content: [{ type: "text", text: JSON.stringify({ card_id: card.id, error: card.output }) }] };
        }
      }
      if (action === "complete" || action === "approve") { card.column = "done"; card.status = "done"; }
      else if (action === "dismiss") { warRoomCards.delete(card.id); bumpVersion(); return { content: [{ type: "text", text: "Dismissed." }] }; }
      bumpVersion();
      return { content: [{ type: "text", text: JSON.stringify({ card_id: card.id, status: card.status }) }] };
    },
    move_card: async (args) => {
      const card = warRoomCards.get(args.card_id as string);
      if (!card) return { content: [{ type: "text", text: "Card not found." }] };
      card.column = args.column as any;
      card.status = card.column === "done" ? "done" : card.column === "doing" ? "active" : "pending";
      card.updatedAt = now();
      bumpVersion();
      return { content: [{ type: "text", text: `Moved "${card.title}" to ${args.column}.` }] };
    },
    list_cards: async (args) => {
      let cards = Array.from(warRoomCards.values());
      if (args.column) cards = cards.filter(c => c.column === args.column);
      return { content: [{ type: "text", text: JSON.stringify({ count: cards.length, cards: cards.map(c => ({ id: c.id, type: c.type, title: c.title, column: c.column })) }) }] };
    },
    clear_board: async () => {
      const count = warRoomCards.size;
      warRoomCards.clear();
      bumpVersion();
      return { content: [{ type: "text", text: `Cleared ${count} cards.` }] };
    },
    // Command Center tools
    cc_execute_action: async (args) => {
      const action = args.action as string;
      const targetId = args.target_id as string | undefined;
      const payload = (args.payload || {}) as Record<string, unknown>;
      let msg = "";

      commandCenter.status = "processing";
      bumpVersion();

      switch (action) {
        case "book_flight": {
          const flight = commandCenter.data.flights.find(f => f.id === targetId);
          if (!flight) { msg = "Flight not found."; break; }
          commandCenter.data.flights.forEach(f => f.selected = false);
          flight.selected = true;
          const flightDate = (payload.date as string) || new Date(Date.now() + 7 * 86400_000).toISOString().split("T")[0];
          commandCenter.data.events.push({
            id: generateId(), title: `✈️ ${flight.airline} ${flight.flightNo} — ${flight.from}→${flight.to}`,
            date: flightDate, time: flight.departure, duration: "5h30m", color: "#a855f7",
          });
          if (!commandCenter.activeModules.includes("calendar")) commandCenter.activeModules.push("calendar");
          commandCenter.actions.push({ id: generateId(), module: "travel", label: "Booked Flight",
            description: `${flight.airline} ${flight.flightNo} $${flight.price}`, status: "done", timestamp: now() });
          msg = `Booked ${flight.airline} ${flight.flightNo} (${flight.from}→${flight.to}) for $${flight.price}. Added to calendar.`;
          break;
        }
        case "book_hotel": {
          const hotel = commandCenter.data.hotels.find((h: any) => h.id === targetId);
          if (!hotel) { msg = "Hotel not found."; break; }
          commandCenter.data.hotels.forEach((h: any) => h.selected = false);
          hotel.selected = true;
          const hotelDate = (payload.date as string) || new Date(Date.now() + 7 * 86400_000).toISOString().split("T")[0];
          commandCenter.data.events.push({
            id: generateId(), title: `🏨 ${hotel.name}`,
            date: hotelDate, time: "15:00", duration: "2 nights", location: hotel.name, color: "#ec4899",
          });
          if (!commandCenter.activeModules.includes("calendar")) commandCenter.activeModules.push("calendar");
          commandCenter.actions.push({ id: generateId(), module: "hotels" as any, label: "Booked Hotel",
            description: `${hotel.name} $${hotel.pricePerNight}/night`, status: "done", timestamp: now() });
          msg = `Booked ${hotel.name} at $${hotel.pricePerNight}/night. Added to calendar.`;
          break;
        }
        case "archive_email": {
          commandCenter.data.emails = commandCenter.data.emails.filter(e => e.id !== targetId);
          msg = "Email archived.";
          break;
        }
        case "star_email": {
          const em = commandCenter.data.emails.find(e => e.id === targetId);
          if (em) { em.starred = !em.starred; msg = em.starred ? "Email starred." : "Star removed."; }
          break;
        }
        case "mark_read": {
          const em = commandCenter.data.emails.find(e => e.id === targetId);
          if (em) { em.read = true; msg = "Marked as read."; }
          break;
        }
        case "run_command": {
          const cmd = (payload.command as string) || "echo hello";
          if (!commandCenter.activeModules.includes("terminal")) commandCenter.activeModules.push("terminal");
          try {
            const { stdout, stderr } = await execAsync(cmd, { timeout: 15000, maxBuffer: 512*1024 });
            commandCenter.data.terminal.push({ id: generateId(), command: cmd, output: stdout||stderr||"(no output)", exitCode: 0, timestamp: now() });
            msg = `Executed: ${(stdout||stderr||"").slice(0,300)}`;
          } catch (err: any) {
            commandCenter.data.terminal.push({ id: generateId(), command: cmd, output: err.stderr||err.message||"Failed", exitCode: 1, timestamp: now() });
            msg = `Failed: ${(err.stderr||err.message||"").slice(0,200)}`;
          }
          break;
        }
        case "dismiss_module": {
          const mod = (payload.module || targetId) as string;
          commandCenter.activeModules = commandCenter.activeModules.filter(m => m !== mod);
          msg = `Module "${mod}" dismissed.`;
          break;
        }
        default: msg = `Unknown action: ${action}`;
      }

      commandCenter.status = "idle";
      commandCenter.statusMessage = msg;
      commandCenter.lastUpdated = now();
      bumpVersion();
      return { content: [{ type: "text", text: msg }] };
    },
    activate_module: async (args) => {
      const modules = (args.modules || [args.module]) as string[];
      modules.forEach(m => {
        if (!commandCenter.activeModules.includes(m as any)) commandCenter.activeModules.push(m as any);
      });
      commandCenter.lastUpdated = now();
      bumpVersion();
      return { content: [{ type: "text", text: `Activated: ${modules.join(", ")}` }] };
    },
    get_workspace: async () => {
      const state = { ...commandCenter } as Record<string, unknown>;
      state.googleConnection = getConnectionStatus({});
      return { content: [{ type: "text", text: JSON.stringify(state) }] };
    },
    sync_context: async (args) => {
      if (process.env.DEMO_MODE !== "1") {
        return { content: [{ type: "text", text: "sync_context is only available in demo mode (DEMO_MODE=1). Use check_email or read_calendar for real data." }] };
      }
      const source = (args.source as string) || "email";
      if (source === "email" && commandCenter.data.emails.length > 0) {
        if (!commandCenter.activeModules.includes("email")) commandCenter.activeModules.push("email");
        bumpVersion();
        return { content: [{ type: "text", text: `Email module already has ${commandCenter.data.emails.length} emails. Use check_email to refresh.` }] };
      }
      if (source === "calendar" && commandCenter.data.events.length > 0) {
        if (!commandCenter.activeModules.includes("calendar")) commandCenter.activeModules.push("calendar");
        bumpVersion();
        return { content: [{ type: "text", text: `Calendar already has ${commandCenter.data.events.length} events. Use read_calendar to refresh.` }] };
      }
      commandCenter.status = "processing";
      commandCenter.statusMessage = "Syncing " + source + " (demo)...";
      bumpVersion();
      if (source === "email") {
        commandCenter.data.emails = [
          { id: generateId(), from: "sarah@acme.com", subject: "Q1 Board Deck — Final Review",
            preview: "Hi team, attached is the final Q1 deck. Please review slides 12-18 on revenue projections.",
            date: new Date(Date.now() - 3600_000).toISOString(), read: false, starred: true, labels: ["urgent","finance"] },
          { id: generateId(), from: "travel@kayak.com", subject: "Price Alert: SFO → NYC $189 roundtrip",
            preview: "Prices dropped 42% for your saved route San Francisco to New York.",
            date: new Date(Date.now() - 7200_000).toISOString(), read: false, starred: false, labels: ["travel"] },
          { id: generateId(), from: "mike@eng.team", subject: "Re: Database migration plan",
            preview: "Let's do the migration this Saturday during the maintenance window.",
            date: new Date(Date.now() - 10800_000).toISOString(), read: true, starred: false, labels: ["engineering"] },
          { id: generateId(), from: "calendar@google.com", subject: "Reminder: Team dinner at Nopa",
            preview: "You have an upcoming event: Team dinner at Nopa, 560 Divisadero St, SF.",
            date: new Date(Date.now() - 86400_000).toISOString(), read: true, starred: false, labels: ["social"] },
          { id: generateId(), from: "jen@marketing.co", subject: "Launch campaign assets ready",
            preview: "All creative assets for the March launch are uploaded to Figma.",
            date: new Date(Date.now() - 100800_000).toISOString(), read: true, starred: false, labels: ["marketing"] },
        ];
        if (!commandCenter.activeModules.includes("email")) commandCenter.activeModules.push("email");
      } else if (source === "calendar") {
        const today = new Date().toISOString().split("T")[0];
        commandCenter.data.events = [
          { id: generateId(), title: "Stand-up", date: today, time: "09:00", duration: "15m", location: "Zoom", color: "#3b82f6" },
          { id: generateId(), title: "Board Meeting", date: today, time: "14:00", duration: "1h", location: "Conference Room A", color: "#f97316" },
          { id: generateId(), title: "Team Dinner", date: today, time: "19:00", duration: "2h", location: "Nopa, SF", color: "#22c55e" },
        ];
        if (!commandCenter.activeModules.includes("calendar")) commandCenter.activeModules.push("calendar");
      }
      commandCenter.status = "idle";
      commandCenter.statusMessage = source + " synced (demo)";
      commandCenter.lastUpdated = now();
      bumpVersion();
      return { content: [{ type: "text", text: "Synced " + source + " (demo). " + (source === "email" ? commandCenter.data.emails.length + " emails loaded." : commandCenter.data.events.length + " events loaded.") }] };
    },
    find_hotels: async (args) => {
      if (process.env.DEMO_MODE !== "1") {
        return { content: [{ type: "text", text: "find_hotels is only available in demo mode (DEMO_MODE=1)." }] };
      }
      const city = (args.city as string) || "NYC";
      commandCenter.status = "processing";
      commandCenter.statusMessage = "Searching hotels in " + city + "...";
      bumpVersion();
      const hotelData = [
        { name: "The Greenwich Hotel", stars: 5, price: 495, rating: 4.8, reviews: 2341, amenities: ["spa","pool","gym","restaurant"] },
        { name: "Hyatt Place Downtown", stars: 3, price: 189, rating: 4.3, reviews: 1856, amenities: ["gym","breakfast","wifi"] },
        { name: "The Standard Hotel", stars: 4, price: 329, rating: 4.5, reviews: 3102, amenities: ["rooftop","gym","restaurant","bar"] },
        { name: "Pod Hotel Brooklyn", stars: 3, price: 129, rating: 4.1, reviews: 4523, amenities: ["wifi","rooftop","coffee"] },
        { name: "Marriott Marquis", stars: 4, price: 359, rating: 4.4, reviews: 5678, amenities: ["pool","gym","restaurant","concierge"] },
      ];
      commandCenter.data.hotels = hotelData.map(h => ({
        id: generateId(), name: h.name, location: city, stars: h.stars,
        pricePerNight: h.price, currency: "USD", amenities: h.amenities,
        rating: h.rating, reviewCount: h.reviews, selected: false,
      }));
      if (!commandCenter.activeModules.includes("hotels" as any)) commandCenter.activeModules.push("hotels" as any);
      commandCenter.status = "awaiting_user";
      commandCenter.statusMessage = "Found " + commandCenter.data.hotels.length + " hotels in " + city;
      commandCenter.lastUpdated = now();
      bumpVersion();
      return { content: [{ type: "text", text: "Found " + commandCenter.data.hotels.length + " hotels in " + city + "." }] };
    },
    plan_trip: async (args) => {
      if (process.env.DEMO_MODE !== "1") {
        return { content: [{ type: "text", text: "plan_trip is only available in demo mode (DEMO_MODE=1)." }] };
      }
      const destination = (args.destination as string) || "NYC";
      const departure = (args.from as string) || "SFO";
      const travelDate = (args.date as string) || new Date(Date.now() + 7 * 86400_000).toISOString().split("T")[0];
      const ts = now();

      // ── Agent Coordination ──
      workspace.agents.clear();
      workspace.locks.clear();
      const chatgptAgent: Agent = { id: "agent-chatgpt", name: "ChatGPT Orchestrator", client: "chatgpt", role: "planner", status: "working", currentTask: "Reading inbox", joinedAt: ts, lastSeen: ts, autonomous: true };
      const claudeAgent: Agent = { id: "agent-claude", name: "Claude Price Analyst", client: "claude", role: "backend", status: "working", currentTask: `Searching ${departure}→${destination} flights`, joinedAt: ts, lastSeen: ts, autonomous: true };
      const cursorAgent: Agent = { id: "agent-cursor", name: "Cursor Hotel Scout", client: "cursor", role: "frontend", status: "idle", joinedAt: ts, lastSeen: ts, autonomous: true };
      workspace.agents.set(chatgptAgent.id, chatgptAgent);
      workspace.agents.set(claudeAgent.id, claudeAgent);
      workspace.agents.set(cursorAgent.id, cursorAgent);
      workspace.target = `Trip: ${departure} → ${destination}`;
      workspace.workQueue = [
        { id: generateId(), description: "Read inbox and detect travel context", forRole: "any", createdBy: "ChatGPT Orchestrator", createdAt: ts, assignedTo: chatgptAgent.id, status: "completed" },
        { id: generateId(), description: `Search flights ${departure} → ${destination}`, forRole: "backend", createdBy: "ChatGPT Orchestrator", createdAt: ts, assignedTo: claudeAgent.id, status: "completed" },
        { id: generateId(), description: `Search hotels in ${destination}`, forRole: "frontend", createdBy: "ChatGPT Orchestrator", createdAt: ts, assignedTo: cursorAgent.id, status: "completed" },
        { id: generateId(), description: "Sync calendar with meeting", forRole: "any", createdBy: "ChatGPT Orchestrator", createdAt: ts, status: "completed" },
      ];
      workspace.intents = [
        { id: generateId(), agentId: chatgptAgent.id, agentName: "ChatGPT Orchestrator", client: "chatgpt", action: "target_set", description: `Trip: ${departure}→${destination}`, timestamp: ts },
        { id: generateId(), agentId: chatgptAgent.id, agentName: "ChatGPT Orchestrator", client: "chatgpt", action: "completed", description: `Inbox scanned: detected ${destination} meeting`, timestamp: ts + 300 },
        { id: generateId(), agentId: claudeAgent.id, agentName: "Claude Price Analyst", client: "claude", action: "completed", description: "Found 5 flights, cheapest $179", timestamp: ts + 700 },
        { id: generateId(), agentId: claudeAgent.id, agentName: "Claude Price Analyst", client: "claude", action: "handoff", description: "Flight data ready → hotel search", target: "frontend", timestamp: ts + 800 },
        { id: generateId(), agentId: cursorAgent.id, agentName: "Cursor Hotel Scout", client: "cursor", action: "completed", description: `Found 4 hotels in ${destination}`, timestamp: ts + 1200 },
        { id: generateId(), agentId: chatgptAgent.id, agentName: "ChatGPT Orchestrator", client: "chatgpt", action: "completed", description: "All tasks done. Awaiting user to book.", timestamp: ts + 1300 },
      ];
      chatgptAgent.status = "idle"; chatgptAgent.currentTask = undefined;
      claudeAgent.status = "idle"; claudeAgent.currentTask = undefined;
      cursorAgent.status = "idle"; cursorAgent.currentTask = undefined;
      bumpVersion();

      // ── Populate Command Center ──
      commandCenter.status = "processing";
      commandCenter.statusMessage = "Multi-agent trip planning...";
      bumpVersion();
      commandCenter.data.emails = [
        { id: generateId(), from: "sarah@acmecorp.com", subject: `Team dinner in ${destination} this Friday!`,
          preview: `Hey! We're having a team dinner in ${destination} on Friday (${travelDate}). Would love for you to join — can you book a flight and hotel?`, date: new Date().toISOString(), read: false, starred: true, labels: ["urgent","travel"] },
        { id: generateId(), from: "travel@kayak.com", subject: `Price Alert: ${departure} → ${destination} $189`,
          preview: "Prices dropped 42% for your saved route.", date: new Date(Date.now() - 3600_000).toISOString(), read: false, starred: false, labels: ["travel"] },
        { id: generateId(), from: "sarah@acme.com", subject: "Q1 Board Deck — Final Review",
          preview: "Please review the final deck before tomorrow's meeting.", date: new Date(Date.now() - 7200_000).toISOString(), read: false, starred: true, labels: ["finance"] },
        { id: generateId(), from: "mike@eng.team", subject: "Re: Database migration plan",
          preview: "Let's do the migration this Saturday.", date: new Date(Date.now() - 10800_000).toISOString(), read: true, starred: false, labels: ["engineering"] },
      ];
      if (!commandCenter.activeModules.includes("email")) commandCenter.activeModules.push("email");
      // Flights
      const airlines = ["United","Delta","JetBlue","American","Alaska"];
      const prices = [189,214,247,179,299];
      commandCenter.data.flights = airlines.map((a,i) => ({
        id: generateId(), airline: a, flightNo: a.substring(0,2).toUpperCase()+String(1000+Math.floor(Math.random()*9000)),
        from: departure, to: destination, departure: ["06:00","08:30","11:15","14:00","17:45"][i], arrival: ["14:25","17:00","19:30","22:45","01:55+1"][i],
        price: prices[i], currency: "USD", stops: [0,1,0,1,0][i], selected: false,
      }));
      if (!commandCenter.activeModules.includes("travel")) commandCenter.activeModules.push("travel");
      // Hotels
      const hotelList = [
        { name: "The Greenwich Hotel", stars: 5, price: 495, rating: 4.8, reviews: 2341, amenities: ["spa","pool"] },
        { name: "Hyatt Place Downtown", stars: 3, price: 189, rating: 4.3, reviews: 1856, amenities: ["gym","breakfast"] },
        { name: "Pod Hotel Brooklyn", stars: 3, price: 129, rating: 4.1, reviews: 4523, amenities: ["wifi","rooftop"] },
        { name: "Marriott Marquis", stars: 4, price: 359, rating: 4.4, reviews: 5678, amenities: ["pool","gym","concierge"] },
      ];
      commandCenter.data.hotels = hotelList.map(h => ({
        id: generateId(), name: h.name, location: destination, stars: h.stars,
        pricePerNight: h.price, currency: "USD", amenities: h.amenities,
        rating: h.rating, reviewCount: h.reviews, selected: false,
      }));
      if (!commandCenter.activeModules.includes("hotels" as any)) commandCenter.activeModules.push("hotels" as any);
      // Calendar
      const todayStr = new Date().toISOString().split("T")[0];
      commandCenter.data.events = [
        { id: generateId(), title: `Team Dinner @ The Smith`, date: travelDate, time: "19:00", duration: "2h", location: `The Smith, Midtown ${destination}`, attendees: ["Sarah", "Team", "You"], color: "#f97316" },
        { id: generateId(), title: "Team Dinner", date: todayStr, time: "19:00", duration: "2h", location: "Nopa, SF", color: "#22c55e" },
      ];
      if (!commandCenter.activeModules.includes("calendar")) commandCenter.activeModules.push("calendar");
      commandCenter.status = "awaiting_user";
      commandCenter.statusMessage = "Trip planned! Select flight and hotel to book.";
      commandCenter.lastUpdated = now();
      commandCenter.actions = [
        { id: generateId(), module: "email", label: "Inbox Scanned", description: "ChatGPT read inbox", status: "done", timestamp: ts },
        { id: generateId(), module: "travel", label: "Flights Found", description: "Claude: 5 flights", status: "done", timestamp: ts + 600 },
        { id: generateId(), module: "hotels" as any, label: "Hotels Found", description: "Cursor: 4 hotels", status: "done", timestamp: ts + 1100 },
      ];
      bumpVersion();
      return { content: [{ type: "text", text: "NEXT: Call the command-center tool immediately to display the interactive widget.\n\nMulti-agent trip planning complete!\n\nAgents coordinated:\n  ChatGPT Orchestrator — scanned inbox, detected " + destination + " meeting\n  Claude Price Analyst — found 5 flights (cheapest: $179)\n  Cursor Hotel Scout — found 4 hotels\n\nAll modules visible in Command Center. User can book directly." }] };
    },
    find_options: async (args) => {
      if (process.env.DEMO_MODE !== "1") {
        return { content: [{ type: "text", text: "find_options is only available in demo mode (DEMO_MODE=1)." }] };
      }
      const from = (args.from as string) || "SFO";
      const to = (args.to as string) || "NYC";
      commandCenter.status = "processing";
      commandCenter.statusMessage = "Searching flights " + from + " → " + to + "...";
      bumpVersion();
      const airlines = ["United","Delta","JetBlue","American","Alaska"];
      const prices = [189,214,247,179,299];
      const stops = [0,1,0,1,0];
      const deps = ["06:00","08:30","11:15","14:00","17:45"];
      const arrs = ["14:25","17:00","19:30","22:45","01:55+1"];
      commandCenter.data.flights = airlines.map((a,i) => ({
        id: generateId(), airline: a, flightNo: a.substring(0,2).toUpperCase()+String(1000+Math.floor(Math.random()*9000)),
        from, to, departure: deps[i], arrival: arrs[i], price: prices[i], currency: "USD", stops: stops[i], selected: false,
      }));
      if (!commandCenter.activeModules.includes("travel")) commandCenter.activeModules.push("travel");
      commandCenter.status = "awaiting_user";
      commandCenter.statusMessage = "Found " + commandCenter.data.flights.length + " flights. Select one to book.";
      commandCenter.lastUpdated = now();
      bumpVersion();
      return { content: [{ type: "text", text: "Found " + commandCenter.data.flights.length + " flights from " + from + " to " + to + "." }] };
    },
    // ── Meeting Prep tools (REST fallback so widget works outside ChatGPT) ──
    get_meeting_kit: async () => {
      return { content: [{ type: "text", text: JSON.stringify(meetingKit) }] };
    },
    update_meeting_context: async (args) => {
      const current = meetingKit.context;
      meetingKit.context = {
        ...current,
        companyOrFirm:        (args.companyOrFirm        as string) ?? current.companyOrFirm,
        meetingGoal:          (args.meetingGoal           as string) ?? current.meetingGoal,
        date:                 (args.date                  as string) ?? current.date,
        time:                 (args.time                  as string) ?? current.time,
        timezone:             (args.timezone              as string) ?? current.timezone,
        locationOrLink:       (args.locationOrLink        as string) ?? current.locationOrLink,
        timeboxMinutes:       (args.timeboxMinutes         as any)   ?? current.timeboxMinutes,
        yourProductOneLiner:  (args.yourProductOneLiner   as string) ?? current.yourProductOneLiner,
        stage:                (args.stage                 as string) ?? current.stage,
        raiseTarget:          (args.raiseTarget           as string) ?? current.raiseTarget,
        people: args.people_csv
          ? (args.people_csv as string).split(",").map((s: string) => s.trim()).filter(Boolean)
          : current.people,
        version: current.version + 1,
      };
      meetingKit.lastUpdated = now();
      bumpVersion();
      return { content: [{ type: "text", text: "Meeting context updated." }] };
    },
    generate_meeting_kit: async () => {
      const ctx = meetingKit.context;
      if (!ctx?.companyOrFirm) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Set companyOrFirm first via update_meeting_context." }) }] };
      }
      meetingKit.status = "ready";
      meetingKit.statusMessage = "Kit generated.";
      meetingKit.lastUpdated = now();
      bumpVersion();
      return { content: [{ type: "text", text: `Kit for ${ctx.companyOrFirm} ready.` }] };
    },
    extract_meeting_context: async (args) => {
      const emailId = args.email_id as string;
      if (!emailId) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "email_id is required. Provide the ID of the email to extract context from." }) }] };
      }
      const companyOrFirm = (args.companyOrFirm as string) || meetingKit.context.companyOrFirm;
      if (!companyOrFirm) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "companyOrFirm is required. Provide the company or firm name." }) }] };
      }
      meetingKit.context = {
        ...meetingKit.context,
        companyOrFirm,
        meetingGoal: (args.meetingGoal as string) || meetingKit.context.meetingGoal || "Investor meeting",
        version: meetingKit.context.version + 1,
        sourceEmail: { id: emailId },
      };
      meetingKit.meeting.emailId = emailId;
      meetingKit.status = "preparing";
      meetingKit.statusMessage = "Context extracted. Edit fields and generate the kit.";
      meetingKit.lastUpdated = now();
      bumpVersion();
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, companyOrFirm: meetingKit.context.companyOrFirm }) }] };
    },
    gmail_create_draft: async (args) => {
      const to = (args.to as string) || meetingKit.meeting.emailFrom || "";
      const subject = (args.subject as string) || (meetingKit.meeting.emailSubject ? `Re: ${meetingKit.meeting.emailSubject}` : `Meeting Confirmation — ${meetingKit.meeting.company}`);
      if (!to) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "No recipient address. Connect Gmail via OAuth or provide a 'to' address." }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ error: "Gmail OAuth not connected. Use the MCP tool gmail_create_draft with an authenticated session to create a real draft.", to, subject }) }] };
    },
    rerun_meeting_kit: async (args) => {
      const sectionIds: string[] = (args.section_ids as string[]) || [];
      if (sectionIds.length === 0) return { content: [{ type: "text", text: "Provide at least one section_id." }] };
      for (const id of sectionIds) {
        const sec = meetingKit.sections.find(s => s.id === id);
        if (sec) {
          sec.status = "done";
          sec.content = `Re-ran section: ${id}`;
          sec.updatedAt = now();
          sec.cached = false;
        }
      }
      meetingKit.lastUpdated = now();
      bumpVersion();
      return { content: [{ type: "text", text: `Re-ran ${sectionIds.length} section(s): ${sectionIds.join(", ")}` }] };
    },
    update_meeting_section: async (args) => {
      const sectionId = args.section_id as string;
      const sec = meetingKit.sections.find(s => s.id === sectionId);
      if (!sec) return { content: [{ type: "text", text: `Section "${sectionId}" not found.` }] };
      sec.content = (args.content as string) || sec.content;
      if (args.bullets) sec.bullets = args.bullets as string[];
      sec.status = "done";
      sec.cached = false;
      sec.updatedAt = now();
      meetingKit.lastUpdated = now();
      bumpVersion();
      return { content: [{ type: "text", text: `Updated "${sec.title}" with new content.` }] };
    },
  };
}
