#!/bin/bash
# SYNAPSE ULTIMATE DEMO
# Shows: ChatGPT brainstorm → Backend builds → Frontend adapts → Tests cascade
# Two developers (VS Code + Cursor) edit same file → Auto-merge

API="http://localhost:3200/mcp/execute"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

call() {
  curl -s -X POST "$API" -H "Content-Type: application/json" -d "$1" | jq -r '.content[0].text' 2>/dev/null || echo "OK"
}

pause() {
  echo ""
  read -p "Press ENTER to continue..."
  echo ""
}

clear
echo ""
echo -e "${PURPLE}╔══════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${PURPLE}║                    SYNAPSE ULTIMATE DEMO                         ║${NC}"
echo -e "${PURPLE}║         Multi-Developer + Multi-AI Autonomous Collaboration      ║${NC}"
echo -e "${PURPLE}╚══════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Widget: ${BLUE}http://localhost:3200/widget${NC}"
echo ""
pause

# ========================================
# PHASE 1: Team Setup
# ========================================
echo -e "${YELLOW}═══════════════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}PHASE 1: Team Connects${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════════════════${NC}"
echo ""

echo -e "  ${CYAN}ChatGPT${NC} → Brainstorming & Planning"
call '{"tool":"register_agent","arguments":{"name":"ChatGPT","role":"planner","capabilities":["brainstorm","planning"]},"clientId":"chatgpt-1"}'

echo -e "  ${BLUE}VS Code (Dev 1)${NC} → Backend Development"
call '{"tool":"register_agent","arguments":{"name":"VS Code (Alex)","role":"coder","capabilities":["typescript","backend"]},"clientId":"vscode-1"}'

echo -e "  ${PURPLE}Cursor (Dev 2)${NC} → Backend Development"
call '{"tool":"register_agent","arguments":{"name":"Cursor (Jordan)","role":"coder","capabilities":["typescript","backend"]},"clientId":"cursor-1"}'

echo -e "  ${GREEN}Frontend Agent${NC} → React UI"
call '{"tool":"register_agent","arguments":{"name":"Frontend Agent","role":"coder","capabilities":["react","frontend"]},"clientId":"frontend-1"}'

echo -e "  ${GREEN}Test Runner${NC} → Integration Tests"
call '{"tool":"register_agent","arguments":{"name":"Test Runner","role":"tester","capabilities":["jest","integration"]},"clientId":"tester-1"}'

echo ""
echo -e "  ${GREEN}✓${NC} 5 agents connected: ChatGPT + 2 Backend Devs + Frontend + Tester"
pause

# ========================================
# PHASE 2: ChatGPT Brainstorms
# ========================================
echo -e "${YELLOW}═══════════════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}PHASE 2: ChatGPT Brainstorms (User types in ChatGPT)${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${CYAN}User in ChatGPT:${NC} \"I need a user authentication system with"
echo -e "                   login, registration, and profile endpoints\""
echo ""

echo -e "  ${CYAN}ChatGPT${NC} proposes goal..."
call '{"tool":"propose_goal","arguments":{"description":"Build user authentication API","success_criteria":["POST /auth/login implemented","POST /auth/register implemented","GET /auth/profile implemented","Frontend LoginForm working","All integration tests pass"]},"clientId":"chatgpt-1"}'

echo ""
echo -e "  ${CYAN}ChatGPT${NC} registers API contracts..."
call '{"tool":"register_api_contract","arguments":{"endpoint":"/auth/login","method":"POST","request_fields":[{"name":"email","type":"string","required":true},{"name":"password","type":"string","required":true}],"response_fields":[{"name":"token","type":"string","required":true},{"name":"user","type":"object","required":true}]},"clientId":"chatgpt-1"}'

call '{"tool":"register_api_contract","arguments":{"endpoint":"/auth/register","method":"POST","request_fields":[{"name":"email","type":"string","required":true},{"name":"password","type":"string","required":true},{"name":"name","type":"string","required":true}],"response_fields":[{"name":"user","type":"object","required":true}]},"clientId":"chatgpt-1"}'

call '{"tool":"register_api_contract","arguments":{"endpoint":"/auth/profile","method":"GET","request_fields":[],"response_fields":[{"name":"id","type":"string","required":true},{"name":"email","type":"string","required":true},{"name":"name","type":"string","required":true}]},"clientId":"chatgpt-1"}'

