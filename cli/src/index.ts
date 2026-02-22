#!/usr/bin/env node

// Synapse CLI - Zero-friction multi-agent coordination
// Usage: npx synapse connect

import { Command } from 'commander';
import Conf from 'conf';
import chalk from 'chalk';
import ora from 'ora';
import WebSocket from 'ws';
import { spawn, exec } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const VERSION = '2.0.0';
const DEFAULT_HUB = process.env.SYNAPSE_HUB || 'wss://synapse.clodhost.com';
const CONFIG_DIR = join(homedir(), '.synapse');

// Persistent config
const config = new Conf({
  projectName: 'synapse',
  schema: {
    apiKey: { type: 'string' },
    sessionToken: { type: 'string' },
    workspaceId: { type: 'string' },
    workspaceSlug: { type: 'string' },
    agentId: { type: 'string' },
    agentName: { type: 'string' },
    hubUrl: { type: 'string', default: DEFAULT_HUB }
  }
});

// Environment detection
function detectEnvironment(): { type: string; name: string; capabilities: string[] } {
  const cwd = process.cwd();
  const env = process.env;

  // Check for IDE-specific environment variables
  if (env.CURSOR_CHANNEL || env.CURSOR_VERSION) {
    return {
      type: 'cursor',
      name: 'Cursor IDE',
      capabilities: ['edit', 'file_read', 'file_write', 'terminal', 'chat']
    };
  }

  if (env.VSCODE_GIT_IPC_HANDLE || env.TERM_PROGRAM === 'vscode') {
    return {
      type: 'vscode',
      name: 'VS Code',
      capabilities: ['edit', 'file_read', 'file_write', 'terminal']
    };
  }

  if (env.CLAUDE_CODE || env.MCP_SERVER) {
    return {
      type: 'claude',
      name: 'Claude Desktop',
      capabilities: ['chat', 'plan', 'analyze', 'mcp']
    };
  }

  // Terminal detection
  if (env.TERM || env.SHELL) {
    const shell = env.SHELL?.split('/').pop() || 'terminal';
    return {
      type: 'terminal',
      name: `Terminal (${shell})`,
      capabilities: ['execute', 'file_read', 'file_write']
    };
  }

  return {
    type: 'unknown',
    name: 'Unknown Environment',
    capabilities: ['chat']
  };
}

// Generate unique agent ID based on machine + env
function generateAgentId(envType: string): string {
  const machineId = require('os').hostname();
  return `${envType}-${machineId}-${Date.now().toString(36)}`;
}

// Connect to Synapse hub
async function connectToHub(options: {
  hubUrl: string;
  apiKey?: string;
  sessionToken?: string;
  environment: string;
  name: string;
  capabilities: string[];
  role?: string;
}): Promise<{
  ws: WebSocket;
  agent: any;
  sessionToken: string;
  blueprint: any;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(options.hubUrl);
    let resolved = false;

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'connect',
        apiKey: options.apiKey,
        sessionToken: options.sessionToken,
        environment: options.environment,
        name: options.name,
        capabilities: options.capabilities,
        role: options.role || 'coder'
      }));
    });

    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());

      if (message.type === 'connected' && !resolved) {
        resolved = true;
        resolve({
          ws,
          agent: message.agent,
          sessionToken: message.sessionToken,
          blueprint: message.blueprint
        });
      }

      if (message.type === 'error') {
        reject(new Error(message.message));
      }
    });

    ws.on('error', reject);

    setTimeout(() => {
      if (!resolved) reject(new Error('Connection timeout'));
    }, 10000);
  });
}

// Main CLI program
const program = new Command();

program
  .name('synapse')
  .description('Zero-friction multi-agent coordination')
  .version(VERSION);

