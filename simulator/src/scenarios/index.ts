// Synapse Simulator - Test Scenarios
// Automated validation scenarios for multi-agent collaboration

import { ScenarioConfig, AgentPool } from '../scenario-runner.js';
import { Event } from '../../../shared/types.js';
import { sleep } from '../../../shared/utils.js';

// ========================================
// SCENARIO 1: Parallel Edit Conflict
// ========================================
export const parallelEditConflict: ScenarioConfig = {
  name: 'Parallel Edit Conflict',
  description: 'Two agents try to edit the same file simultaneously. System should negotiate locks.',
  timeout: 30000,

  async execute(agents: AgentPool) {
    // Both agents try to edit /api/login.ts at the same time
    const editPromise1 = agents.coder.editFile(
      '/api/login.ts',
      '// Coder Agent Version\nexport function login() { return "coder"; }'
    );

    // Small delay to create race condition
    await sleep(50);

    const editPromise2 = agents.refactor.patchFile(
      '/api/login.ts',
      'create',
      '// Refactor Agent Version\nexport function login() { return "refactor"; }'
    );

    // Wait for both to complete (one should fail or be queued)
    const results = await Promise.allSettled([editPromise1, editPromise2]);

    // Wait for potential retry
    await sleep(2000);
  },

  async validate(agents: AgentPool, events: Event[]) {
    const errors: string[] = [];

    // Check that lock conflict was detected
    const lockConflicts = events.filter(e => e.type === 'lock_conflict' || e.type === 'lock_denied');
    if (lockConflicts.length === 0) {
      // One agent might have been fast enough to avoid conflict
      // Check that at least one file operation succeeded
      const fileEvents = events.filter(e => e.type === 'file_created' || e.type === 'file_modified');
      if (fileEvents.length === 0) {
        errors.push('No lock conflict detected and no file was modified');
      }
    }

    // Verify final state - file should exist
    const blueprint = await agents.coder.getBlueprint();
    const file = blueprint.files['/api/login.ts'];

    if (!file) {
      errors.push('File /api/login.ts does not exist after conflict resolution');
    } else {
      // File should contain content from one of the agents
      if (!file.content.includes('login')) {
        errors.push('File content is corrupted after conflict');
      }
    }

    return { success: errors.length === 0, errors };
  },
};

// ========================================
// SCENARIO 2: Schema Evolution
// ========================================
export const schemaEvolution: ScenarioConfig = {
  name: 'Schema Evolution',
  description: 'Backend changes API schema, frontend must adapt automatically.',
  timeout: 30000,

  async execute(agents: AgentPool) {
    // Planner creates schema change intent
    const planId = await agents.planner.planSchemaChange(
      'Add user profile fields: avatar, bio, location',
      ['/models/schema.ts', '/api/user.ts', '/components/Profile.tsx']
    );

    await sleep(500);

    // Backend coder implements schema change
    await agents.coder.createFile(
      '/models/schema.ts',
      `
export interface User {
  id: string;
  email: string;
  name: string;
  // New fields
  avatar?: string;
  bio?: string;
  location?: string;
}
`
    );

    await sleep(300);

    // Update API endpoint
    await agents.coder.createFile(
      '/api/user.ts',
      `
import { User } from '../models/schema';

export async function getUser(id: string): Promise<User> {
  // Now returns avatar, bio, location
  return {
    id,
    email: 'user@example.com',
    name: 'Test User',
    avatar: '/default-avatar.png',
    bio: 'Hello world',
    location: 'Earth'
  };
}
`
    );

    await sleep(300);

    // Frontend observer sees changes and updates component
    await agents.observer.implementFromIntent(planId, [
      {
        path: '/components/Profile.tsx',
        content: `
import { User } from '../models/schema';

export function Profile({ user }: { user: User }) {
  return (
    <div>
      <img src={user.avatar} alt={user.name} />
      <h1>{user.name}</h1>
      <p>{user.bio}</p>
      <span>{user.location}</span>
    </div>
  );
}
`,
      },
    ]);

    // Mark plan as completed
    await agents.planner.completePlan(planId);
  },

  async validate(agents: AgentPool, events: Event[]) {
    const errors: string[] = [];

    const blueprint = await agents.coder.getBlueprint();

    // Check schema file
    const schema = blueprint.files['/models/schema.ts'];
    if (!schema) {
      errors.push('Schema file not created');
    } else {
      if (!schema.content.includes('avatar')) errors.push('Schema missing avatar field');
      if (!schema.content.includes('bio')) errors.push('Schema missing bio field');
      if (!schema.content.includes('location')) errors.push('Schema missing location field');
    }

    // Check API file
    const api = blueprint.files['/api/user.ts'];
    if (!api) {
      errors.push('API file not created');
    } else {
      if (!api.content.includes('avatar')) errors.push('API not returning avatar');
    }

    // Check component
    const component = blueprint.files['/components/Profile.tsx'];
    if (!component) {
      errors.push('Component file not created');
    } else {
      if (!component.content.includes('user.avatar')) errors.push('Component not using avatar');
      if (!component.content.includes('user.bio')) errors.push('Component not using bio');
    }

    // Check intent completed
    const intentCompleted = events.some(e => e.type === 'intent_completed');
    if (!intentCompleted) {
      errors.push('Schema evolution intent not marked as completed');
    }

    return { success: errors.length === 0, errors };
  },
};

