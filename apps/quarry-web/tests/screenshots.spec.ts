/**
 * Playwright screenshot tests for Quarry Web (Core Dashboard).
 *
 * These tests seed real data via the API, navigate to key pages, and capture
 * screenshots for use in project documentation under docs/images/.
 *
 * Run with: npx playwright test tests/screenshots.spec.ts
 */

import { test, expect, type Page } from '@playwright/test';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = resolve(__dirname, '../../../docs/images/quarry-web');

// --- Helpers ---

async function getOperator(page: Page): Promise<{ id: string; name: string }> {
  const res = await page.request.get('/api/entities');
  const data = await res.json();
  // API may return array or { entities: [...] }
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
    { title: 'Set up CI/CD pipeline for staging', priority: 1, complexity: 4, taskType: 'feature', tags: ['devops'] },
    { title: 'Update API documentation for v2', priority: 4, complexity: 2, taskType: 'task', tags: ['docs'] },
  ];

  const tasks: Array<{ id: string; title: string }> = [];
  for (const t of taskDefs) {
    const res = await page.request.post('/api/tasks', {
      data: {
        title: t.title,
        createdBy: operatorId,
        priority: t.priority,
        complexity: t.complexity,
        taskType: t.taskType,
        tags: t.tags,
      },
    });
    if (res.ok()) {
      const task = await res.json();
      tasks.push(task);
    }
  }

  // Update some task statuses
  if (tasks.length >= 3) {
    await page.request.patch(`/api/tasks/${tasks[0].id}`, { data: { status: 'in_progress' } });
    await page.request.patch(`/api/tasks/${tasks[2].id}`, { data: { status: 'completed' } });
    await page.request.patch(`/api/tasks/${tasks[3].id}`, { data: { status: 'in_progress' } });
  }

  return tasks;
}

async function seedPlan(page: Page, operatorId: string, taskIds: string[]) {
  const planRes = await page.request.post('/api/plans', {
    data: {
      title: 'Sprint 12 — Authentication & Security',
      createdBy: operatorId,
      status: 'active',
    },
  });
  if (planRes.ok()) {
    const plan = await planRes.json();
    for (const taskId of taskIds.slice(0, 4)) {
      await page.request.post(`/api/plans/${plan.id}/tasks`, {
        data: { taskId },
      }).catch(() => {});
    }
    return plan;
  }
  return null;
}

// --- Screenshot Tests ---

test.describe('Documentation Screenshots - Quarry Web', () => {
  test.describe.configure({ mode: 'serial' });

  let operatorId: string;
  let taskIds: string[] = [];

  test('00 - Seed data', async ({ page }) => {
    const operator = await getOperator(page);
    operatorId = operator.id;
    const tasks = await seedTasks(page, operatorId);
    taskIds = tasks.map((t) => t.id);
    await seedPlan(page, operatorId, taskIds);
    expect(tasks.length).toBeGreaterThan(0);
  });

  test('dashboard: Main dashboard with metrics overview', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/dashboard/overview');
    await page.waitForTimeout(2500);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/dashboard.png`,
      fullPage: false,
    });
  });

  test('tasks-list: Tasks list view', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/tasks');
    await expect(page.getByTestId('tasks-page')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1500);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/tasks-list.png`,
      fullPage: false,
    });
  });

  test('task-create: Task creation dialog', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/tasks');
    await expect(page.getByTestId('tasks-page')).toBeVisible({ timeout: 10000 });

    await page.getByTestId('create-task-button').click();
    await expect(page.getByTestId('create-task-modal')).toBeVisible();

    // Fill in form fields
    await page.getByTestId('create-task-title-input').fill('Add WebSocket real-time notifications');
    const createdBySelect = page.getByTestId('create-task-created-by-select');
    const options = await createdBySelect.locator('option').allTextContents();
    if (options.length > 1) {
      await createdBySelect.selectOption({ index: 1 });
    }
    await page.getByTestId('create-task-priority-select').selectOption('2');
    await page.getByTestId('create-task-complexity-select').selectOption('3');
    await page.getByTestId('create-task-type-select').selectOption('feature');
    // Tags input is a custom component — find the inner <input> within it
    const tagsContainer = page.getByTestId('create-task-tags-input');
    const tagsInput = tagsContainer.locator('input');
    if (await tagsInput.isVisible().catch(() => false)) {
      await tagsInput.fill('websocket');
      await tagsInput.press('Enter');
      await tagsInput.fill('real-time');
      await tagsInput.press('Enter');
      await tagsInput.fill('notifications');
      await tagsInput.press('Enter');
    }

    await page.waitForTimeout(500);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/task-create.png`,
      fullPage: false,
    });
  });

  test('task-detail: Task detail panel', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/tasks');
    await expect(page.getByTestId('tasks-page')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1500);

    const firstTask = page.locator('[data-testid^="task-row-"]').first();
    if (await firstTask.isVisible().catch(() => false)) {
      await firstTask.click();
      await page.waitForTimeout(1000);
    }
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/task-detail.png`,
      fullPage: false,
    });
  });

  test('tasks-kanban: Tasks kanban view', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/tasks');
    await expect(page.getByTestId('tasks-page')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    const kanbanToggle = page.getByTestId('view-toggle-kanban');
    if (await kanbanToggle.isVisible().catch(() => false)) {
      await kanbanToggle.click();
      await page.waitForTimeout(1500);
    }
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/tasks-kanban.png`,
      fullPage: false,
    });
  });

  test('plans: Plans page', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/plans');
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/plans.png`,
      fullPage: false,
    });
  });

  test('entities: Entity management page', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/entities');
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/entities.png`,
      fullPage: false,
    });
  });

  test('messages: Messages and channels', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/messages');
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/messages.png`,
      fullPage: false,
    });
  });

  test('documents: Document management', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/documents');
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/documents.png`,
      fullPage: false,
    });
  });

  test('settings: Settings page', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/settings');
    await page.waitForTimeout(1500);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/settings.png`,
      fullPage: false,
    });
  });

  test('inbox: Inbox page', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/inbox');
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/inbox.png`,
      fullPage: false,
    });
  });
});
