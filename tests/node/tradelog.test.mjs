import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  compareSnapshots,
  renderPositionChanges,
  resolveTradelogPaths,
} from '../../bin/tradelog';

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tradelog-test-'));
}

function cleanupDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function writeSnapshot(filePath, snapshot) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
}

test('renderPositionChanges handles missing snapshot files', () => {
  assert.equal(renderPositionChanges(null, null), 'No snapshot found. Run /briefing first.');
  assert.equal(
    renderPositionChanges({ timestamp: '2026-03-07T14:30:00Z', positions: [] }, null),
    'No snapshot found. Run /briefing first.'
  );
  assert.equal(
    renderPositionChanges(null, { timestamp: '2026-03-07T16:28:00Z', positions: [] }),
    'No previous snapshot. Run /briefing twice to start tracking changes.'
  );
});

test('renderPositionChanges handles empty snapshots and no changes', () => {
  const previous = { timestamp: '2026-03-07T14:30:00Z', positions: [] };
  const latest = { timestamp: '2026-03-07T16:28:00Z', positions: [] };
  assert.equal(renderPositionChanges(previous, latest), 'No positions tracked in either snapshot.');

  const unchanged = {
    timestamp: '2026-03-07T16:28:00Z',
    positions: [{ venue: 'HL', symbol: 'BTC', side: 'long', size: 0.5, entry: 69200 }],
  };
  assert.equal(
    renderPositionChanges({ ...unchanged, timestamp: '2026-03-07T14:30:00Z' }, unchanged),
    'No position changes since last briefing (2026-03-07 14:30 UTC).'
  );
});

test('compareSnapshots detects opened, closed, and sized positions', () => {
  const previous = {
    timestamp: '2026-03-07T14:30:00Z',
    positions: [
      { venue: 'HL', symbol: 'BTC', side: 'long', size: 0.5, entry: 69200, notional: 34600 },
      { venue: 'PM', symbol: 'Musk trillionaire', outcome: 'Yes', size: 50, avgPrice: 0.7 },
      { venue: 'PM', symbol: 'SpaceX IPO', outcome: 'Yes', size: 100, avgPrice: 0.52 },
    ],
  };
  const latest = {
    timestamp: '2026-03-07T16:28:00Z',
    positions: [
      { venue: 'HL', symbol: 'BTC', side: 'long', size: 0.5, entry: 69200, notional: 34600 },
      { venue: 'HL', symbol: 'ETH', side: 'short', size: 2, entry: 3500, notional: 7000 },
      { venue: 'PM', symbol: 'SpaceX IPO', outcome: 'Yes', size: 150, avgPrice: 0.52 },
    ],
  };

  const changes = compareSnapshots(previous, latest);
  assert.deepEqual(
    changes.map((change) => change.type),
    ['OPENED', 'SIZED', 'CLOSED']
  );

  const output = renderPositionChanges(previous, latest);
  assert.match(output, /POSITION CHANGES since 2026-03-07 14:30 UTC/);
  assert.match(output, /OPENED  HL\s+ETH short 2 @ \$3,500 \(\$7,000 notional\)/);
  assert.match(output, /SIZED   PM\s+SpaceX IPO Yes 100 -> 150 shares \(\+50\)/);
  assert.match(output, /CLOSED  PM\s+Musk trillionaire Yes 50 shares \(was \$0.70 entry\)/);
  assert.match(output, /3 changes detected/);
});

test('bin/tradelog reads snapshots from HOME and prints terminal output', () => {
  const homeDir = makeTempHome();
  try {
    const paths = resolveTradelogPaths(homeDir);
    writeSnapshot(paths.previousPath, {
      timestamp: '2026-03-07T14:30:00Z',
      positions: [{ venue: 'PM', symbol: 'SpaceX IPO', outcome: 'Yes', size: 100, avgPrice: 0.52 }],
    });
    writeSnapshot(paths.latestPath, {
      timestamp: '2026-03-07T16:28:00Z',
      positions: [{ venue: 'PM', symbol: 'SpaceX IPO', outcome: 'Yes', size: 150, avgPrice: 0.52 }],
    });

    const output = execFileSync('node', ['bin/tradelog'], {
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..'),
      env: { ...process.env, HOME: homeDir },
      encoding: 'utf8',
    });

    assert.match(output, /POSITION CHANGES since 2026-03-07 14:30 UTC/);
    assert.match(output, /SIZED   PM\s+SpaceX IPO Yes 100 -> 150 shares \(\+50\)/);
  } finally {
    cleanupDir(homeDir);
  }
});
