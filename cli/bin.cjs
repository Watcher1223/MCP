#!/usr/bin/env node
// Wrapper so "npx synapse" or "synapse" runs the CLI via tsx
const { spawnSync } = require('child_process');
const path = require('path');

const script = path.join(__dirname, 'src', 'index.ts');
const result = spawnSync('npx', ['tsx', script, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
});
process.exit(result.status ?? 1);