// ========================================
// SCENARIO 3: Stale Context Recovery
// ========================================
export const staleContextRecovery: ScenarioConfig = {
  name: 'Stale Context Recovery',
  description: 'Planner issues outdated instruction, gets updated context and replans.',
  timeout: 30000,

  async execute(agents: AgentPool) {
    // Coder creates initial file
    await agents.coder.createFile(
      '/api/auth.ts',
      '// Original auth implementation\nexport function authenticate() {}'
    );

    await sleep(300);

    // Planner creates plan based on old understanding
    const oldPlanId = await agents.planner.createPlan(
      'Add OAuth support to /api/login.ts',
      ['/api/login.ts'],
      5
    );

    await sleep(200);

    // Meanwhile, coder updates the file structure
    await agents.coder.editFile(
      '/api/auth.ts',
      '// Auth has been moved and restructured\nexport function authenticate() {}\nexport function oauth() { /* OAuth already here */ }'
    );

    await sleep(200);

    // Planner gets updated blueprint and realizes plan is stale
    const updatedBlueprint = await agents.planner.getBlueprint();

    // Check if our target file exists and if our plan is still valid
    const targetExists = updatedBlueprint.files['/api/login.ts'];
    const authFile = updatedBlueprint.files['/api/auth.ts'];

    // Planner revises plan based on new information
    if (!targetExists && authFile?.content.includes('oauth')) {
      await agents.planner.revisePlan(
        oldPlanId,
        'OAuth already implemented in /api/auth.ts. Enhance existing implementation.',
        ['/api/auth.ts']
      );
    }
  },

  async validate(agents: AgentPool, events: Event[]) {
    const errors: string[] = [];

    // Should see intent_cancelled for old plan
    const cancelled = events.some(e => e.type === 'intent_cancelled');
    if (!cancelled) {
      errors.push('Original plan was not cancelled');
    }

    // Should see new intent_broadcast for revised plan
    const revisedIntent = events.filter(e => e.type === 'intent_broadcast');
    if (revisedIntent.length < 2) {
      errors.push('Revised plan was not broadcast');
    }

    // The revised plan should reference the correct file
    const lastIntent = revisedIntent[revisedIntent.length - 1];
    if (lastIntent && !lastIntent.data.intent.description.includes('auth.ts')) {
      errors.push('Revised plan does not reference correct file');
    }

    return { success: errors.length === 0, errors };
  },
};

