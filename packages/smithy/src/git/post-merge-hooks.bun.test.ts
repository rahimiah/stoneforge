import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ReleaseDocsHook, type PostMergeHookContext } from './post-merge-hooks.js';

function createTempDir(): string {
  const dir = path.join('/tmp', `release-docs-hook-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  return dir;
}

function rmrf(dir: string) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createContext(mergeWorktreePath: string): PostMergeHookContext {
  return {
    workspaceRoot: mergeWorktreePath,
    mergeWorktreePath,
    sourceBranch: 'agent/worker/example',
    targetBranch: 'main',
    commitMessage: 'feat: release docs hook',
    commitHash: '1234567890abcdef',
    mergedAt: '2026-03-23T12:00:00.000Z',
    task: {
      id: 'el-1pk2',
      title: 'Release documentation post-merge hook',
      description: 'Create ReleaseDocsHook that auto-generates changelog entries from merged task context.',
      acceptanceCriteria: 'Prepends to CHANGELOG.md and writes individual entry files to docs/changelog/.',
      tags: ['docs', 'automation'],
      taskType: 'feature',
      priority: 3,
      complexity: 3,
    },
  };
}

describe('ReleaseDocsHook', () => {
  test('prepends CHANGELOG.md and writes an individual changelog entry', async () => {
    const dir = createTempDir();
    try {
      fs.writeFileSync(
        path.join(dir, 'CHANGELOG.md'),
        '# Changelog\n\n## 0.1.0 (Unreleased)\n\nExisting entry.\n',
        'utf8'
      );

      const hook = new ReleaseDocsHook();
      const result = await hook.run(createContext(dir));

      expect(result.success).toBe(true);
      expect(result.filesChanged).toContain('CHANGELOG.md');

      const changelog = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
      expect(changelog).toContain('`el-1pk2` Release documentation post-merge hook');
      expect(changelog).toContain('Details: `docs/changelog/2026-03-23-el-1pk2-release-documentation-post-merge-hook.md`');
      expect(changelog.indexOf('`el-1pk2`')).toBeLessThan(changelog.indexOf('## 0.1.0 (Unreleased)'));

      const entryPath = path.join(
        dir,
        'docs/changelog/2026-03-23-el-1pk2-release-documentation-post-merge-hook.md'
      );
      const entry = fs.readFileSync(entryPath, 'utf8');
      expect(entry).toContain('# Release documentation post-merge hook');
      expect(entry).toContain('- Task: el-1pk2');
      expect(entry).toContain('## Summary');
    } finally {
      rmrf(dir);
    }
  });

  test('creates CHANGELOG.md when it does not exist', async () => {
    const dir = createTempDir();
    try {
      const hook = new ReleaseDocsHook();
      await hook.run(createContext(dir));

      const changelog = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
      expect(changelog.startsWith('# Changelog')).toBe(true);
      expect(changelog).toContain('Release documentation post-merge hook');
    } finally {
      rmrf(dir);
    }
  });
});
