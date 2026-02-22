#!/usr/bin/env tsx
// Synapse Simulator - Test Runner
// Runs all automated validation scenarios

import { ScenarioRunner } from './scenario-runner.js';
import { allScenarios } from './scenarios/index.js';
import { Logger } from '../../shared/utils.js';

const log = new Logger('TestRunner');

async function main() {
  console.log('\n');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║              SYNAPSE MULTI-AGENT VALIDATION               ║');
  console.log('║        Proving AI Agents Can Collaborate Autonomously     ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('\n');

  const hubUrl = process.env.HUB_URL || 'ws://localhost:3100';
  const runner = new ScenarioRunner(hubUrl);

  // Check if hub is running
  try {
    const response = await fetch('http://localhost:3100/health');
    if (!response.ok) {
      throw new Error('Hub not healthy');
    }
    log.info('Hub is running');
  } catch (error) {
    log.error('Hub is not running! Please start the hub first:');
    log.error('  npm run dev:hub');
    process.exit(1);
  }

  // Run all scenarios
  const results = await runner.runAll(allScenarios);

  // Print summary
  runner.printSummary(results);

  // Exit with appropriate code
  const failed = results.filter(r => !r.success).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  log.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