// ========================================
// SCENARIO 4: Continuous Refactor
// ========================================
export const continuousRefactor: ScenarioConfig = {
  name: 'Continuous Refactor',
  description: 'Refactor agent renames file while coder edits it. System converges.',
  timeout: 30000,

  async execute(agents: AgentPool) {
    // Create initial file
    await agents.coder.createFile(
      '/utils/helpers.ts',
      'export function formatDate(date: Date) { return date.toISOString(); }'
    );

    await sleep(300);

    // Start rename operation
    const renamePromise = agents.refactor.renameFile(
      '/utils/helpers.ts',
      '/utils/date-utils.ts'
    );

    // Simultaneously, coder tries to edit the file
    await sleep(100);
    const editPromise = agents.coder.editFile(
      '/utils/helpers.ts',
      'export function formatDate(date: Date) { return date.toLocaleDateString(); }\nexport function parseDate(str: string) { return new Date(str); }'
    );

    // Wait for both operations
    await Promise.allSettled([renamePromise, editPromise]);

    // Allow time for conflict resolution
    await sleep(2000);

    // Ensure the system converges to a consistent state
    const blueprint = await agents.coder.getBlueprint();

    // The file should exist in one location or the other
    const oldExists = !!blueprint.files['/utils/helpers.ts'];
    const newExists = !!blueprint.files['/utils/date-utils.ts'];

    if (!oldExists && !newExists) {
      // File was lost - coder should recreate it
      await agents.coder.createFile(
        '/utils/date-utils.ts',
        'export function formatDate(date: Date) { return date.toLocaleDateString(); }'
      );
    }
  },

  async validate(agents: AgentPool, events: Event[]) {
    const errors: string[] = [];

    const blueprint = await agents.coder.getBlueprint();

    // File should exist in exactly one location
    const oldExists = !!blueprint.files['/utils/helpers.ts'];
    const newExists = !!blueprint.files['/utils/date-utils.ts'];

    if (!oldExists && !newExists) {
      errors.push('File was lost during refactor conflict');
    }

    // If new path exists, it should have the function
    if (newExists) {
      const file = blueprint.files['/utils/date-utils.ts'];
      if (!file.content.includes('formatDate')) {
        errors.push('Renamed file missing formatDate function');
      }
    }

    // Should see lock activity
    const lockEvents = events.filter(e =>
      e.type === 'lock_acquired' || e.type === 'lock_released' || e.type === 'lock_conflict'
    );
    if (lockEvents.length === 0) {
      errors.push('No lock events detected during concurrent operations');
    }

    return { success: errors.length === 0, errors };
  },
};

// ========================================
// SCENARIO 5: Planner Without Filesystem
// ========================================
export const plannerWithoutFilesystem: ScenarioConfig = {
  name: 'Planner Without Filesystem',
  description: 'HTTP planner agent issues plan, local observer implements it.',
  timeout: 30000,

  async execute(agents: AgentPool) {
    // Planner creates a feature plan (simulating ChatGPT web)
    const planId = await agents.planner.planFeature(
      'User Authentication',
      ['/api/auth/login.ts', '/api/auth/logout.ts', '/middleware/auth.ts']
    );

    await sleep(500);

    // Observer picks up the intent and implements
    await agents.observer.implementFromIntent(planId, [
      {
        path: '/api/auth/login.ts',
        content: `
export async function login(req, res) {
  const { email, password } = req.body;
  const user = await validateUser(email, password);
  if (user) {
    const token = generateToken(user);
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
}
`,
      },
      {
        path: '/api/auth/logout.ts',
        content: `
export async function logout(req, res) {
  await invalidateToken(req.token);
  res.json({ success: true });
}
`,
      },
      {
        path: '/middleware/auth.ts',
        content: `
export async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });

  const user = await validateToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid token' });

  req.user = user;
  next();
}
`,
      },
    ]);

    await sleep(300);

    // Planner polls to see completion
    const blueprint = await agents.planner.getBlueprint();

    // Verify files exist and mark plan complete
    const allFilesCreated = [
      '/api/auth/login.ts',
      '/api/auth/logout.ts',
      '/middleware/auth.ts',
    ].every(path => !!blueprint.files[path]);

    if (allFilesCreated) {
      await agents.planner.completePlan(planId);
    }
  },

  async validate(agents: AgentPool, events: Event[]) {
    const errors: string[] = [];

    const blueprint = await agents.coder.getBlueprint();

    // All files should exist
    const requiredFiles = [
      '/api/auth/login.ts',
      '/api/auth/logout.ts',
      '/middleware/auth.ts',
    ];

    for (const path of requiredFiles) {
      if (!blueprint.files[path]) {
        errors.push(`Missing file: ${path}`);
      }
    }

    // Intent should be completed
    const intentCompleted = events.some(e => e.type === 'intent_completed');
    if (!intentCompleted) {
      errors.push('Feature plan not marked as completed');
    }

    // Observer should have created files
    const fileCreated = events.filter(e => e.type === 'file_created');
    if (fileCreated.length < 3) {
      errors.push(`Only ${fileCreated.length} files created, expected 3`);
    }

    return { success: errors.length === 0, errors };
  },
};

