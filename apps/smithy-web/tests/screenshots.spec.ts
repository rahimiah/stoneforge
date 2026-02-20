/**
 * Playwright screenshot tests for Smithy Web (Orchestrator Dashboard).
 *
 * These tests seed real data through the API and mock agent data for
 * realistic screenshots used in project documentation under docs/images/.
 *
 * Run with: npx playwright test tests/screenshots.spec.ts
 */

import { test, expect, type Page } from '@playwright/test';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = resolve(__dirname, '../../../docs/images/smithy-web');

// --- Mock Data for Agents ---

const now = new Date().toISOString();
const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
const tenMinAgo = new Date(Date.now() - 10 * 60000).toISOString();
const oneHourAgo = new Date(Date.now() - 60 * 60000).toISOString();

const mockAgents = [
  {
    id: 'el-d001',
    type: 'entity',
    name: 'director-main',
    entityType: 'agent',
    status: 'active',
    createdAt: oneHourAgo,
    updatedAt: fiveMinAgo,
    createdBy: 'el-0000',
    tags: [],
    metadata: {
      agent: {
        agentRole: 'director',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        sessionStatus: 'running',
        currentSessionId: 'session-001',
      },
    },
  },
  {
    id: 'el-w001',
    type: 'entity',
    name: 'worker-alpha',
    entityType: 'agent',
    status: 'active',
    createdAt: oneHourAgo,
    updatedAt: fiveMinAgo,
    createdBy: 'el-0000',
    tags: [],
    metadata: {
      agent: {
        agentRole: 'worker',
        workerMode: 'ephemeral',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        sessionStatus: 'running',
        currentSessionId: 'session-002',
        branch: 'agent/worker-alpha/el-t001-implement-auth',
      },
    },
  },
  {
    id: 'el-w002',
    type: 'entity',
    name: 'worker-beta',
    entityType: 'agent',
    status: 'active',
    createdAt: oneHourAgo,
    updatedAt: now,
    createdBy: 'el-0000',
    tags: [],
    metadata: {
      agent: {
        agentRole: 'worker',
        workerMode: 'ephemeral',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        sessionStatus: 'running',
        currentSessionId: 'session-003',
        branch: 'agent/worker-beta/el-t006-doc-versioning',
      },
    },
  },
  {
    id: 'el-s001',
    type: 'entity',
    name: 'merge-steward',
    entityType: 'agent',
    status: 'active',
    createdAt: oneHourAgo,
    updatedAt: tenMinAgo,
    createdBy: 'el-0000',
    tags: [],
    metadata: {
      agent: {
        agentRole: 'steward',
        stewardFocus: 'merge',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        sessionStatus: 'idle',
        triggers: [{ type: 'event', event: 'task.awaiting_merge' }],
      },
    },
  },
];

// --- Helpers ---

async function getOperator(page: Page): Promise<{ id: string; name: string }> {
  const res = await page.request.get('/api/entities');
  const data = await res.json();
  const entities = Array.isArray(data) ? data : data.entities ?? [];
  return entities[0] ?? { id: 'el-0000', name: 'operator' };
}

async function seedTasks(page: Page, operatorId: string) {
  const taskDefs = [
    { title: 'Implement user authentication with JWT', priority: 1, complexity: 5, taskType: 'feature', tags: ['auth', 'security'] },
    { title: 'Add rate limiting to API endpoints', priority: 2, complexity: 3, taskType: 'feature', tags: ['api', 'security'] },
    { title: 'Fix CSS overflow on mobile sidebar', priority: 3, complexity: 1, taskType: 'bug', tags: ['ui', 'mobile'] },
    { title: 'Write unit tests for storage layer', priority: 2, complexity: 3, taskType: 'task', tags: ['testing'] },
    { title: 'Add WebSocket event filtering', priority: 3, complexity: 2, taskType: 'feature', tags: ['api', 'websocket'] },
    { title: 'Refactor document versioning system', priority: 2, complexity: 4, taskType: 'task', tags: ['documents', 'refactor'] },
  ];

  const tasks: Array<{ id: string; title: string }> = [];
  for (const t of taskDefs) {
    const res = await page.request.post('/api/tasks', {
      data: { title: t.title, createdBy: operatorId, priority: t.priority, complexity: t.complexity, taskType: t.taskType, tags: t.tags },
    });
    if (res.ok()) {
      const task = await res.json();
      tasks.push(task);
    }
  }

  // Update some task statuses
  if (tasks.length >= 4) {
    await page.request.patch(`/api/tasks/${tasks[0].id}`, { data: { status: 'in_progress' } }).catch(() => {});
    await page.request.patch(`/api/tasks/${tasks[2].id}`, { data: { status: 'completed' } }).catch(() => {});
    await page.request.patch(`/api/tasks/${tasks[3].id}`, { data: { status: 'in_progress' } }).catch(() => {});
  }

  return tasks;
}

