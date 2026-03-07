import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';

const execFileAsync = promisify(execFileCallback);

export const DEFAULT_CONFIG = {
  daemon: {
    poll_interval_seconds: 30,
  },
  rules: {
    arb: {
      min_spread_pct: 10,
      min_liquidity: 1000,
      asset_whitelist: [],
    },
    alerts: {
      min_severity: 'medium',
      category_whitelist: [],
    },
  },
  notify: {
    terminal_log: '~/docs/signals/',
    macos_notification: true,
  },
  claude: {
    fail_open: true,
  },
};

export const DEFAULT_CONFIG_YAML = `daemon:
  poll_interval_seconds: 30
rules:
  arb:
    min_spread_pct: 10
    min_liquidity: 1000
    asset_whitelist: []
  alerts:
    min_severity: medium
    category_whitelist: []
notify:
  terminal_log: ~/docs/signals/
  macos_notification: true
claude:
  fail_open: true
`;

const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical'];

function cloneDefaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function mergeObjects(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return override ?? base;
  }

  const result = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (
      current &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      result[key] = mergeObjects(current, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function parseScalar(value) {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (value === '[]') {
    return [];
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseConfigYaml(content) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) {
      continue;
    }

    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const remainder = line.slice(separator + 1).trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].value;
    if (remainder === '') {
      parent[key] = {};
      stack.push({ indent, value: parent[key] });
    } else {
      parent[key] = parseScalar(remainder);
    }
  }

  return root;
}

export function expandHome(inputPath, homeDir = os.homedir()) {
  if (!inputPath) {
    return inputPath;
  }
  if (inputPath === '~') {
    return homeDir;
  }
  if (inputPath.startsWith('~/')) {
    return path.join(homeDir, inputPath.slice(2));
  }
  return inputPath;
}

export function resolvePaths(homeDir = os.homedir()) {
  const configDir = path.join(homeDir, '.config', 'signal-daemon');
  return {
    homeDir,
    binPath: path.join(homeDir, 'bin', 'signal-daemon'),
    configDir,
    configPath: path.join(configDir, 'config.yaml'),
    pidPath: path.join(configDir, 'daemon.pid'),
    statePath: path.join(configDir, 'runtime-state.json'),
    sessionsDir: path.join(homeDir, 'docs', 'sessions'),
    defaultLogDir: path.join(homeDir, 'docs', 'signals'),
  };
}

export function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function ensureDefaultConfig(paths) {
  ensureDirectory(paths.configDir);
  if (!fs.existsSync(paths.configPath)) {
    fs.writeFileSync(paths.configPath, DEFAULT_CONFIG_YAML, 'utf8');
  }
}

export function loadConfig(paths) {
  ensureDefaultConfig(paths);
  const parsed = parseConfigYaml(fs.readFileSync(paths.configPath, 'utf8')) ?? {};
  const merged = mergeObjects(cloneDefaultConfig(), parsed);
  merged.notify.terminal_log = expandHome(merged.notify.terminal_log, paths.homeDir);
  return merged;
}

export function determineTier(intervalSeconds) {
  return intervalSeconds >= 600 ? 'test' : 'active';
}

export function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readPid(paths) {
  if (!fs.existsSync(paths.pidPath)) {
    return null;
  }
  const value = Number.parseInt(fs.readFileSync(paths.pidPath, 'utf8').trim(), 10);
  return Number.isInteger(value) ? value : null;
}

export function writePid(paths, pid = process.pid) {
  fs.writeFileSync(paths.pidPath, `${pid}\n`, 'utf8');
}

export function clearRuntimeFiles(paths) {
  for (const filePath of [paths.pidPath, paths.statePath]) {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
  }
}

export function loadRuntimeState(paths) {
  if (!fs.existsSync(paths.statePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
  } catch {
    return null;
  }
}

export function saveRuntimeState(paths, state) {
  fs.writeFileSync(paths.statePath, JSON.stringify(state, null, 2), 'utf8');
}

function normalizeListCandidate(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }

  for (const key of ['items', 'results', 'data', 'alerts', 'arbs', 'opportunities']) {
    if (Array.isArray(parsed[key])) {
      return parsed[key];
    }
  }

  return [];
}

export function parseSignalList(rawJson) {
  const parsed = JSON.parse(rawJson);
  return normalizeListCandidate(parsed);
}

function normalizeAssetName(signal) {
  return signal.asset ?? signal.symbol ?? signal.market ?? signal.name ?? signal.outcome ?? 'unknown';
}

function normalizeCategory(signal) {
  return signal.category ?? signal.type ?? signal.kind ?? 'unknown';
}

