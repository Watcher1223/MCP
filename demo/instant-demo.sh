#!/bin/bash
# SYNAPSE INSTANT DEMO - Runs the full autonomous chain automatically
# Open http://localhost:3200/widget in browser first!

API="http://localhost:3200/mcp/execute"

call() {
  curl -s -X POST "$API" -H "Content-Type: application/json" -d "$1" | jq -r '.content[0].text' 2>/dev/null
}

echo "=== SYNAPSE DEMO ==="
echo ""

# Register agents
echo "[1/5] Connecting agents..."
call '{"tool":"register_agent","arguments":{"name":"Planner","role":"planner"},"clientId":"planner-1"}'
call '{"tool":"register_agent","arguments":{"name":"Coder","role":"coder"},"clientId":"coder-1"}'
call '{"tool":"register_agent","arguments":{"name":"Tester","role":"tester"},"clientId":"tester-1"}'

sleep 0.5

# Propose goal
echo "[2/5] Proposing goal..."
call '{"tool":"propose_goal","arguments":{"description":"Build a todo API with tests","success_criteria":["POST /api/todos implemented","GET /api/todos implemented","Tests passing"]},"clientId":"planner-1"}'

sleep 0.5

# Planner work
echo "[3/5] Planner decomposing task..."
call '{"tool":"assign_work","arguments":{},"clientId":"planner-1"}'
call '{"tool":"update_world_state","arguments":{"patch":{"endpoints":{"POST:/api/todos":{"route":"/api/todos","method":"POST","implemented":false},"GET:/api/todos":{"route":"/api/todos","method":"GET","implemented":false}}}},"clientId":"planner-1"}'
call '{"tool":"report_failure","arguments":{"area":"POST /api/todos","reason":"Not implemented"},"clientId":"planner-1"}'
call '{"tool":"report_failure","arguments":{"area":"GET /api/todos","reason":"Not implemented"},"clientId":"planner-1"}'

sleep 0.5

# Coder work
echo "[4/5] Coder implementing..."
call '{"tool":"assign_work","arguments":{},"clientId":"coder-1"}'
call '{"tool":"update_world_state","arguments":{"patch":{"endpoints":{"POST:/api/todos":{"implemented":true}}}},"clientId":"coder-1"}'
call '{"tool":"assign_work","arguments":{},"clientId":"coder-1"}'
call '{"tool":"update_world_state","arguments":{"patch":{"endpoints":{"GET:/api/todos":{"implemented":true}}}},"clientId":"coder-1"}'

sleep 0.5

# Tester work
echo "[5/5] Tester validating..."
call '{"tool":"update_world_state","arguments":{"patch":{"tests":{"todo-tests":{"name":"todo-tests","covers":["POST:/api/todos","GET:/api/todos"],"passing":true}},"endpoints":{"POST:/api/todos":{"tested":true,"failing":false},"GET:/api/todos":{"tested":true,"failing":false}}}},"clientId":"tester-1"}'
call '{"tool":"assert_fact","arguments":{"assertion":"All tests passing","confidence":1,"source":"test"},"clientId":"tester-1"}'

sleep 0.3

# Check result
echo ""
echo "=== RESULT ==="
call '{"tool":"read_world_state","arguments":{},"clientId":"planner-1"}' | grep -E '"status"|"satisfied"|"progress"'

echo ""
echo "DEMO COMPLETE - Check the widget!"
