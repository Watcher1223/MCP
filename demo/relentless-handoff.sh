#!/bin/bash
# RELENTLESS HANDOFF DEMO - ChatGPT → Claude → Cursor
# Run: npm run mcp (or npm run dev)
# Open http://localhost:3201/ in browser to watch the dashboard

API="http://localhost:3201/mcp/execute"
call() {
  curl -s -X POST "$API" -H "Content-Type: application/json" -d "$1" | jq -r '.content[0].text' 2>/dev/null || echo "(no jq)"
}

echo "=== RELENTLESS HANDOFF DEMO ==="
echo "Dashboard: http://localhost:3201/"
echo ""

# 1. ChatGPT joins and sets target
echo "[1] ChatGPT: join + set_target('Login page')"
call '{"tool":"join_workspace","arguments":{"name":"ChatGPT Planner","client":"chatgpt","role":"planner"},"clientId":"chatgpt-1"}'
call '{"tool":"set_target","arguments":{"target":"Login page"},"clientId":"chatgpt-1"}'
sleep 0.5

# 2. Claude joins, polls, gets backend work
echo "[2] Claude: join_workspace + poll_work(backend)"
call '{"tool":"join_workspace","arguments":{"name":"Claude Backend","client":"claude","role":"backend"},"clientId":"claude-1"}'
WORK=$(call '{"tool":"poll_work","arguments":{"role":"backend"},"clientId":"claude-1"}')
echo "   -> $WORK"
WORK_ID=$(echo "$WORK" | jq -r '.work.id' 2>/dev/null)
sleep 0.5

# 3. Claude locks auth.ts, creates a doc session, implements
echo "[3] Claude: lock_file + create_doc(src/auth.ts)"
call '{"tool":"lock_file","arguments":{"path":"src/auth.ts","reason":"Implementing POST /login"},"clientId":"claude-1"}'
call '{"tool":"create_doc","arguments":{"path":"src/auth.ts","initial_content":"// POST /login endpoint\nimport express from '\''express'\'';\n"}}'
sleep 0.5

# 4. Claude completes, unlocks, hands off
echo "[4] Claude: complete_work + unlock_file (handoff to frontend)"
call "{\"tool\":\"complete_work\",\"arguments\":{\"work_id\":\"$WORK_ID\",\"result\":\"Created POST /login API\",\"handoff_context\":{\"api_endpoint\":\"/login\",\"expects\":\"email, password\"}},\"clientId\":\"claude-1\"}"
call '{"tool":"unlock_file","arguments":{"path":"src/auth.ts","handoff_to":"frontend","message":"API ready at /login. Expects email/pass."},"clientId":"claude-1"}'
sleep 0.5

# 5. Cursor joins, polls frontend work
echo "[5] Cursor: join_workspace + poll_work(frontend)"
call '{"tool":"join_workspace","arguments":{"name":"Cursor Frontend","client":"cursor","role":"frontend"},"clientId":"cursor-1"}'
WORK2=$(call '{"tool":"poll_work","arguments":{"role":"frontend"},"clientId":"cursor-1"}')
echo "   -> $WORK2"
sleep 0.5

# 6. Cursor posts intent
echo "[6] Cursor: post_intent (picking up)"
call '{"tool":"post_intent","arguments":{"action":"working","description":"Building Login Form UI with API spec from Claude"},"clientId":"cursor-1"}'

echo ""
echo "=== DONE - Check http://localhost:3201/ ==="
echo "   Doc session 'src/auth.ts' visible in Collaborative Editing panel"
echo "   All 3 agents visible in the dashboard"