function setupAgentMocks(page: Page) {
  return page.route('**/api/agents*', (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ agents: mockAgents }),
      });
    } else {
      route.continue();
    }
  });
}

// --- Screenshot Tests ---

test.describe('Documentation Screenshots - Smithy Web', () => {
  test.beforeAll(async ({ browser }) => {
    // Seed data once before all tests
    const page = await browser.newPage();
    try {
      const operator = await getOperator(page);
      await seedTasks(page, operator.id);
    } catch {
      // Seeding may fail if data already exists — that's OK
    }
    await page.close();
  });

  test('activity-feed: Activity page with recent events', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/activity');
    // Wait for loading spinner to disappear and content to render
    await page.waitForTimeout(1000);
    await page.waitForFunction(() => {
      const loading = document.querySelector('[data-testid="loading-indicator"]');
      return !loading || loading.getAttribute('aria-hidden') === 'true';
    }, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/activity-feed.png`,
      fullPage: false,
    });
  });

  test('tasks-list-view: Tasks page in list view', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/tasks');
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/tasks-list-view.png`,
      fullPage: false,
    });
  });

  test('tasks-kanban-view: Tasks page in kanban view', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/tasks');
    await page.waitForTimeout(1000);

    const kanbanBtn = page.getByTestId('tasks-view-kanban');
    if (await kanbanBtn.isVisible().catch(() => false)) {
      await kanbanBtn.click();
      await page.waitForTimeout(1000);
    }
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/tasks-kanban-view.png`,
      fullPage: false,
    });
  });

  test('tasks-create-dialog: Create task dialog', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/tasks');
    await page.waitForTimeout(1000);

    // Try multiple possible testids for create button
    const createBtn = page.getByTestId('create-task-button');
    if (await createBtn.isVisible().catch(() => false)) {
      await createBtn.click();
      await page.waitForTimeout(500);
    }
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/tasks-create-dialog.png`,
      fullPage: false,
    });
  });

  test('agents-list: Agents page showing registered agents', async ({ page }) => {
    await setupAgentMocks(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/agents');
    // Wait for agents page and content to render
    await page.waitForTimeout(1000);
    await page.getByTestId('agents-page').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/agents-list.png`,
      fullPage: false,
    });
  });

  test('agents-graph: Agent workspace graph visualization', async ({ page }) => {
    await setupAgentMocks(page);
    await page.route('**/api/tasks*', (route) => {
      if (route.request().url().includes('/agents')) {
        return;
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tasks: [] }),
      });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/agents?tab=graph');
    await page.waitForTimeout(2500);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/agents-graph.png`,
      fullPage: false,
    });
  });

  test('create-agent-dialog: Create agent dialog', async ({ page }) => {
    await setupAgentMocks(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/agents');
    await page.waitForTimeout(1000);

    await page.getByTestId('agents-create').click();
    await expect(page.getByTestId('create-agent-dialog')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(500);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/create-agent-dialog.png`,
      fullPage: false,
    });
  });

  test('stewards-tab: Stewards management', async ({ page }) => {
    await setupAgentMocks(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/agents?tab=stewards');
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/stewards-tab.png`,
      fullPage: false,
    });
  });

  test('plans-page: Plans management', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/plans');
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/plans.png`,
      fullPage: false,
    });
  });

  test('merge-requests: Merge requests page', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/merge-requests');
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/merge-requests.png`,
      fullPage: false,
    });
  });

  test('workspaces-page: Workspaces terminal multiplexer', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/workspaces');
    await page.waitForTimeout(1500);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/workspaces.png`,
      fullPage: false,
    });
  });

  test('metrics-page: Metrics dashboard', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/metrics');
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/metrics.png`,
      fullPage: false,
    });
  });

  test('messages-page: Messages / channels page', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/messages');
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/messages-channels.png`,
      fullPage: false,
    });
  });

  test('documents-page: Documents and library page', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/documents');
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/documents-library.png`,
      fullPage: false,
    });
  });

  test('settings-page: Settings configuration page', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/settings');
    await page.waitForTimeout(1500);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/settings.png`,
      fullPage: false,
    });
  });

  test('workflows-page: Workflows management', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/workflows');
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/workflows.png`,
      fullPage: false,
    });
  });
});