export function passesArbRules(signal, rules) {
  const spread = Number(signal.spreadPct ?? signal.spread_pct ?? 0);
  if (spread < Number(rules.min_spread_pct ?? 0)) {
    return false;
  }

  const venues = Array.isArray(signal.venues) ? signal.venues : [];
  const hasLiquidity = venues.some((venue) => Number(venue?.liquidity ?? 0) >= Number(rules.min_liquidity ?? 0));
  if (!hasLiquidity) {
    return false;
  }

  if (Array.isArray(rules.asset_whitelist) && rules.asset_whitelist.length > 0) {
    return rules.asset_whitelist.includes(normalizeAssetName(signal));
  }

  return true;
}

export function passesAlertRules(signal, rules) {
  const severity = String(signal.severity ?? 'low').toLowerCase();
  const threshold = String(rules.min_severity ?? 'low').toLowerCase();
  const severityIndex = SEVERITY_ORDER.indexOf(severity);
  const thresholdIndex = SEVERITY_ORDER.indexOf(threshold);

  if (severityIndex === -1 || thresholdIndex === -1 || severityIndex < thresholdIndex) {
    return false;
  }

  if (Array.isArray(rules.category_whitelist) && rules.category_whitelist.length > 0) {
    return rules.category_whitelist.includes(normalizeCategory(signal));
  }

  return true;
}

export function getSignalId(signalType, signal) {
  if (signalType === 'ARB') {
    return signal.outcomeId ?? null;
  }
  return signal.id ?? null;
}

export function getLatestBriefingFile(paths) {
  if (!fs.existsSync(paths.sessionsDir)) {
    return null;
  }

  const files = fs
    .readdirSync(paths.sessionsDir)
    .filter((entry) => entry.endsWith('.md'))
    .sort();

  if (files.length === 0) {
    return null;
  }

  return path.join(paths.sessionsDir, files[files.length - 1]);
}

export function buildClaudePrompt({ briefing, signalType, signal }) {
  return [
    "You are a trading signal filter. Given today's session briefing and this signal, answer: is this worth the trader's attention?",
    '',
    'Session briefing:',
    briefing,
    '',
    'Signal:',
    JSON.stringify({ signalType, signal }, null, 2),
    '',
    'Respond with exactly:',
    'PASS: <one-line reason>',
    'or',
    'SKIP: <one-line reason>',
  ].join('\n');
}

export function parseClaudeDecision(output, failOpen = true) {
  const trimmed = output.trim();
  const passMatch = trimmed.match(/^PASS:\s*(.+)$/i);
  if (passMatch) {
    return { verdict: 'PASS', reason: passMatch[1].trim(), evaluationUnavailable: false };
  }

  const skipMatch = trimmed.match(/^SKIP:\s*(.+)$/i);
  if (skipMatch) {
    return { verdict: 'SKIP', reason: skipMatch[1].trim(), evaluationUnavailable: false };
  }

  if (failOpen) {
    return { verdict: 'PASS', reason: 'evaluation unavailable', evaluationUnavailable: true };
  }

  return { verdict: 'SKIP', reason: 'unrecognized evaluator output', evaluationUnavailable: true };
}

