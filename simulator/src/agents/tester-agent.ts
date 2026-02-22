// Synapse Simulator - Tester Agent
// Simulates a CI/CD test runner

import { VirtualAgent } from '../virtual-agent.js';
import { Event } from '../../../shared/types.js';
import { sleep } from '../../../shared/utils.js';

interface TestResult {
  name: string;
  passed: boolean;
  errors: string[];
  duration: number;
}

interface TestSuite {
  name: string;
  tests: TestResult[];
  passed: boolean;
}

export class TesterAgent extends VirtualAgent {
  private testSuites: Map<string, TestSuite> = new Map();
  private watchingFiles: boolean = false;
  private testQueue: string[] = [];
  private running: boolean = false;

  constructor(name: string = 'CI-Tester') {
    super(name, 'tester', 'observer', ['testing', 'validation', 'ci']);
  }

  async execute(): Promise<void> {
    this.log.info('Tester agent ready');
  }

  // ========================================
  // TEST OPERATIONS
  // ========================================

  async runTest(testName: string, testFn: () => Promise<{ passed: boolean; errors: string[] }>): Promise<TestResult> {
    await this.reportTest(testName, 'started');

    const startTime = Date.now();

    try {
      const result = await testFn();
      const duration = Date.now() - startTime;

      const testResult: TestResult = {
        name: testName,
        passed: result.passed,
        errors: result.errors,
        duration,
      };

      if (result.passed) {
        await this.reportTest(testName, 'passed', `Completed in ${duration}ms`);
        this.log.success(`Test passed: ${testName}`);
      } else {
        await this.reportTest(testName, 'failed', `Failed after ${duration}ms`, result.errors);
        this.log.error(`Test failed: ${testName} - ${result.errors.join(', ')}`);
      }

      return testResult;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const errorMessage = error.message || 'Unknown error';

      await this.reportTest(testName, 'failed', `Error after ${duration}ms`, [errorMessage]);

      return {
        name: testName,
        passed: false,
        errors: [errorMessage],
        duration,
      };
    }
  }

  async runTestSuite(suiteName: string, tests: Array<{ name: string; fn: () => Promise<{ passed: boolean; errors: string[] }> }>): Promise<TestSuite> {
    this.log.info(`Running test suite: ${suiteName}`);

    const results: TestResult[] = [];

    for (const test of tests) {
      const result = await this.runTest(`${suiteName}/${test.name}`, test.fn);
      results.push(result);

      // Small delay between tests
      await sleep(100);
    }

    const suite: TestSuite = {
      name: suiteName,
      tests: results,
      passed: results.every(r => r.passed),
    };

    this.testSuites.set(suiteName, suite);

    if (suite.passed) {
      this.log.success(`Suite passed: ${suiteName} (${results.length} tests)`);
    } else {
      const failed = results.filter(r => !r.passed);
      this.log.error(`Suite failed: ${suiteName} (${failed.length}/${results.length} failed)`);
    }

    return suite;
  }

  // ========================================
  // SCENARIO TESTS
  // ========================================

  async runLoginTests(): Promise<TestSuite> {
    return this.runTestSuite('login', [
      {
        name: 'valid_credentials',
        fn: async () => {
          // Simulate testing login with valid credentials
          const blueprint = await this.getBlueprint();
          const loginFile = blueprint.files['/api/login.ts'];

          if (!loginFile) {
            return { passed: false, errors: ['Login endpoint not found'] };
          }

          if (!loginFile.content.includes('validateCredentials')) {
            return { passed: false, errors: ['Missing credential validation'] };
          }

          return { passed: true, errors: [] };
        },
      },
      {
        name: 'invalid_credentials',
        fn: async () => {
          const blueprint = await this.getBlueprint();
          const loginFile = blueprint.files['/api/login.ts'];

          if (!loginFile) {
            return { passed: false, errors: ['Login endpoint not found'] };
          }

          if (!loginFile.content.includes('401')) {
            return { passed: false, errors: ['Missing 401 response for invalid credentials'] };
          }

          return { passed: true, errors: [] };
        },
      },
      {
        name: 'session_token',
        fn: async () => {
          const blueprint = await this.getBlueprint();
          const loginFile = blueprint.files['/api/login.ts'];

          if (!loginFile) {
            return { passed: false, errors: ['Login endpoint not found'] };
          }

          if (!loginFile.content.includes('createSession')) {
            return { passed: false, errors: ['Missing session creation'] };
          }

          return { passed: true, errors: [] };
        },
      },
    ]);
  }

  async runSchemaTests(expectedFields: string[]): Promise<TestSuite> {
    return this.runTestSuite('schema', [
      {
        name: 'required_fields',
        fn: async () => {
          const blueprint = await this.getBlueprint();
          const schemaFile = blueprint.files['/models/schema.ts'];

          if (!schemaFile) {
            return { passed: false, errors: ['Schema file not found'] };
          }

          const missingFields = expectedFields.filter(
            field => !schemaFile.content.includes(field)
          );

          if (missingFields.length > 0) {
            return {
              passed: false,
              errors: missingFields.map(f => `Missing field: ${f}`),
            };
          }

          return { passed: true, errors: [] };
        },
      },
    ]);
  }

  async runIntegrationTest(testName: string, validator: (blueprint: any) => { passed: boolean; errors: string[] }): Promise<TestResult> {
    return this.runTest(testName, async () => {
      const blueprint = await this.getBlueprint();
      return validator(blueprint);
    });
  }

  // ========================================
  // FILE WATCH MODE
  // ========================================

  enableFileWatch(): void {
    this.watchingFiles = true;
    this.onEvent(async (event) => {
      if (!this.watchingFiles) return;

      if (event.type === 'file_modified' || event.type === 'file_created') {
        const path = event.data.path as string;

        // Queue tests for modified files
        if (path.endsWith('.ts') || path.endsWith('.js')) {
          this.testQueue.push(path);
          this.processTestQueue();
        }
      }
    });
  }

  disableFileWatch(): void {
    this.watchingFiles = false;
  }

  private async processTestQueue(): Promise<void> {
    if (this.running || this.testQueue.length === 0) return;

    this.running = true;

    // Debounce - wait for more changes
    await sleep(500);

    const filesToTest = [...new Set(this.testQueue)];
    this.testQueue = [];

    this.log.info(`Running tests for ${filesToTest.length} changed files`);

    for (const file of filesToTest) {
      await this.runIntegrationTest(`file_change:${file}`, (blueprint) => {
        const fileState = blueprint.files[file];
        if (!fileState) {
          return { passed: false, errors: ['File not found in blueprint'] };
        }
        // Basic syntax check (simplified)
        if (fileState.content.includes('syntax error')) {
          return { passed: false, errors: ['Syntax error detected'] };
        }
        return { passed: true, errors: [] };
      });
    }

    this.running = false;

    // Process any new items that arrived
    if (this.testQueue.length > 0) {
      this.processTestQueue();
    }
  }

  // ========================================
  // RESULTS
  // ========================================

  getTestSuite(name: string): TestSuite | undefined {
    return this.testSuites.get(name);
  }

  getAllResults(): TestSuite[] {
    return Array.from(this.testSuites.values());
  }

  getFailedTests(): TestResult[] {
    const failed: TestResult[] = [];
    for (const suite of this.testSuites.values()) {
      failed.push(...suite.tests.filter(t => !t.passed));
    }
    return failed;
  }
}
