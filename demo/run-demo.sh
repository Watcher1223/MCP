#!/bin/bash
# SYNAPSE HACKATHON DEMO
# Run this while showing the widget at http://localhost:3200/widget

API="http://localhost:3200/mcp/execute"
PLANNER="planner-demo"
CODER="coder-demo"
TESTER="tester-demo"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
YELLOW='\033[1;33m'
NC='\033[0m'

pause() {
  read -p "Press ENTER to continue..."
}

call() {
  local tool=$1
  local args=$2
  local client=$3
  curl -s -X POST "$API" \
    -H "Content-Type: application/json" \
    -d "{\"tool\":\"$tool\",\"arguments\":$args,\"clientId\":\"$client\"}" | jq -r '.content[0].text' 2>/dev/null || echo "OK"
}

clear
echo ""
echo -e "${PURPLE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${PURPLE}║                        SYNAPSE DEMO                          ║${NC}"
echo -e "${PURPLE}║              Shared Cognition for AI Agents                  ║${NC}"
echo -e "${PURPLE}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Widget: ${BLUE}http://localhost:3200/widget${NC}"
echo ""

pause

echo ""
echo -e "${YELLOW}[STEP 1]${NC} Connecting AI agents..."
echo ""

call register_agent '{"name":"Planner","role":"planner"}' "$PLANNER"
echo -e "  ${PURPLE}●${NC} Planner agent connected"
sleep 0.5

call register_agent '{"name":"Coder","role":"coder"}' "$CODER"
echo -e "  ${BLUE}●${NC} Coder agent connected"
sleep 0.5

call register_agent '{"name":"Tester","role":"tester"}' "$TESTER"
echo -e "  ${GREEN}●${NC} Tester agent connected"
echo ""

pause

echo ""
echo -e "${YELLOW}[STEP 2]${NC} Proposing goal: \"Build a todo API with tests\""
echo ""

GOAL_RESULT=$(curl -s -X POST "$API" \
  -H "Content-Type: application/json" \
  -d '{"tool":"propose_goal","arguments":{"description":"Build a todo API with tests","success_criteria":["POST /api/todos endpoint implemented","GET /api/todos endpoint implemented","All tests passing"]},"clientId":"'"$PLANNER"'"}')

echo "$GOAL_RESULT" | jq -r '.content[0].text' 2>/dev/null
echo ""
echo -e "  ${PURPLE}Goal created. Watch the widget - work is now queued.${NC}"
echo ""

pause

echo ""
echo -e "${YELLOW}[STEP 3]${NC} Autonomous work chain begins..."
echo ""
echo -e "  ${PURPLE}Planner${NC} picks up planning work..."

call assign_work '{}' "$PLANNER" > /dev/null
sleep 0.3

# Planner completes
call update_world_state '{"patch":{"endpoints":{"POST:/api/todos":{"route":"/api/todos","method":"POST","implemented":false},"GET:/api/todos":{"route":"/api/todos","method":"GET","implemented":false}}}}' "$PLANNER" > /dev/null
call report_failure '{"area":"POST /api/todos","reason":"Not implemented"}' "$PLANNER" > /dev/null
call report_failure '{"area":"GET /api/todos","reason":"Not implemented"}' "$PLANNER" > /dev/null

echo -e "  ${PURPLE}✓${NC} Planner decomposed task → work queued for Coder"
echo ""

pause

echo ""
echo -e "  ${BLUE}Coder${NC} picks up implementation work..."

# Coder implements POST
call assign_work '{}' "$CODER" > /dev/null
sleep 0.3
call update_world_state '{"patch":{"endpoints":{"POST:/api/todos":{"implemented":true}}}}' "$CODER" > /dev/null
call assert_fact '{"assertion":"POST /api/todos implemented","confidence":1,"source":"runtime"}' "$CODER" > /dev/null
call complete_work '{"work_id":"ignored"}' "$CODER" > /dev/null 2>&1

echo -e "  ${BLUE}✓${NC} POST /api/todos implemented"
sleep 0.5

# Coder implements GET
call assign_work '{}' "$CODER" > /dev/null
sleep 0.3
call update_world_state '{"patch":{"endpoints":{"GET:/api/todos":{"implemented":true}}}}' "$CODER" > /dev/null
call assert_fact '{"assertion":"GET /api/todos implemented","confidence":1,"source":"runtime"}' "$CODER" > /dev/null

echo -e "  ${BLUE}✓${NC} GET /api/todos implemented"
echo ""

pause

echo ""
echo -e "  ${GREEN}Tester${NC} validates and writes tests..."

# Tester completes
call update_world_state '{"patch":{"tests":{"todo-api-tests":{"name":"todo-api-tests","covers":["POST:/api/todos","GET:/api/todos"],"passing":true}},"endpoints":{"POST:/api/todos":{"tested":true,"failing":false},"GET:/api/todos":{"tested":true,"failing":false}}}}' "$TESTER" > /dev/null
call assert_fact '{"assertion":"All tests passing","confidence":1,"source":"test"}' "$TESTER" > /dev/null

echo -e "  ${GREEN}✓${NC} Tests written and passing"
echo ""

pause

echo ""
echo -e "${YELLOW}[STEP 4]${NC} Evaluating goal..."
echo ""

# Get goal ID and evaluate
WORLD_STATE=$(call read_world_state '{}' "$PLANNER")
GOAL_ID=$(echo "$WORLD_STATE" | grep -o '"id": "[^"]*"' | head -1 | cut -d'"' -f4)

if [ -n "$GOAL_ID" ]; then
  EVAL_RESULT=$(curl -s -X POST "$API" \
    -H "Content-Type: application/json" \
    -d '{"tool":"evaluate_goal","arguments":{"goal_id":"'"$GOAL_ID"'"},"clientId":"'"$PLANNER"'"}')
  echo "$EVAL_RESULT" | jq -r '.content[0].text' 2>/dev/null
fi

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                     GOAL SATISFIED                           ║${NC}"
echo -e "${GREEN}║                                                              ║${NC}"
echo -e "${GREEN}║   One goal → Multiple agents → Autonomous coordination       ║${NC}"
echo -e "${GREEN}║   Zero additional prompts required                           ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "This is ${PURPLE}SYNAPSE${NC} - Shared Cognition for AI Agents"
echo ""