// ========================================
// SCENARIO 6: Test Failure Loop
// ========================================
export const testFailureLoop: ScenarioConfig = {
  name: 'Test Failure Loop',
  description: 'Test fails, planner revises, coder patches, test passes.',
  timeout: 45000,

  async execute(agents: AgentPool) {
    // Enable auto-replan on test failure
    agents.planner.enableAutoReplan();

    // Create initial (buggy) implementation
    await agents.coder.createFile(
      '/api/login.ts',
      `
export function login(email: string, password: string) {
  // Bug: missing validation
  return { success: true };
}
`
    );

    await sleep(500);

    // Run tests (should fail)
    const testResults = await agents.tester.runTestSuite('login', [
      {
        name: 'validates_credentials',
        fn: async () => {
          const blueprint = await agents.tester.getBlueprint();
          const file = blueprint.files['/api/login.ts'];

          if (!file) {
            return { passed: false, errors: ['Login file not found'] };
          }

          if (!file.content.includes('validateCredentials')) {
            return { passed: false, errors: ['Missing credential validation'] };
          }

          return { passed: true, errors: [] };
        },
      },
    ]);

    // Wait for planner to react to test failure
    await sleep(2000);

    // Coder implements the fix (in response to planner's revised plan)
    await agents.coder.editFile(
      '/api/login.ts',
      `
export async function login(email: string, password: string) {
  // Fixed: now validates credentials
  const user = await validateCredentials(email, password);

  if (!user) {
    return { success: false, error: 'Invalid credentials' };
  }

  return { success: true, user };
}
`
    );

    await sleep(500);

    // Run tests again (should pass now)
    await agents.tester.runTestSuite('login-fixed', [
      {
        name: 'validates_credentials',
        fn: async () => {
          const blueprint = await agents.tester.getBlueprint();
          const file = blueprint.files['/api/login.ts'];

          if (!file) {
            return { passed: false, errors: ['Login file not found'] };
          }

          if (!file.content.includes('validateCredentials')) {
            return { passed: false, errors: ['Missing credential validation'] };
          }

          return { passed: true, errors: [] };
        },
      },
    ]);

    agents.planner.disableAutoReplan();
  },

  async validate(agents: AgentPool, events: Event[]) {
    const errors: string[] = [];

    // Should see initial test failure
    const testFailed = events.some(e => e.type === 'test_failed');
    if (!testFailed) {
      errors.push('Initial test failure not recorded');
    }

    // Should see revised plan from planner
    const intentEvents = events.filter(e => e.type === 'intent_broadcast');
    if (intentEvents.length < 2) {
      errors.push('Planner did not create fix plan after test failure');
    }

    // Should see test pass eventually
    const testPassed = events.some(e => e.type === 'test_passed');
    if (!testPassed) {
      errors.push('Tests did not pass after fix');
    }

    // Final file should have the fix
    const blueprint = await agents.coder.getBlueprint();
    const file = blueprint.files['/api/login.ts'];
    if (!file) {
      errors.push('Login file missing');
    } else if (!file.content.includes('validateCredentials')) {
      errors.push('Final file missing fix');
    }

    return { success: errors.length === 0, errors };
  },
};

// Export all scenarios
export const allScenarios: ScenarioConfig[] = [
  parallelEditConflict,
  schemaEvolution,
  staleContextRecovery,
  continuousRefactor,
  plannerWithoutFilesystem,
  testFailureLoop,
];
