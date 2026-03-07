#!/usr/bin/env node

import process from 'node:process';
import {
  clearRuntimeFiles,
  createDependencies,
  ensureDefaultConfig,
  ensureDirectory,
  getStatus,
  isProcessRunning,
  loadConfig,
  readPid,
  resolvePaths,
  runLoop,
} from './signal-daemon-lib.js';

function printUsage() {
  process.stdout.write('Usage: signal-daemon <start|stop|status>\n');
}

async function startCommand(paths, dependencies) {
  ensureDefaultConfig(paths);
  const existingPid = readPid(paths);
  if (existingPid && isProcessRunning(existingPid)) {
    process.stderr.write(`signal-daemon already running (pid=${existingPid})\n`);
    process.exitCode = 1;
    return;
  }

  if (existingPid) {
    clearRuntimeFiles(paths);
  }

  const config = loadConfig(paths);
  ensureDirectory(config.notify.terminal_log);
  await runLoop(paths, config, dependencies);
}

function stopCommand(paths) {
  const pid = readPid(paths);
  if (!pid) {
    process.stdout.write('signal-daemon is not running\n');
    return;
  }

  if (!isProcessRunning(pid)) {
    clearRuntimeFiles(paths);
    process.stdout.write(`Removed stale pid file (${pid})\n`);
    return;
  }

  process.kill(pid, 'SIGTERM');
  process.stdout.write(`Stopped signal-daemon (pid=${pid})\n`);
}

function statusCommand(paths) {
  const status = getStatus(paths);
  if (!status.running) {
    process.stdout.write(`signal-daemon stopped | processed=${status.processedSignals}\n`);
    return;
  }

  process.stdout.write(
    `signal-daemon running | pid=${status.pid} | uptime=${status.uptimeSeconds}s | processed=${status.processedSignals} | tier=${status.tier}\n`
  );
}

export async function runCli(argv = process.argv.slice(2), overrides = {}) {
  const command = argv[0];
  const paths = resolvePaths(overrides.homeDir);
  const dependencies = createDependencies(overrides);

  switch (command) {
    case 'start':
      await startCommand(paths, dependencies);
      return;
    case 'stop':
      stopCommand(paths);
      return;
    case 'status':
      statusCommand(paths);
      return;
    default:
      printUsage();
      process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runCli();
}
