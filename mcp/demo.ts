// Synapse Demo - Multi-Agent Collaboration Simulation
// Demonstrates: Planner → Backend → Frontend → Tester coordination

import { state, updateWidgetState } from "./server.js";
import { generateId, Logger } from "../shared/utils.js";

const log = new Logger("Demo");

// Simulate the 90-second demo flow
async function runDemo() {
  log.info("Starting Synapse multi-agent collaboration demo...\n");

  // Step 1: Spawn agents (simulating ChatGPT, Cursor, VSCode connections)
  log.info("=== STEP 1: Agents Connect ===");

  const planner = state.registerAgent({
    id: generateId(),
    name: "ChatGPT-PM",
    type: "realtime",
    role: "planner",
    capabilities: ["planning", "coordination", "review"],
  });
  log.info(`  ✓ ${planner.name} connected (ChatGPT)`);
  await sleep(500);

  const backend = state.registerAgent({
    id: generateId(),
    name: "Cursor-Backend",
    type: "realtime",
    role: "coder",
    capabilities: ["implementation", "api-design", "database"],
  });
  log.info(`  ✓ ${backend.name} connected (Cursor IDE)`);
  await sleep(500);

  const frontend = state.registerAgent({
    id: generateId(),
    name: "VSCode-Frontend",
    type: "realtime",
    role: "coder",
    capabilities: ["implementation", "ui-design", "react"],
  });
  log.info(`  ✓ ${frontend.name} connected (VSCode)`);
  await sleep(500);

  const tester = state.registerAgent({
    id: generateId(),
    name: "Tester-Agent",
    type: "realtime",
    role: "tester",
    capabilities: ["testing", "validation"],
  });
  log.info(`  ✓ ${tester.name} connected`);
  await sleep(1000);

  updateWidgetState();
  log.info("\n=== STEP 2: User Request (ChatGPT) ===");
  log.info('  User types: "Build a task manager with projects and tasks"\n');

  // Step 2: Planner creates task decomposition
  log.info("=== STEP 3: Planner Decomposes Work ===");

  const planIntent = state.createIntent(planner.id, {
    agentId: planner.id,
    action: "Plan: Task Manager Implementation",
    targets: ["api/", "ui/", "db/"],
    description: "Decompose task manager into backend API, frontend UI, and database schema",
    priority: 10,
    status: "active",
    dependencies: [],
  });
  log.info(`  ✓ Planner created intent: ${planIntent.action}`);
  await sleep(800);

  // Create sub-tasks
  const backendIntent = state.createIntent(planner.id, {
    agentId: planner.id,
    action: "Implement Backend API",
    targets: ["api/projects.ts", "api/tasks.ts", "db/schema.sql"],
    description: "Create REST endpoints for projects and tasks",
    priority: 8,
    status: "pending",
    dependencies: [],
  });
  log.info(`  ✓ Sub-task: ${backendIntent.action}`);

  const frontendIntent = state.createIntent(planner.id, {
    agentId: planner.id,
    action: "Build Frontend UI",
    targets: ["components/ProjectList.tsx", "components/TaskList.tsx"],
    description: "Create React components for project and task views",
    priority: 7,
    status: "pending",
    dependencies: [backendIntent.id],
  });
  log.info(`  ✓ Sub-task: ${frontendIntent.action} (depends on backend)`);
  await sleep(1000);

  updateWidgetState();

  // Step 3: Backend agent starts working
  log.info("\n=== STEP 4: Backend Agent Works ===");

  state.updateIntent(backendIntent.id, { status: "active" });
  log.info(`  ✓ Backend agent picks up: ${backendIntent.action}`);

  // Lock files
  const lockResult = state.requestLock(backend.id, {
    type: "file",
    path: "api/projects.ts",
  }, 30000, "Implementing project endpoints");
  log.info(`  ✓ Locked api/projects.ts`);
  await sleep(600);

  // Create files
  state.applyFilePatch(backend.id, {
    path: "api/projects.ts",
    operation: "create",
    content: `
export interface Project {
  id: string;
  title: string;
  description: string;
  createdAt: Date;
}

export async function createProject(data: Omit<Project, 'id' | 'createdAt'>) {
  // Implementation
}

export async function getProjects() {
  // Implementation
}
`,
  }, lockResult.lockId);
  log.info(`  ✓ Created api/projects.ts`);
  await sleep(600);

  state.applyFilePatch(backend.id, {
    path: "api/tasks.ts",
    operation: "create",
    content: `
export interface Task {
  id: string;
  projectId: string;
  title: string;
  completed: boolean;
}

export async function createTask(data: Omit<Task, 'id'>) {
  // Implementation
}
`,
  });
  log.info(`  ✓ Created api/tasks.ts`);

  state.releaseLock(lockResult.lockId!, backend.id);
  state.updateIntent(backendIntent.id, { status: "completed" });
  log.info(`  ✓ Backend completed!`);
  await sleep(1000);

  updateWidgetState();

  // Step 4: Frontend agent reacts automatically
  log.info("\n=== STEP 5: Frontend Agent Reacts ===");
  log.info("  (Frontend sees backend changes via Synapse, starts automatically)");

  state.updateIntent(frontendIntent.id, { status: "active" });

  // Frontend creates components based on backend types
  state.applyFilePatch(frontend.id, {
    path: "components/ProjectList.tsx",
    operation: "create",
    content: `
import { Project } from '../api/projects';

export function ProjectList({ projects }: { projects: Project[] }) {
  return (
    <ul>
      {projects.map(p => (
        <li key={p.id}>{p.title}</li>
      ))}
    </ul>
  );
}
`,
  });
  log.info(`  ✓ Created components/ProjectList.tsx`);
  await sleep(600);

  state.applyFilePatch(frontend.id, {
    path: "components/TaskList.tsx",
    operation: "create",
    content: `
import { Task } from '../api/tasks';

export function TaskList({ tasks }: { tasks: Task[] }) {
  return (
    <ul>
      {tasks.map(t => (
        <li key={t.id} className={t.completed ? 'done' : ''}>
          {t.title}
        </li>
      ))}
    </ul>
  );
}
`,
  });
  log.info(`  ✓ Created components/TaskList.tsx`);

  state.updateIntent(frontendIntent.id, { status: "completed" });
  log.info(`  ✓ Frontend completed!`);
  await sleep(1000);

  updateWidgetState();

  // Step 5: Breaking change demonstration
  log.info("\n=== STEP 6: Breaking Change Demo ===");
  log.info('  Backend renames "title" to "name"...');

  state.applyFilePatch(backend.id, {
    path: "api/projects.ts",
    operation: "modify",
    content: `
export interface Project {
  id: string;
  name: string;  // Changed from 'title'
  description: string;
  createdAt: Date;
}
`,
  });
  log.info(`  ✓ Backend modified api/projects.ts (title → name)`);
  await sleep(800);

  // Frontend reacts
  const reactIntent = state.createIntent(frontend.id, {
    agentId: frontend.id,
    action: "React: Update Project references",
    targets: ["components/ProjectList.tsx"],
    description: "Adapting to Project.title → Project.name change",
    priority: 5,
    status: "active",
    dependencies: [],
  });
  log.info(`  ✓ Frontend detected change, reacting...`);

  state.applyFilePatch(frontend.id, {
    path: "components/ProjectList.tsx",
    operation: "modify",
    content: `
import { Project } from '../api/projects';

export function ProjectList({ projects }: { projects: Project[] }) {
  return (
    <ul>
      {projects.map(p => (
        <li key={p.id}>{p.name}</li>  {/* Updated: title → name */}
      ))}
    </ul>
  );
}
`,
  });
  log.info(`  ✓ Frontend auto-updated ProjectList.tsx`);

  state.updateIntent(reactIntent.id, { status: "completed" });
  log.info(`  ✓ Adaptation complete!`);
  await sleep(1000);

  updateWidgetState();

  // Step 6: Tester validates
  log.info("\n=== STEP 7: Tester Validates ===");

  const testIntent = state.createIntent(tester.id, {
    agentId: tester.id,
    action: "Run integration tests",
    targets: ["api/", "components/"],
    description: "Validate API and UI consistency",
    priority: 3,
    status: "active",
    dependencies: [],
  });

  state.reportTest(tester.id, "ProjectList renders correctly", "passed");
  log.info(`  ✓ Test passed: ProjectList renders correctly`);

  state.reportTest(tester.id, "API types match frontend", "passed");
  log.info(`  ✓ Test passed: API types match frontend`);

  state.updateIntent(testIntent.id, { status: "completed" });
  log.info(`  ✓ All tests passed!`);

  updateWidgetState();

  // Summary
  log.info("\n" + "=".repeat(60));
  log.info("DEMO COMPLETE");
  log.info("=".repeat(60));

  const blueprint = state.getBlueprint();
  log.info(`
Summary:
  • ${blueprint.agents.length} agents collaborated
  • ${blueprint.intents.length} intents processed
  • ${Object.keys(blueprint.files).length} files created/modified
  • ${blueprint.cursor} events generated

Key demonstrations:
  1. Automatic task decomposition by planner
  2. Cross-agent coordination without human relay
  3. Frontend auto-reacting to backend changes
  4. Breaking change propagation
  5. Automated testing integration

Open http://localhost:3200/widget to see the live graph!
`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run demo
runDemo().catch(console.error);
