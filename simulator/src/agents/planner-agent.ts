// Synapse Simulator - Planner Agent
// Simulates a planning AI like ChatGPT in web mode

import { VirtualAgent } from '../virtual-agent.js';
import { Intent, Event } from '../../../shared/types.js';
import { sleep } from '../../../shared/utils.js';

export class PlannerAgent extends VirtualAgent {
  private plans: Map<string, { intentId: string; status: string }> = new Map();
  private watchingForFailures: boolean = false;

  constructor(name: string = 'ChatGPT-Planner') {
    super(name, 'planner', 'stateless', ['planning', 'architecture', 'review']);
  }

  async execute(): Promise<void> {
    this.log.info('Planner agent ready');
  }

  // ========================================
  // PLANNING OPERATIONS
  // ========================================

  async createPlan(
    description: string,
    targets: string[],
    priority: number = 5
  ): Promise<string> {
    const intentId = await this.broadcastIntent(
      'implement_plan',
      targets,
      description,
      priority
    );

    this.plans.set(intentId, { intentId, status: 'pending' });
    return intentId;
  }

  async revisePlan(
    originalPlanId: string,
    newDescription: string,
    newTargets: string[]
  ): Promise<string> {
    // Cancel old plan
    await this.updateIntent(originalPlanId, 'cancelled');
    this.plans.delete(originalPlanId);

    // Create new plan
    const newPlanId = await this.createPlan(
      `[REVISED] ${newDescription}`,
      newTargets,
      10 // Higher priority for revisions
    );

    this.log.info(`Plan revised: ${originalPlanId} -> ${newPlanId}`);
    return newPlanId;
  }

  async completePlan(planId: string): Promise<void> {
    await this.updateIntent(planId, 'completed');
    const plan = this.plans.get(planId);
    if (plan) {
      plan.status = 'completed';
    }
  }

  // ========================================
  // SCENARIO BEHAVIORS
  // ========================================

  async planFeature(featureName: string, files: string[]): Promise<string> {
    this.log.info(`Planning feature: ${featureName}`);

    return await this.createPlan(
      `Implement ${featureName}: Create necessary files and integrate with existing codebase`,
      files,
      5
    );
  }

  async planSchemaChange(schemaDescription: string, affectedFiles: string[]): Promise<string> {
    this.log.info(`Planning schema change: ${schemaDescription}`);

    return await this.createPlan(
      `Schema evolution: ${schemaDescription}. Update all affected components.`,
      affectedFiles,
      8
    );
  }

  async planRefactor(refactorDescription: string, targetFiles: string[]): Promise<string> {
    this.log.info(`Planning refactor: ${refactorDescription}`);

    return await this.createPlan(
      `Refactor: ${refactorDescription}`,
      targetFiles,
      3
    );
  }

  async handleTestFailure(testName: string, errors: string[]): Promise<string> {
    this.log.info(`Handling test failure: ${testName}`);

    // Analyze errors and create a fix plan
    const affectedFiles = this.inferAffectedFiles(errors);

    return await this.createPlan(
      `Fix failing test "${testName}": ${errors.join('; ')}`,
      affectedFiles,
      10 // High priority for test fixes
    );
  }

  private inferAffectedFiles(errors: string[]): string[] {
    // In a real scenario, this would parse stack traces
    // For simulation, we return generic targets
    const files: string[] = [];

    for (const error of errors) {
      if (error.includes('api')) files.push('/api');
      if (error.includes('login')) files.push('/api/login.ts');
      if (error.includes('schema')) files.push('/models/schema.ts');
      if (error.includes('component')) files.push('/components');
    }

    return files.length > 0 ? files : ['/src'];
  }

  // ========================================
  // CONFLICT HANDLING
  // ========================================

  protected onIntentConflict(data: { newIntent: Intent; conflictingIntents: Intent[] }): void {
    super.onIntentConflict(data);

    // Planner negotiates by adjusting priorities or targets
    this.log.info('Negotiating intent conflict...');

    // In a real scenario, the planner would:
    // 1. Analyze conflicting intents
    // 2. Determine if they can be sequenced
    // 3. Create a coordinated plan
  }

  // Watch for test failures and auto-replan
  enableAutoReplan(): void {
    this.watchingForFailures = true;
    this.onEvent(async (event) => {
      if (event.type === 'test_failed' && this.watchingForFailures) {
        await sleep(500); // Small delay to gather all failure info
        await this.handleTestFailure(
          event.data.testName,
          event.data.errors || []
        );
      }
    });
  }

  disableAutoReplan(): void {
    this.watchingForFailures = false;
  }
}
