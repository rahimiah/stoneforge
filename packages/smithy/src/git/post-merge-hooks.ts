import fs from 'node:fs/promises';
import path from 'node:path';

export interface MergedTaskContext {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  tags: string[];
  taskType: string;
  priority: number;
  complexity: number;
}

export interface PostMergeHookContext {
  workspaceRoot: string;
  mergeWorktreePath: string;
  sourceBranch: string;
  targetBranch: string;
  commitMessage: string;
  commitHash: string;
  mergedAt: string;
  task?: MergedTaskContext;
}

export interface GitPostMergeHookResult {
  hookName: string;
  success: boolean;
  filesChanged?: string[];
  error?: string;
}

export interface GitPostMergeHook {
  readonly name: string;
  run(context: PostMergeHookContext): Promise<GitPostMergeHookResult>;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'release-note';
}

function stripMarkdown(value: string): string {
  return value
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~>-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSummary(task: MergedTaskContext): string {
  const candidates = [
    task.description,
    task.acceptanceCriteria,
    task.title,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  for (const candidate of candidates) {
    const normalized = stripMarkdown(candidate);
    if (normalized.length > 0) {
      return normalized.slice(0, 240);
    }
  }

  return task.title;
}

function buildChangelogBlock(context: PostMergeHookContext, entryRelativePath: string): string {
  if (!context.task) {
    return [
      `## ${context.mergedAt.slice(0, 10)}`,
      '',
      `- Merged \`${context.sourceBranch}\` into \`${context.targetBranch}\` (${context.commitHash.slice(0, 8)}).`,
      '',
    ].join('\n');
  }

  const summary = buildSummary(context.task);
  return [
    `## ${context.mergedAt.slice(0, 10)}`,
    '',
    `- \`${context.task.id}\` ${context.task.title}`,
    `  ${summary}`,
    `  Details: \`${entryRelativePath}\``,
    '',
  ].join('\n');
}

function buildEntryDocument(context: PostMergeHookContext): string {
  const lines = [
    `# ${context.task?.title ?? `Merge ${context.sourceBranch}`}`,
    '',
    `- Task: ${context.task?.id ?? 'n/a'}`,
    `- Merged at: ${context.mergedAt}`,
    `- Source branch: ${context.sourceBranch}`,
    `- Target branch: ${context.targetBranch}`,
    `- Commit: ${context.commitHash}`,
  ];

  if (context.task) {
    lines.push(
      `- Type: ${context.task.taskType}`,
      `- Priority: ${context.task.priority}`,
      `- Complexity: ${context.task.complexity}`
    );

    if (context.task.tags.length > 0) {
      lines.push(`- Tags: ${context.task.tags.join(', ')}`);
    }
  }

  const sections: string[] = [lines.join('\n')];

  if (context.task?.description?.trim()) {
    sections.push(`## Summary\n\n${context.task.description.trim()}`);
  } else if (context.task?.acceptanceCriteria?.trim()) {
    sections.push(`## Acceptance Criteria\n\n${context.task.acceptanceCriteria.trim()}`);
  }

  return `${sections.join('\n\n')}\n`;
}

export class ReleaseDocsHook implements GitPostMergeHook {
  readonly name = 'release-docs';

  async run(context: PostMergeHookContext): Promise<GitPostMergeHookResult> {
    const changelogPath = path.join(context.mergeWorktreePath, 'CHANGELOG.md');
    const changelogDir = path.join(context.mergeWorktreePath, 'docs', 'changelog');
    const entryFileName = `${context.mergedAt.slice(0, 10)}-${slugify(
      context.task?.id ? `${context.task.id}-${context.task.title}` : context.sourceBranch
    )}.md`;
    const entryPath = path.join(changelogDir, entryFileName);
    const entryRelativePath = path.posix.join('docs', 'changelog', entryFileName);

    await fs.mkdir(changelogDir, { recursive: true });
    await fs.writeFile(entryPath, buildEntryDocument(context), 'utf8');

    let existing = '# Changelog\n\n';
    try {
      existing = await fs.readFile(changelogPath, 'utf8');
    } catch {
      // Create a fresh changelog when the repo doesn't have one yet.
    }

    const block = buildChangelogBlock(context, entryRelativePath);
    const updated = existing.startsWith('# Changelog')
      ? existing.replace(/^# Changelog\s*\n*/u, `# Changelog\n\n${block}`)
      : `# Changelog\n\n${block}${existing}`;

    await fs.writeFile(changelogPath, updated, 'utf8');

    return {
      hookName: this.name,
      success: true,
      filesChanged: [
        'CHANGELOG.md',
        entryRelativePath,
      ],
    };
  }
}
