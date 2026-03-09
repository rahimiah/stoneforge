import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import {
  DEFAULT_CONFIG,
  ensureDefaultConfig,
  getLatestBriefingFile,
  parseClaudeDecision,
  passesAlertRules,
  passesArbRules,
  processPollCycle,
  resolvePaths,
} from '../../scripts/signal-daemon-lib.js';

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'signal-daemon-test-'));
}

function cleanupDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for condition');
}

test('ensureDefaultConfig creates default config.yaml', () => {
  const homeDir = makeTempHome();
  try {
    const paths = resolvePaths(homeDir);
    ensureDefaultConfig(paths);
    assert.equal(fs.existsSync(paths.configPath), true);
    const content = fs.readFileSync(paths.configPath, 'utf8');
    assert.match(content, /poll_interval_seconds: 30/);
  } finally {
    cleanupDir(homeDir);
  }
});

test('passesArbRules enforces spread and liquidity thresholds', () => {
  const rules = DEFAULT_CONFIG.rules.arb;
  assert.equal(
    passesArbRules(
      { spreadPct: 9.9, outcomeId: 'a', venues: [{ liquidity: 5000 }] },
      rules
    ),
    false
  );
  assert.equal(
    passesArbRules(
      { spreadPct: 20, outcomeId: 'a', venues: [{ liquidity: 0 }, { liquidity: 999 }] },
      rules
    ),
    false
  );
  assert.equal(
    passesArbRules(
      { spreadPct: 20, outcomeId: 'a', venues: [{ liquidity: 5000 }], asset: 'BTC' },
      rules
    ),
    true
  );
});

test('passesAlertRules enforces severity threshold', () => {
  const rules = DEFAULT_CONFIG.rules.alerts;
  assert.equal(passesAlertRules({ id: 'x', severity: 'low', category: 'macro' }, rules), false);
  assert.equal(passesAlertRules({ id: 'x', severity: 'high', category: 'macro' }, rules), true);
});

test('getLatestBriefingFile uses highest filename sort order', () => {
  const homeDir = makeTempHome();
  try {
    const paths = resolvePaths(homeDir);
    fs.mkdirSync(paths.sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.sessionsDir, '2026-03-07-0900.md'), 'old', 'utf8');
    fs.writeFileSync(path.join(paths.sessionsDir, '2026-03-07-1030.md'), 'new', 'utf8');
    assert.equal(getLatestBriefingFile(paths), path.join(paths.sessionsDir, '2026-03-07-1030.md'));
  } finally {
    cleanupDir(homeDir);
  }
});

test('parseClaudeDecision fail-opens on invalid output', () => {
  assert.deepEqual(parseClaudeDecision('nonsense', true), {
    verdict: 'PASS',
    reason: 'evaluation unavailable',
    evaluationUnavailable: true,
  });
});

test('processPollCycle dedups, logs PASS/SKIP, and fail-opens on evaluator errors', async () => {
  const homeDir = makeTempHome();
  try {
    const logDir = path.join(homeDir, 'docs', 'signals');
    const notifications = [];
    const evaluations = [];
    const config = {
      ...DEFAULT_CONFIG,
      notify: {
        terminal_log: logDir,
        macos_notification: true,
      },
    };

    const dependencies = {
      now: () => new Date('2026-03-07T16:28:30.000Z'),
      runCommand: async (command, args) => {
        if (command === 'claude') {
          const prompt = args.at(-1);
          evaluations.push(prompt);
          if (prompt.includes('"id": "alert-pass"')) {
            throw new Error('rate limited');
          }
          if (prompt.includes('"outcomeId": "arb-pass"')) {
            return { stdout: 'PASS: aligned with briefing', stderr: '' };
          }
          return { stdout: 'SKIP: not aligned', stderr: '' };
        }
        if (command === 'osascript') {
          notifications.push(args.join(' '));
          return { stdout: '', stderr: '' };
        }
        throw new Error(`unexpected command: ${command}`);
      },
      sleep: async () => {},
      stdout: process.stdout,
      stderr: process.stderr,
    };

    const state = { processedSignals: 0, lastSignalAt: null };
    const seenIds = new Set();
    await processPollCycle({
      signals: {
        arbs: [
          { outcomeId: 'arb-filtered', spreadPct: 5, venues: [{ liquidity: 5000 }], outcome: 'Too Small' },
          { outcomeId: 'arb-pass', spreadPct: 20, venues: [{ name: 'PM', price: '52.5c', liquidity: 5000 }], outcome: 'Worth Watching' },
          { outcomeId: 'arb-pass', spreadPct: 20, venues: [{ name: 'PM', price: '52.5c', liquidity: 5000 }], outcome: 'Duplicate' },
        ],
        alerts: [
          { id: 'alert-skip', severity: 'high', category: 'macro', title: 'Skip Me' },
          { id: 'alert-pass', severity: 'high', category: 'macro', title: 'Fail Open' },
        ],
      },
      config,
      seenIds,
      briefing: 'Session says watch macro dislocations.',
      dependencies,
      state,
    });

    const date = '2026-03-07';
    const logPath = path.join(logDir, `${date}.log`);
    const logContent = fs.readFileSync(logPath, 'utf8');

    assert.equal(state.processedSignals, 3);
    assert.equal(seenIds.has('arb-pass'), true);
    assert.equal(seenIds.has('alert-pass'), true);
    assert.match(logContent, /PASS: aligned with briefing/);
    assert.match(logContent, /SKIP: not aligned/);
    assert.match(logContent, /PASS: evaluation unavailable/);
    assert.equal(notifications.length, 2);
    assert.equal(evaluations.length, 3);
  } finally {
    cleanupDir(homeDir);
  }
});