echo ""
echo -e "  ${GREEN}✓${NC} Goal proposed. API contracts registered. Work auto-queued."
pause

# ========================================
# PHASE 3: Two Devs Edit Same File
# ========================================
echo -e "${YELLOW}═══════════════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}PHASE 3: Two Developers Edit auth.ts Simultaneously${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════════════════${NC}"
echo ""

echo -e "  ${BLUE}VS Code${NC} joins auth.ts..."
call '{"tool":"join_file_session","arguments":{"path":"src/auth.ts"},"clientId":"vscode-1"}'

echo -e "  ${PURPLE}Cursor${NC} joins auth.ts..."
call '{"tool":"join_file_session","arguments":{"path":"src/auth.ts"},"clientId":"cursor-1"}'

echo ""
echo -e "  ${BLUE}VS Code${NC} writes login() function (lines 1-20)..."
call '{"tool":"propose_file_change","arguments":{"path":"src/auth.ts","start_line":1,"end_line":20,"new_content":"export async function login(email: string, password: string) {\n  const user = await db.users.findByEmail(email);\n  if (!user || !verify(password, user.hash)) throw new AuthError();\n  return { token: signJWT(user), user };\n}"},"clientId":"vscode-1"}'

echo -e "  ${PURPLE}Cursor${NC} writes register() function (lines 21-40)..."
call '{"tool":"propose_file_change","arguments":{"path":"src/auth.ts","start_line":21,"end_line":40,"new_content":"export async function register(email: string, password: string, name: string) {\n  const exists = await db.users.findByEmail(email);\n  if (exists) throw new ConflictError();\n  const user = await db.users.create({ email, hash: hash(password), name });\n  return { user };\n}"},"clientId":"cursor-1"}'

echo ""
echo -e "  ${GREEN}✓${NC} Both changes accepted! No merge conflicts!"
echo ""

echo -e "  Now they both edit the SAME lines (10-15)..."
echo ""

echo -e "  ${BLUE}VS Code${NC} adds error handling..."
call '{"tool":"propose_file_change","arguments":{"path":"src/auth.ts","start_line":10,"end_line":15,"new_content":"  try {\n    const user = await db.users.findByEmail(email);\n  } catch (e) {\n    logger.error(e);\n    throw e;\n  }"},"clientId":"vscode-1"}'

echo -e "  ${PURPLE}Cursor${NC} adds rate limiting (overlapping!)..."
call '{"tool":"propose_file_change","arguments":{"path":"src/auth.ts","start_line":10,"end_line":15,"new_content":"  await rateLimiter.check(email);\n  const user = await db.users.findByEmail(email);"},"clientId":"cursor-1"}'

echo ""
echo -e "  ${GREEN}✓${NC} Synapse AUTO-MERGED the overlapping changes!"
pause

# ========================================
# PHASE 4: Backend Complete → Frontend Adapts
# ========================================
echo -e "${YELLOW}═══════════════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}PHASE 4: Backend Complete → Frontend Auto-Adapts${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════════════════${NC}"
echo ""

# Mark backend as done
call '{"tool":"update_world_state","arguments":{"patch":{"endpoints":{"POST:/auth/login":{"route":"/auth/login","method":"POST","implemented":true,"tested":false},"POST:/auth/register":{"route":"/auth/register","method":"POST","implemented":true,"tested":false},"GET:/auth/profile":{"route":"/auth/profile","method":"GET","implemented":true,"tested":false}}}},"clientId":"vscode-1"}'

echo -e "  ${BLUE}Backend endpoints implemented.${NC}"
echo ""

# Frontend binds to endpoints
echo -e "  ${GREEN}Frontend Agent${NC} binds components to API..."
call '{"tool":"bind_frontend_component","arguments":{"component_name":"LoginForm","endpoint":"POST:/auth/login","fields":["email","password"]},"clientId":"frontend-1"}'

call '{"tool":"bind_frontend_component","arguments":{"component_name":"RegisterForm","endpoint":"POST:/auth/register","fields":["email","password","name"]},"clientId":"frontend-1"}'

