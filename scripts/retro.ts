import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ─── Types ───────────────────────────────────────────────────────────────────

interface CommitInfo {
  hash: string
  author: string
  date: string
  subject: string
  isMerge: boolean
}

interface AuthorStats {
  commits: number
  merges: number
  filesChanged: number
  insertions: number
  deletions: number
}

interface FileStats {
  path: string
  changes: number
}

interface RetroReport {
  weekStart: string
  weekEnd: string
  totalCommits: number
  totalMerges: number
  authors: Map<string, AuthorStats>
  topFiles: FileStats[]
  commits: CommitInfo[]
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, '..')
const RETROS_DIR = resolve(ROOT, 'docs', 'retros')

// ─── Helpers ─────────────────────────────────────────────────────────────────

function run(cmd: string): string {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe' }).trim()
  } catch {
    return ''
  }
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0]
}

function getWeekRange(): { since: string; until: string; sinceDate: Date; untilDate: Date } {
  const now = new Date()
  const until = new Date(now)
  const since = new Date(now)
  since.setDate(since.getDate() - 7)

  return {
    since: formatDate(since),
    until: formatDate(until),
    sinceDate: since,
    untilDate: until,
  }
}

// ─── Git Analysis ────────────────────────────────────────────────────────────

function getCommits(since: string, until: string): CommitInfo[] {
  const SEP = '<<SEP>>'
  const format = `%H${SEP}%an${SEP}%aI${SEP}%s${SEP}%P`
  const raw = run(
    `git log --after="${since}" --before="${until}T23:59:59" --format="${format}"`,
  )

  if (!raw) return []

  return raw.split('\n').filter(Boolean).map((line) => {
    const [hash, author, date, subject, parents] = line.split(SEP)
    const isMerge = (parents ?? '').trim().split(' ').length > 1
    return { hash, author, date, subject, isMerge }
  })
}

function getAuthorDiffStats(author: string, since: string, until: string): {
  filesChanged: number
  insertions: number
  deletions: number
} {
  const raw = run(
    `git log --author="${author}" --after="${since}" --before="${until}T23:59:59" --shortstat --format=""`,
  )

  let filesChanged = 0
  let insertions = 0
  let deletions = 0

  for (const line of raw.split('\n').filter(Boolean)) {
    const filesMatch = line.match(/(\d+) files? changed/)
    const insertMatch = line.match(/(\d+) insertions?\(\+\)/)
    const deleteMatch = line.match(/(\d+) deletions?\(-\)/)
    if (filesMatch) filesChanged += parseInt(filesMatch[1], 10)
    if (insertMatch) insertions += parseInt(insertMatch[1], 10)
    if (deleteMatch) deletions += parseInt(deleteMatch[1], 10)
  }

  return { filesChanged, insertions, deletions }
}

function getTopChangedFiles(since: string, until: string, limit = 15): FileStats[] {
  const raw = run(
    `git log --after="${since}" --before="${until}T23:59:59" --name-only --format=""`,
  )

  if (!raw) return []

  const fileCounts = new Map<string, number>()
  for (const file of raw.split('\n').filter(Boolean)) {
    fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1)
  }

  return [...fileCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([path, changes]) => ({ path, changes }))
}

// ─── Report Generation ──────────────────────────────────────────────────────

function buildReport(since: string, until: string): RetroReport {
  const commits = getCommits(since, until)
  const totalMerges = commits.filter((c) => c.isMerge).length

  // Per-author breakdown
  const authors = new Map<string, AuthorStats>()
  for (const commit of commits) {
    const existing = authors.get(commit.author) ?? {
      commits: 0,
      merges: 0,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    }
    existing.commits++
    if (commit.isMerge) existing.merges++
    authors.set(commit.author, existing)
  }

  // Enrich with diff stats
  for (const [author, stats] of authors) {
    const diff = getAuthorDiffStats(author, since, until)
    stats.filesChanged = diff.filesChanged
    stats.insertions = diff.insertions
    stats.deletions = diff.deletions
  }

  const topFiles = getTopChangedFiles(since, until)

  return {
    weekStart: since,
    weekEnd: until,
    totalCommits: commits.length,
    totalMerges,
    authors,
    topFiles,
    commits,
  }
}

function renderMarkdown(report: RetroReport): string {
  const lines: string[] = []
  const push = (line = '') => lines.push(line)

  push(`# Weekly Retro: ${report.weekStart} → ${report.weekEnd}`)
  push()
  push(`> Auto-generated on ${new Date().toISOString()}`)
  push()

  // ── Summary
  push(`## Summary`)
  push()
  push(`| Metric | Count |`)
  push(`|--------|-------|`)
  push(`| Total commits | ${report.totalCommits} |`)
  push(`| Merge commits | ${report.totalMerges} |`)
  push(`| Contributors | ${report.authors.size} |`)
  push()

  if (report.totalCommits === 0) {
    push(`_No commits found for this period._`)
    return lines.join('\n')
  }

  // ── Per-author breakdown
  push(`## Per-Author Breakdown`)
  push()
  push(`| Author | Commits | Merges | Files Changed | Insertions | Deletions |`)
  push(`|--------|---------|--------|---------------|------------|-----------|`)

  const sortedAuthors = [...report.authors.entries()].sort(
    (a, b) => b[1].commits - a[1].commits,
  )
  for (const [author, stats] of sortedAuthors) {
    push(
      `| ${author} | ${stats.commits} | ${stats.merges} | ${stats.filesChanged} | +${stats.insertions} | -${stats.deletions} |`,
    )
  }
  push()

  // ── Top changed files
  if (report.topFiles.length > 0) {
    push(`## Top Changed Files`)
    push()
    push(`| File | Commits Touching |`)
    push(`|------|-----------------|`)
    for (const file of report.topFiles) {
      push(`| \`${file.path}\` | ${file.changes} |`)
    }
    push()
  }

  // ── Merge commits
  const merges = report.commits.filter((c) => c.isMerge)
  if (merges.length > 0) {
    push(`## Merge Commits`)
    push()
    for (const commit of merges) {
      push(`- **${commit.subject}** — _${commit.author}_ (\`${commit.hash.slice(0, 8)}\`)`)
    }
    push()
  }

  // ── Recent commits
  push(`## All Commits`)
  push()
  for (const commit of report.commits) {
    const tag = commit.isMerge ? ' 🔀' : ''
    push(
      `- [\`${commit.hash.slice(0, 8)}\`] ${commit.subject}${tag} — _${commit.author}_ (${commit.date.split('T')[0]})`,
    )
  }
  push()

  return lines.join('\n')
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const { since, until } = getWeekRange()

  console.log(`📊 Generating weekly retro for ${since} → ${until}...`)

  const report = buildReport(since, until)
  const markdown = renderMarkdown(report)

  // Ensure output directory exists
  mkdirSync(RETROS_DIR, { recursive: true })

  const filename = `retro-${since}-to-${until}.md`
  const outputPath = resolve(RETROS_DIR, filename)

  writeFileSync(outputPath, markdown, 'utf-8')

  console.log(`✅ Report written to docs/retros/${filename}`)
  console.log(`   ${report.totalCommits} commits, ${report.totalMerges} merges, ${report.authors.size} contributors`)
}

main()
