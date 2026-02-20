# Web UI Reference

Stoneforge provides two web applications for managing your workspace:

- **Quarry Web** — Project management dashboard for tasks, plans, documents, and team coordination
- **Smithy Web** — Agent orchestration dashboard for managing AI agents, merge requests, and workspaces

## Quarry Web (Project Dashboard)

### Dashboard Overview

The main dashboard provides a bird's-eye view of your workspace: total tasks, ready vs blocked ratio, active agents, and tasks completed today. Quick action buttons let you create tasks or workflows instantly.

![Dashboard Overview](../images/quarry-web/dashboard.png)

### Tasks — List View

The tasks page displays all tasks in a sortable, filterable table. Each row shows title, status, priority, type, assignee, and tags. Use the search bar, sort/group dropdowns, and filter controls to find specific tasks.

![Tasks List View](../images/quarry-web/tasks-list.png)

### Tasks — Kanban View

Toggle to Kanban view to see tasks organized by status columns (Open, In Progress, Completed, etc.). Drag tasks between columns to update their status.

![Tasks Kanban View](../images/quarry-web/tasks-kanban.png)

### Create Task

Click **+ Create Task** to open the task creation dialog. Fill in the title, priority, complexity, type, assignee, and tags. The description field supports Markdown.

![Create Task Dialog](../images/quarry-web/task-create.png)

### Task Detail Panel

Click any task in the list to open the detail panel on the right. View and edit task properties, add descriptions, attach documents, and create blocker relationships.

![Task Detail Panel](../images/quarry-web/task-detail.png)

### Plans

Plans group related tasks into sprints or project phases. View plan progress, add/remove tasks, and track completion percentage.

![Plans Page](../images/quarry-web/plans.png)

### Entities

The entities page lists all registered users, agents, and other entities in your workspace. Click an entity to view their activity, assigned tasks, and contribution history.

![Entities Page](../images/quarry-web/entities.png)

### Messages

The messages page provides channel-based communication. Create channels for different topics, send messages, and search across conversations.

![Messages Page](../images/quarry-web/messages.png)

### Documents

Browse and manage your document library. Documents support Markdown content, versioning, and can be organized into libraries.

![Documents Page](../images/quarry-web/documents.png)

### Settings

Configure your workspace preferences: theme (Light/Dark/System), keyboard shortcuts, default views, and notification settings.

![Settings Page](../images/quarry-web/settings.png)

### Inbox

The inbox shows direct messages and @mentions directed to you. Filter by read/unread status and reply inline.

![Inbox Page](../images/quarry-web/inbox.png)

---

## Smithy Web (Orchestrator Dashboard)

### Activity Feed

The activity page is your command center for agent orchestration. See active agents, their current tasks, recent completions, and the full activity feed.

![Activity Feed](../images/smithy-web/activity-feed.png)

### Tasks — List View

Manage and track agent task assignments. The task list shows status, priority, type, assignee, branch, and last update. Filter by status tabs (All, Backlog, Unassigned, Assigned, In Progress, Awaiting Merge, Closed).

![Tasks List View](../images/smithy-web/tasks-list-view.png)

### Tasks — Kanban View

Toggle to Kanban view for a visual overview of task flow across status columns.

![Tasks Kanban View](../images/smithy-web/tasks-kanban-view.png)

### Create Task

Open the task creation dialog to define new work items. Set title, priority, complexity, type, and tags. Tasks flow through the orchestration pipeline automatically.

![Create Task Dialog](../images/smithy-web/tasks-create-dialog.png)

### Agents — List View

View and manage all registered AI agents. Agents are organized by role: Director (strategic planning), Ephemeral Workers (task execution), and Stewards (automated maintenance). Each agent card shows provider, model, session status, and current branch.

![Agents List](../images/smithy-web/agents-list.png)

### Agents — Graph View

The graph visualization shows the agent hierarchy: Human → Director → Workers/Stewards. See real-time session status and branch assignments at a glance.

![Agent Graph](../images/smithy-web/agents-graph.png)

### Create Agent

Click **+ Create Agent** to register a new AI agent. Choose the role (Director, Worker, or Steward), configure the provider and model, and set capabilities.

![Create Agent Dialog](../images/smithy-web/create-agent-dialog.png)

### Stewards

The Stewards tab shows automated maintenance agents. Configure steward focus areas (merge reviews, documentation) and set up triggers (cron schedules or event-based).

![Stewards Tab](../images/smithy-web/stewards-tab.png)

### Plans

Track plan progress across your orchestrated workspace. Plans organize related tasks and show completion metrics.

![Plans Page](../images/smithy-web/plans.png)

### Merge Requests

Review and manage merge requests from AI agents. Filter by status (Needs Review, Testing, Conflicts) and see branch details.

![Merge Requests](../images/smithy-web/merge-requests.png)

### Workspaces

The terminal multiplexer lets you monitor multiple agent sessions simultaneously. Add panes, choose layouts (single/columns/rows/grid), and save workspace configurations.

![Workspaces](../images/smithy-web/workspaces.png)

### Metrics

The metrics dashboard shows task throughput, status distribution, agent performance, and workload analysis over configurable time ranges.

![Metrics Dashboard](../images/smithy-web/metrics.png)

### Messages

Channel-based messaging for agent and human communication. Agents post status updates, ask clarification questions, and coordinate work through channels.

![Messages Page](../images/smithy-web/messages-channels.png)

### Documents

Browse the shared document library. Agents create and update documentation as part of their workflows.

![Documents Library](../images/smithy-web/documents-library.png)

### Workflows

Define and manage reusable workflow templates that automate multi-step task sequences.

![Workflows Page](../images/smithy-web/workflows.png)

### Settings

Configure workspace preferences and orchestration settings. The Preferences tab controls theme and notifications. The Workspace tab configures agent defaults, steward schedules, and daemon settings.

![Settings Page](../images/smithy-web/settings.png)

---

## Taking Screenshots

The screenshot test specs can be re-run to capture updated screenshots:

```bash
# Quarry Web screenshots
cd apps/quarry-web
npx playwright test tests/screenshots.spec.ts

# Smithy Web screenshots
cd apps/smithy-web
npx playwright test tests/screenshots.spec.ts
```

Screenshots are saved to `docs/images/quarry-web/` and `docs/images/smithy-web/`.
