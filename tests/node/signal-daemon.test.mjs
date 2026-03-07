import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