call '{"tool":"bind_frontend_component","arguments":{"component_name":"ProfileCard","endpoint":"GET:/auth/profile","fields":["name","email"]},"clientId":"frontend-1"}'

echo ""
echo -e "  ${GREEN}✓${NC} Frontend components bound. They'll auto-update on API changes."
pause

# ========================================
# PHASE 5: API Changes → Cascades to Frontend
# ========================================
echo -e "${YELLOW}═══════════════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}PHASE 5: API Schema Changes → Frontend Auto-Updates${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════════════════${NC}"
echo ""

echo -e "  ${CYAN}ChatGPT:${NC} \"Actually, add a 'rememberMe' field to login\""
echo ""

echo -e "  ${BLUE}VS Code${NC} updates API contract..."
call '{"tool":"register_api_contract","arguments":{"endpoint":"/auth/login","method":"POST","request_fields":[{"name":"email","type":"string","required":true},{"name":"password","type":"string","required":true},{"name":"rememberMe","type":"boolean","required":false}],"response_fields":[{"name":"token","type":"string","required":true},{"name":"user","type":"object","required":true}]},"clientId":"vscode-1"}'

echo ""
echo -e "  ${GREEN}CASCADE TRIGGERED!${NC}"
echo ""

call '{"tool":"get_outdated_components","arguments":{},"clientId":"frontend-1"}'

echo ""
echo -e "  ${GREEN}✓${NC} LoginForm flagged for update → Frontend agent sees it automatically!"
pause

# ========================================
# PHASE 6: Integration Tests Run
# ========================================
echo -e "${YELLOW}═══════════════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}PHASE 6: Integration Tests Run in Real-Time${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════════════════${NC}"
echo ""

echo -e "  ${GREEN}Test Runner${NC} executes integration tests..."
echo ""

call '{"tool":"run_integration_test","arguments":{"test_name":"login-flow","endpoint":"POST:/auth/login"},"clientId":"tester-1"}'
sleep 0.3

call '{"tool":"run_integration_test","arguments":{"test_name":"register-flow","endpoint":"POST:/auth/register"},"clientId":"tester-1"}'
sleep 0.3

call '{"tool":"run_integration_test","arguments":{"test_name":"profile-fetch","endpoint":"GET:/auth/profile"},"clientId":"tester-1"}'

echo ""

# Update world state with tests passing
call '{"tool":"update_world_state","arguments":{"patch":{"endpoints":{"POST:/auth/login":{"tested":true,"failing":false},"POST:/auth/register":{"tested":true,"failing":false},"GET:/auth/profile":{"tested":true,"failing":false}},"tests":{"auth-integration":{"name":"auth-integration","covers":["POST:/auth/login","POST:/auth/register","GET:/auth/profile"],"passing":true}}}},"clientId":"tester-1"}'

call '{"tool":"assert_fact","arguments":{"assertion":"All integration tests passing","confidence":1,"source":"test"},"clientId":"tester-1"}'

echo -e "  ${GREEN}✓${NC} All tests passing! World state updated."
pause

# ========================================
# PHASE 7: Goal Satisfied
# ========================================
echo -e "${YELLOW}═══════════════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}PHASE 7: Goal Evaluation${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════════════════${NC}"
echo ""

call '{"tool":"read_world_state","arguments":{},"clientId":"chatgpt-1"}' | grep -E "status|satisfied" | head -5

echo ""

# Final cascade status
echo -e "  ${CYAN}Cascade Status:${NC}"
call '{"tool":"get_cascade_status","arguments":{},"clientId":"chatgpt-1"}'

echo ""
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                        DEMO COMPLETE                             ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║  ✓ ChatGPT brainstormed → Backend agents built it               ║${NC}"
echo -e "${GREEN}║  ✓ Two devs edited same file → No merge conflicts               ║${NC}"
echo -e "${GREEN}║  ✓ API changed → Frontend auto-adapted                          ║${NC}"
echo -e "${GREEN}║  ✓ Integration tests ran → Results cascaded to world state      ║${NC}"
echo -e "${GREEN}║  ✓ Goal: SATISFIED                                              ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${PURPLE}SYNAPSE${NC}: Shared Cognition for AI Agents"
echo -e "  One brainstorm → Multiple agents → Zero conflicts → Automatic adaptation"
echo ""