async function defaultCommandRunner(command, args, options = {}) {
  return execFileAsync(command, args, {
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}

export function createDependencies(overrides = {}) {
  return {
    runCommand: overrides.runCommand ?? defaultCommandRunner,
    sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: overrides.now ?? (() => new Date()),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
  };
}

function formatVenueSummary(venues) {
  if (!Array.isArray(venues) || venues.length === 0) {
    return 'no venue detail';
  }
  return venues
    .slice(0, 2)
    .map((venue) => {
      const name = venue.name ?? venue.venue ?? 'venue';
      const price = venue.price ?? venue.mid ?? venue.odds ?? '?';
      return `${name} ${price}`;
    })
    .join(' -> ');
}

export function formatSignalLine(signalType, signal, verdict, reason, timestamp = new Date()) {
  const hhmmss = timestamp.toTimeString().slice(0, 8);
  if (signalType === 'ARB') {
    const label = signal.name ?? signal.outcome ?? normalizeAssetName(signal);
    const spread = Number(signal.spreadPct ?? signal.spread_pct ?? 0).toFixed(1);
    return `${hhmmss} | ARB | ${label} | ${formatVenueSummary(signal.venues)} | ${spread}% | ${verdict}: ${reason}`;
  }

  const label = signal.title ?? signal.headline ?? normalizeCategory(signal);
  const severity = String(signal.severity ?? 'unknown').toUpperCase();
  return `${hhmmss} | ALERT | ${label} | ${normalizeCategory(signal)} | ${severity} | ${verdict}: ${reason}`;
}

export async function evaluateSignal({
  signalType,
  signal,
  briefing,
  failOpen,
  dependencies,
}) {
  try {
    const prompt = buildClaudePrompt({ briefing, signalType, signal });
    const result = await dependencies.runCommand('claude', [
      '--print',
      '--output-format',
      'text',
      '--permission-mode',
      'bypassPermissions',
      '--tools',
      '',
      prompt,
    ]);
    return parseClaudeDecision(result.stdout, failOpen);
  } catch {
    if (failOpen) {
      return { verdict: 'PASS', reason: 'evaluation unavailable', evaluationUnavailable: true };
    }
    throw new Error('Claude evaluation failed');
  }
}

export async function sendMacNotification(signalType, signal, reason, dependencies) {
  const title = signalType === 'ARB' ? 'ARB Signal' : 'Alert Signal';
  const body =
    signalType === 'ARB'
      ? `${signal.name ?? signal.outcome ?? normalizeAssetName(signal)} (${Number(signal.spreadPct ?? signal.spread_pct ?? 0).toFixed(1)}%)`
      : `${signal.title ?? signal.headline ?? normalizeCategory(signal)} (${String(signal.severity ?? 'unknown')})`;
  const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} subtitle ${JSON.stringify(reason)}`;
  await dependencies.runCommand('osascript', ['-e', script]);
}

export async function appendSignalLog(logDir, line, timestamp = new Date()) {
  ensureDirectory(logDir);
  const date = timestamp.toISOString().slice(0, 10);
  const logPath = path.join(logDir, `${date}.log`);
  fs.appendFileSync(logPath, `${line}\n`, 'utf8');
  return logPath;
}

export async function fetchSignals(dependencies) {
  const [arbResult, alertResult] = await Promise.all([
    dependencies.runCommand('motion', ['arb', 'scan', '--actionable', '--json']),
    dependencies.runCommand('motion', ['alerts', 'list', '--json']),
  ]);

  return {
    arbs: parseSignalList(arbResult.stdout),
    alerts: parseSignalList(alertResult.stdout),
  };
}

export async function processPollCycle({
  signals,
  config,
  seenIds,
  briefing,
  dependencies,
  state,
}) {
  let processed = 0;

  const work = [
    ...signals.arbs.map((signal) => ({ signalType: 'ARB', signal, passes: passesArbRules(signal, config.rules.arb) })),
    ...signals.alerts.map((signal) => ({ signalType: 'ALERT', signal, passes: passesAlertRules(signal, config.rules.alerts) })),
  ];

  for (const item of work) {
    const id = getSignalId(item.signalType, item.signal);
    if (!id || seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);

    if (!item.passes) {
      continue;
    }

    const decision = await evaluateSignal({
      signalType: item.signalType,
      signal: item.signal,
      briefing,
      failOpen: config.claude.fail_open,
      dependencies,
    });

    const timestamp = dependencies.now();
    const line = formatSignalLine(item.signalType, item.signal, decision.verdict, decision.reason, timestamp);
    await appendSignalLog(config.notify.terminal_log, line, timestamp);
    processed += 1;
    state.processedSignals += 1;
    state.lastSignalAt = timestamp.toISOString();

    if (decision.verdict === 'PASS' && config.notify.macos_notification) {
      await sendMacNotification(item.signalType, item.signal, decision.reason, dependencies);
    }
  }

  return processed;
}

export function getStatus(paths) {
  const pid = readPid(paths);
  const state = loadRuntimeState(paths);
  const running = pid !== null && isProcessRunning(pid);

  if (!running) {
    return {
      running: false,
      pid,
      uptimeSeconds: 0,
      processedSignals: state?.processedSignals ?? 0,
      tier: state?.tier ?? null,
    };
  }

  const startedAt = state?.startedAt ? new Date(state.startedAt) : null;
  const uptimeSeconds = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000)) : 0;

  return {
    running: true,
    pid,
    uptimeSeconds,
    processedSignals: state?.processedSignals ?? 0,
    tier: state?.tier ?? null,
  };
}

export async function runLoop(paths, config, dependencies) {
  const seenIds = new Set();
  const intervalMs = Number(config.daemon.poll_interval_seconds) * 1000;
  const tier = determineTier(Number(config.daemon.poll_interval_seconds));
  const state = {
    pid: process.pid,
    startedAt: dependencies.now().toISOString(),
    processedSignals: 0,
    lastSignalAt: null,
    tier,
    intervalSeconds: Number(config.daemon.poll_interval_seconds),
  };

  saveRuntimeState(paths, state);
  writePid(paths);

  let stopping = false;
  const cleanup = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    clearRuntimeFiles(paths);
  };

  const signalHandler = () => {
    cleanup();
    process.exit(0);
  };

  process.on('SIGINT', signalHandler);
  process.on('SIGTERM', signalHandler);

  dependencies.stdout.write(
    `signal-daemon running | pid=${process.pid} | interval=${config.daemon.poll_interval_seconds}s | tier=${tier}\n`
  );

  try {
    while (true) {
      const briefingFile = getLatestBriefingFile(paths);
      const briefing = briefingFile ? fs.readFileSync(briefingFile, 'utf8') : 'No session briefing available.';
      const signals = await fetchSignals(dependencies);
      await processPollCycle({ signals, config, seenIds, briefing, dependencies, state });
      saveRuntimeState(paths, state);
      await dependencies.sleep(intervalMs);
    }
  } finally {
    process.off('SIGINT', signalHandler);
    process.off('SIGTERM', signalHandler);
    cleanup();
  }
}