// Connect command
program
  .command('connect')
  .description('Connect this environment to Synapse')
  .option('-n, --name <name>', 'Agent name')
  .option('-r, --role <role>', 'Agent role (coder, planner, tester, executor)')
  .option('-w, --workspace <slug>', 'Workspace slug to join')
  .option('-k, --api-key <key>', 'API key for existing workspace')
  .option('-h, --hub <url>', 'Hub URL', DEFAULT_HUB)
  .option('-d, --daemon', 'Run as background daemon')
  .option('--reset', 'Clear saved credentials and reconnect')
  .action(async (options) => {
    const spinner = ora('Detecting environment...').start();

    try {
      // Reset if requested
      if (options.reset) {
        config.clear();
        spinner.succeed('Credentials cleared');
      }

      // Detect environment
      const env = detectEnvironment();
      spinner.text = `Detected: ${env.name}`;

      // Get or use saved credentials
      let apiKey = options.apiKey || config.get('apiKey') as string;
      let sessionToken = config.get('sessionToken') as string;
      let hubUrl = options.hub || config.get('hubUrl') as string || DEFAULT_HUB;

      // Ensure config directory exists
      if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true });
      }

      spinner.text = 'Connecting to Synapse...';

      // Connect
      const connection = await connectToHub({
        hubUrl,
        apiKey,
        sessionToken,
        environment: env.type,
        name: options.name || env.name,
        capabilities: env.capabilities,
        role: options.role
      });

      // Save credentials
      config.set('sessionToken', connection.sessionToken);
      config.set('agentId', connection.agent.id);
      config.set('agentName', connection.agent.name);
      config.set('workspaceId', connection.agent.workspaceId);
      config.set('hubUrl', hubUrl);

      spinner.succeed(chalk.green('Connected to Synapse!'));

      console.log('');
      console.log(chalk.bold('  Agent Details:'));
      console.log(`    ID:          ${chalk.cyan(connection.agent.id)}`);
      console.log(`    Name:        ${chalk.cyan(connection.agent.name)}`);
      console.log(`    Role:        ${chalk.cyan(connection.agent.role)}`);
      console.log(`    Environment: ${chalk.cyan(env.type)}`);
      console.log('');

      // Show other online agents
      const otherAgents = connection.blueprint.agents.filter(
        (a: any) => a.id !== connection.agent.id
      );

      if (otherAgents.length > 0) {
        console.log(chalk.bold('  Online Agents:'));
        for (const agent of otherAgents) {
          console.log(`    ${chalk.green('●')} ${agent.name} (${agent.role})`);
        }
        console.log('');
      }

      // If daemon mode, keep running
      if (options.daemon) {
        console.log(chalk.dim('  Running in daemon mode. Press Ctrl+C to stop.'));
        console.log('');

        // Set up heartbeat
        setInterval(() => {
          if (connection.ws.readyState === WebSocket.OPEN) {
            connection.ws.send(JSON.stringify({ type: 'heartbeat' }));
          }
        }, 30000);

        // Handle incoming messages
        connection.ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          handleDaemonMessage(msg);
        });

        // Handle process termination
        process.on('SIGINT', () => {
          console.log('\n' + chalk.yellow('Disconnecting...'));
          connection.ws.close();
          process.exit(0);
        });

      } else {
        // Non-daemon mode: just connect and exit
        connection.ws.close();
        console.log(chalk.dim('  Run with --daemon to keep connection alive.'));
        console.log(chalk.dim('  Or use: synapse daemon'));
      }

    } catch (error: any) {
      spinner.fail(chalk.red('Connection failed'));
      console.error(chalk.red(`  Error: ${error.message}`));
      process.exit(1);
    }
  });

