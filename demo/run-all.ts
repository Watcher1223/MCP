#!/usr/bin/env tsx
// Synapse Demo - Run All Components
// Starts hub and runs validation scenarios

import { spawn, ChildProcess } from 'child_process';
import { Logger, sleep } from '../shared/utils.js';

const log = new Logger('Demo');

let hubProcess: ChildProcess | null = null;

async function startHub(): Promise<void> {
  return new Promise((resolve, reject) => {
    log.info('Starting Synapse Hub...');

    hubProcess = spawn('npx', ['tsx', 'hub/src/index.ts'], {
      cwd: process.cwd().replace('/demo', ''),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: '3100' },
    });

    hubProcess.stdout?.on('data', (data) => {
      const output = data.toString().trim();
      if (output.includes('running on port')) {
        log.success('Hub started');
        resolve();
      }
    });

    hubProcess.stderr?.on('data', (data) => {
      console.error(data.toString());
    });

    hubProcess.on('error', (error) => {
      log.error(`Failed to start hub: ${error.message}`);
      reject(error);
    });

    // Timeout
    setTimeout(() => {
      reject(new Error('Hub startup timeout'));
    }, 10000);
  });
}

async function runTests(): Promise<number> {
  return new Promise((resolve) => {
    log.info('Running validation scenarios...\n');

    const testProcess = spawn('npx', ['tsx', 'simulator/src/run-tests.ts'], {
      cwd: process.cwd().replace('/demo', ''),
      stdio: 'inherit',
      env: { ...process.env, HUB_URL: 'ws://localhost:3100' },
    });

    testProcess.on('close', (code) => {
      resolve(code || 0);
    });
  });
}

async function cleanup(): Promise<void> {
  if (hubProcess) {
    log.info('Stopping hub...');
    hubProcess.kill();
    hubProcess = null;
  }
}

async function main() {
  console.log('\n');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║                    SYNAPSE DEMO                            ║');
  console.log('║     Multi-Agent Coordination Protocol Demonstration        ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('\n');

  // Handle cleanup on exit
  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await cleanup();
    process.exit(0);
  });

  try {
    // Start hub
    await startHub();

    // Wait for hub to be fully ready
    await sleep(1000);

    // Run tests
    const exitCode = await runTests();

    // Cleanup
    await cleanup();

    console.log('\n');
    if (exitCode === 0) {
      log.success('Demo completed successfully!');
      log.info('All agents converged automatically without human intervention.');
    } else {
      log.error('Demo completed with failures.');
    }

    process.exit(exitCode);
  } catch (error: any) {
    log.error(`Demo failed: ${error.message}`);
    await cleanup();
    process.exit(1);
  }
}

main();
