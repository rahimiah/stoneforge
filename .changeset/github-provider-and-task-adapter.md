---
"@stoneforge/quarry": minor
---

Implement GitHub ExternalProvider and TaskSyncAdapter for external sync. Adds full GitHub provider with connection testing via GET /user, GitHubTaskAdapter wrapping the API client for issue CRUD, and GitHub-specific field mapping config for priority labels, task type labels, and status/state mapping.
