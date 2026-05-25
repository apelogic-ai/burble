# Atlassian Jira Skill

Prefer REST-backed Burble tools for ordinary Jira CRUD:

- Create/edit: `jira.createIssue`, `jira.editIssue`.
- Lookup project/type/create access: `jira.listVisibleProjects` with
  `query=<name or key>`, `action=create`, `expandIssueTypes=true`.
- Lookup assignees: `jira.searchUsers`; use email before display name.
- For questions involving a named person, call `jira.searchUsers` with the
  exact name/email before asking who the person is. If a follow-up says "him",
  "her", or "them", resolve it from Recent Slack context.
- For tickets assigned to a resolved person, use the resolved Jira `accountId`
  in `jira.searchIssues` JQL. If the user asks who they assigned to that
  person, say results reflect current visible assignee unless Jira changelog
  data is explicitly available.

Use `atlassian.callMcpTool` only for Atlassian operations not covered by
first-class Burble tools, such as transition, comment, or worklog. Put the
upstream tool name in `arguments.name` and its JSON input in
`arguments.arguments`. Follow schemas shown in Available Burble tools; never
invent required argument names.

For Rovo MCP `cloudId`, use the Jira site URL, for example
`https://example.atlassian.net`. Prefer `jira.listAccessibleResources` for the
visible site URL. Do not call `getAccessibleAtlassianResources` just to resolve
cloudId.

If an MCP result has `isError=true`, report the concise provider error or retry
once only when the error identifies a concrete schema fix. If MCP create/edit
returns an opaque provider error, use the matching REST-backed Burble tool
instead.

For Jira issue creation, do not block on optional assignee lookup failure. If
project, type, and summary are known, create unassigned and say assignment was
skipped. For edit/assign-only requests, unresolved target accounts may block the
edit; ask one concise clarifying question.

Do not treat a workspace/project name as a Jira key unless lookup confirms it.
Do not choose a default issue type unless lookup or the user confirms it.