// Daemon command (background process)
program
  .command('daemon')
  .description('Run Synapse agent as a background daemon')
  .option('--start', 'Start the daemon')
  .option('--stop', 'Stop the daemon')
  .option('--status', 'Check daemon status')
  .action(async (options) => {
    const pidFile = join(CONFIG_DIR, 'daemon.pid');

    if (options.stop) {
      if (existsSync(pidFile)) {
        const pid = readFileSync(pidFile, 'utf-8');
        try {
          process.kill(parseInt(pid), 'SIGTERM');
          console.log(chalk.green('Daemon stopped'));
        } catch {
          console.log(chalk.yellow('Daemon was not running'));
        }
        require('fs').unlinkSync(pidFile);
      } else {
        console.log(chalk.yellow('No daemon running'));
      }
      return;
    }

    if (options.status) {
      if (existsSync(pidFile)) {
        const pid = readFileSync(pidFile, 'utf-8');
        try {
          process.kill(parseInt(pid), 0);
          console.log(chalk.green(`Daemon running (PID: ${pid})`));
        } catch {
          console.log(chalk.yellow('Daemon not running (stale PID file)'));
        }
      } else {
        console.log(chalk.yellow('Daemon not running'));
      }
      return;
    }

    // Start daemon
    const child = spawn(process.execPath, [__filename, 'connect', '--daemon'], {
      detached: true,
      stdio: 'ignore'
    });

    child.unref();
    writeFileSync(pidFile, child.pid!.toString());
    console.log(chalk.green(`Daemon started (PID: ${child.pid})`));
  });

// Status command
program
  .command('status')
  .description('Show current connection status')
  .action(() => {
    const sessionToken = config.get('sessionToken');
    const agentName = config.get('agentName');
    const agentId = config.get('agentId');
    const hubUrl = config.get('hubUrl');

    if (!sessionToken) {
      console.log(chalk.yellow('Not connected. Run: synapse connect'));
      return;
    }

    console.log(chalk.bold('\nSynapse Status:'));
    console.log(`  Agent:     ${chalk.cyan(agentName || 'Unknown')}`);
    console.log(`  ID:        ${chalk.dim(agentId || 'Unknown')}`);
    console.log(`  Hub:       ${chalk.dim(hubUrl || DEFAULT_HUB)}`);
    console.log(`  Session:   ${chalk.dim((sessionToken as string)?.slice(0, 20) + '...')}`);
    console.log('');
  });

// Agents command
program
  .command('agents')
  .description('List all agents in the workspace')
  .action(async () => {
    const spinner = ora('Fetching agents...').start();

    const sessionToken = config.get('sessionToken') as string;
    const hubUrl = config.get('hubUrl') as string || DEFAULT_HUB;

    if (!sessionToken) {
      spinner.fail('Not connected. Run: synapse connect');
      return;
    }

    try {
      const httpUrl = hubUrl.replace('wss://', 'https://').replace('ws://', 'http://');
      const response = await fetch(`${httpUrl}/api/blueprint`, {
        headers: { 'X-Session-Token': sessionToken }
      });

      if (!response.ok) throw new Error('Failed to fetch');

      const blueprint = await response.json();
      spinner.stop();

      console.log(chalk.bold('\nOnline Agents:'));
      for (const agent of blueprint.agents) {
        const status = agent.isOnline ? chalk.green('●') : chalk.gray('○');
        console.log(`  ${status} ${chalk.cyan(agent.name)} (${agent.role}) - ${chalk.dim(agent.environment)}`);
      }
      console.log('');

    } catch (error: any) {
      spinner.fail(`Failed: ${error.message}`);
    }
  });