test('CLI start/status/stop manages pid lifecycle', async () => {
  const homeDir = makeTempHome();
  try {
    const binDir = path.join(homeDir, 'bin');
    const paths = resolvePaths(homeDir);
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(paths.sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.sessionsDir, '2026-03-09-0900.md'), 'briefing', 'utf8');

    fs.writeFileSync(
      path.join(binDir, 'motion'),
      `#!/bin/sh
if [ "$1" = "arb" ]; then
  printf '[]'
else
  printf '[]'
fi
`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(binDir, 'claude'),
      `#!/bin/sh
printf 'PASS: stub pass\n'
`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(binDir, 'osascript'),
      `#!/bin/sh
exit 0
`,
      'utf8'
    );
    fs.chmodSync(path.join(binDir, 'motion'), 0o755);
    fs.chmodSync(path.join(binDir, 'claude'), 0o755);
    fs.chmodSync(path.join(binDir, 'osascript'), 0o755);

    const env = {
      ...process.env,
      HOME: homeDir,
      PATH: `${binDir}:${process.env.PATH}`,
    };

    const child = spawn(process.execPath, ['bin/signal-daemon', 'start'], {
      cwd: path.resolve('.'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let startOutput = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      startOutput += chunk;
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('signal-daemon did not start')), 5000);
      const checkStarted = () => {
        if (startOutput.includes('signal-daemon running')) {
          clearTimeout(timeout);
          resolve();
        }
      };
      child.stdout.on('data', checkStarted);
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`signal-daemon exited early with code ${code}`));
      });
      checkStarted();
    });

    const pid = Number(fs.readFileSync(paths.pidPath, 'utf8').trim());
    assert.equal(Number.isInteger(pid), true);
    assert.equal(pid, child.pid);

    const statusStdout = [];
    const statusChild = spawn(process.execPath, ['bin/signal-daemon', 'status'], {
      cwd: path.resolve('.'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    statusChild.stdout.setEncoding('utf8');
    statusChild.stdout.on('data', (chunk) => statusStdout.push(chunk));
    const [statusCode] = await once(statusChild, 'exit');
    assert.equal(statusCode, 0);
    assert.match(statusStdout.join(''), /signal-daemon running \| pid=\d+ \| uptime=\d+s \| processed=0 \| tier=active/);

    const stopStdout = [];
    const stopChild = spawn(process.execPath, ['bin/signal-daemon', 'stop'], {
      cwd: path.resolve('.'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    stopChild.stdout.setEncoding('utf8');
    stopChild.stdout.on('data', (chunk) => stopStdout.push(chunk));
    const [stopCode] = await once(stopChild, 'exit');
    assert.equal(stopCode, 0);
    assert.match(stopStdout.join(''), new RegExp(`Stopped signal-daemon \\(pid=${pid}\\)`));

    await waitFor(() => child.exitCode !== null);
    assert.equal(child.exitCode, 0);
    assert.equal(child.signalCode, null);
    assert.equal(fs.existsSync(paths.pidPath), false);
  } finally {
    cleanupDir(homeDir);
  }
});
