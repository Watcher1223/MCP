// Synapse Simulator - Scenario Runner
// Runs automated multi-agent test scenarios

import { SimulationResult, Event } from '../../shared/types.js';
import { Logger, sleep } from '../../shared/utils.js';
import { VirtualAgent } from './virtual-agent.js';
import { PlannerAgent } from './agents/planner-agent.js';
import { CoderAgent } from './agents/coder-agent.js';
import { TesterAgent } from './agents/tester-agent.js';
import { RefactorAgent } from './agents/refactor-agent.js';
import { ObserverAgent } from './agents/observer-agent.js';

const log = new Logger('ScenarioRunner');

export interface ScenarioConfig {
  name: string;
  description: string;
  timeout: number;
  setup?: () => Promise<void>;
  execute: (agents: AgentPool) => Promise<void>;
  validate: (agents: AgentPool, events: Event[]) => Promise<{ success: boolean; errors: string[] }>;
}

export interface AgentPool {
  planner: PlannerAgent;
  coder: CoderAgent;
  tester: TesterAgent;
  refactor: RefactorAgent;
  observer: ObserverAgent;
}

export class ScenarioRunner {
  private hubUrl: string;
  private agents: AgentPool | null = null;
  private collectedEvents: Event[] = [];

  constructor(hubUrl: string = 'ws://localhost:3100') {
    this.hubUrl = hubUrl;
  }

  async setup(): Promise<AgentPool> {
    log.info('Setting up agent pool...');

    const planner = new PlannerAgent();
    const coder = new CoderAgent();
    const tester = new TesterAgent();
    const refactor = new RefactorAgent();
    const observer = new ObserverAgent();

    // Connect all agents
    await Promise.all([
      planner.connect(this.hubUrl),
      coder.connect(this.hubUrl),
      tester.connect(this.hubUrl),
      refactor.connect(this.hubUrl),
      observer.connect(this.hubUrl),
    ]);

    this.agents = { planner, coder, tester, refactor, observer };

    // Collect events from all agents
    this.collectedEvents = [];
    const collectEvents = (event: Event) => {
      this.collectedEvents.push(event);
    };

    planner.onEvent(collectEvents);
    coder.onEvent(collectEvents);
    tester.onEvent(collectEvents);
    refactor.onEvent(collectEvents);
    observer.onEvent(collectEvents);

    log.info('All agents connected');
    return this.agents;
  }

  async teardown(): Promise<void> {
    if (this.agents) {
      await Promise.all([
        this.agents.planner.disconnect(),
        this.agents.coder.disconnect(),
        this.agents.tester.disconnect(),
        this.agents.refactor.disconnect(),
        this.agents.observer.disconnect(),
      ]);
    }
    this.agents = null;
    this.collectedEvents = [];
  }

  async runScenario(config: ScenarioConfig): Promise<SimulationResult> {
    log.info(`\n${'='.repeat(60)}`);
    log.info(`Running scenario: ${config.name}`);
    log.info(`Description: ${config.description}`);
    log.info('='.repeat(60));

    const startTime = Date.now();
    const errors: string[] = [];

    try {
      // Setup agents
      const agents = await this.setup();

      // Run setup if provided
      if (config.setup) {
        await config.setup();
      }

      // Execute scenario with timeout
      const timeoutPromise = new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error('Scenario timeout')), config.timeout);
      });

      await Promise.race([
        config.execute(agents),
        timeoutPromise,
      ]);

      // Small delay to collect final events
      await sleep(500);

      // Validate results
      const validation = await config.validate(agents, this.collectedEvents);

      const duration = Date.now() - startTime;

      if (validation.success) {
        log.success(`\nScenario PASSED: ${config.name} (${duration}ms)`);
      } else {
        log.error(`\nScenario FAILED: ${config.name}`);
        validation.errors.forEach(err => log.error(`  - ${err}`));
        errors.push(...validation.errors);
      }

      return {
        scenario: config.name,
        success: validation.success,
        duration,
        events: this.collectedEvents,
        errors,
        summary: validation.success
          ? `Scenario completed successfully in ${duration}ms`
          : `Scenario failed: ${errors.join('; ')}`,
      };
    } catch (error: any) {
      const duration = Date.now() - startTime;
      log.error(`\nScenario ERROR: ${config.name}`);
      log.error(`  ${error.message}`);

      return {
        scenario: config.name,
        success: false,
        duration,
        events: this.collectedEvents,
        errors: [error.message],
        summary: `Scenario error: ${error.message}`,
      };
    } finally {
      await this.teardown();
    }
  }

  async runAll(scenarios: ScenarioConfig[]): Promise<SimulationResult[]> {
    const results: SimulationResult[] = [];

    for (const scenario of scenarios) {
      const result = await this.runScenario(scenario);
      results.push(result);

      // Reset hub state between scenarios
      try {
        await fetch('http://localhost:3100/api/reset', { method: 'POST' });
      } catch (e) {
        // Ignore if hub doesn't support reset
      }

      await sleep(500);
    }

    return results;
  }

  printSummary(results: SimulationResult[]): void {
    console.log('\n' + '='.repeat(60));
    console.log('SCENARIO RESULTS SUMMARY');
    console.log('='.repeat(60));

    const passed = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    for (const result of results) {
      const status = result.success ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
      console.log(`[${status}] ${result.scenario} (${result.duration}ms)`);

      if (!result.success && result.errors.length > 0) {
        result.errors.forEach(err => console.log(`       ${err}`));
      }
    }

    console.log('');
    console.log(`Total: ${results.length} scenarios`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log('='.repeat(60));

    if (failed > 0) {
      console.log('\x1b[31mSome scenarios failed!\x1b[0m');
    } else {
      console.log('\x1b[32mAll scenarios passed!\x1b[0m');
    }
  }
}