// Intent command
program
  .command('intent <action>')
  .description('Broadcast an intent to other agents')
  .option('-d, --description <text>', 'Intent description')
  .option('-t, --targets <paths>', 'Target files/paths (comma-separated)')
  .option('-c, --concepts <concepts>', 'Concepts (comma-separated)')
  .option('-p, --priority <n>', 'Priority (1-10)', '5')
  .action(async (action, options) => {
    const spinner = ora('Broadcasting intent...').start();

    const sessionToken = config.get('sessionToken') as string;
    const hubUrl = config.get('hubUrl') as string || DEFAULT_HUB;

    if (!sessionToken) {
      spinner.fail('Not connected. Run: synapse connect');
      return;
    }

    try {
      const httpUrl = hubUrl.replace('wss://', 'https://').replace('ws://', 'http://');
      const response = await fetch(`${httpUrl}/api/intent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': sessionToken
        },
        body: JSON.stringify({
          action,
          description: options.description || action,
          targets: options.targets?.split(',') || [],
          concepts: options.concepts?.split(',') || [],
          priority: parseInt(options.priority)
        })
      });

      if (!response.ok) throw new Error('Failed to broadcast');

      const { intent } = await response.json();
      spinner.succeed(`Intent broadcast: ${chalk.cyan(intent.id)}`);

    } catch (error: any) {
      spinner.fail(`Failed: ${error.message}`);
    }
  });

// Configure command
program
  .command('config')
  .description('Configure Synapse settings')
  .option('--hub <url>', 'Set hub URL')
  .option('--name <name>', 'Set agent name')
  .option('--show', 'Show current config')
  .option('--clear', 'Clear all config')
  .action((options) => {
    if (options.clear) {
      config.clear();
      console.log(chalk.green('Configuration cleared'));
      return;
    }

    if (options.show) {
      console.log(chalk.bold('\nConfiguration:'));
      console.log(JSON.stringify(config.store, null, 2));
      return;
    }

    if (options.hub) {
      config.set('hubUrl', options.hub);
      console.log(chalk.green(`Hub URL set to: ${options.hub}`));
    }

    if (options.name) {
      config.set('agentName', options.name);
      console.log(chalk.green(`Agent name set to: ${options.name}`));
    }
  });

// Install command (for system-wide installation)
program
  .command('install')
  .description('Install Synapse system-wide')
  .option('--vscode', 'Install VS Code extension')
  .option('--cursor', 'Install Cursor extension')
  .option('--mcp', 'Install MCP server for Claude Desktop')
  .action(async (options) => {
    if (options.vscode || options.cursor) {
      const spinner = ora('Installing extension...').start();
      // Extension installation logic would go here
      spinner.succeed('Extension installed');
    }

    if (options.mcp) {
      const spinner = ora('Setting up MCP server...').start();
      // MCP setup logic
      const mcpConfig = {
        mcpServers: {
          synapse: {
            command: 'npx',
            args: ['synapse-mcp'],
            env: {
              SYNAPSE_HUB: config.get('hubUrl') || DEFAULT_HUB,
              SYNAPSE_SESSION: config.get('sessionToken')
            }
          }
        }
      };

      const claudeConfigPath = join(homedir(), '.config', 'claude', 'config.json');
      writeFileSync(claudeConfigPath, JSON.stringify(mcpConfig, null, 2));
      spinner.succeed('MCP server configured for Claude Desktop');
    }
  });

// Handle daemon messages
function handleDaemonMessage(msg: any) {
  const timestamp = new Date().toLocaleTimeString();

  switch (msg.type) {
    case 'agent_connected':
      console.log(`${chalk.dim(timestamp)} ${chalk.green('+')} Agent joined: ${msg.agent.name}`);
      break;

    case 'agent_disconnected':
      console.log(`${chalk.dim(timestamp)} ${chalk.red('-')} Agent left: ${msg.agentId}`);
      break;

    case 'intent_broadcast':
      console.log(`${chalk.dim(timestamp)} ${chalk.blue('▶')} Intent: ${msg.intent.action} by ${msg.intent.agentId}`);
      break;

    case 'file_modified':
      console.log(`${chalk.dim(timestamp)} ${chalk.yellow('✎')} File: ${msg.path} (v${msg.version})`);
      break;

    case 'lock_acquired':
      console.log(`${chalk.dim(timestamp)} ${chalk.magenta('🔒')} Lock: ${msg.target.path} by ${msg.agentName}`);
      break;

    case 'reaction_trigger':
      console.log(`${chalk.dim(timestamp)} ${chalk.cyan('⚡')} Reaction: ${msg.actionType}`);
      // Here the daemon could automatically execute the reaction
      break;
  }
}

program.parse();
