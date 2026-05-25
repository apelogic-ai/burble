# Atlassian Jira Skill

For normal Jira issue creation and editing, use the REST-backed Burble tools
`jira.createIssue` and `jira.editIssue`. Use `jira.searchUsers` to resolve Jira
account IDs. Do not call upstream MCP `createJiraIssue` or `editJiraIssue` for
ordinary Jira ticket create/edit requests when the REST-backed Burble tools can
express the request.

For Atlassian/Jira actions that do not have a first-class Burble tool, call
`atlassian.callMcpTool` with the upstream tool name in `arguments.name` and the
upstream tool arguments in `arguments.arguments`.

Use upstream MCP tool schemas from Available Burble tools. Do not invent
argument names when a schema is available.

Do not call an upstream MCP tool until every field listed in that tool schema's
`required` array is present in `arguments.arguments`. If a required create field
cannot be resolved from tools or the user request, ask one concise clarifying
question instead of trying the create call.

The runtime also validates required upstream MCP schema fields before provider
calls. If a Burble tool result has `error=mcp_schema_validation_failed`, fix the
missing arguments with lookup tools or ask the user for the missing required
field; do not repeat the same invalid call.

If an Atlassian MCP result has `isError=true`, treat its text content as the
provider error. Retry once with corrected schema arguments when the error
identifies a fix; otherwise report the concise provider error instead of calling
it a temporary error.

For Jira issue creation/editing, first resolve site, project, issue type, and
user identifiers with available lookup tools when required by the schema.

For the Atlassian Rovo MCP server, Jira `cloudId` must be the site URL, such as
`https://example.atlassian.net`. Prefer `jira.listAccessibleResources` to get
the connected user's visible site URL. Do not call
`getAccessibleAtlassianResources` for this server's `cloudId`.

For project and issue type discovery before creating Jira issues, prefer
`jira.listVisibleProjects` over upstream MCP project helpers. Use
`query=<project name or key>`, `action=create`, and `expandIssueTypes=true`;
then use the confirmed project key and issue type name/id in `jira.createIssue`.

For core Jira CRUD, REST-backed Burble tools are the stable provider
capabilities. If an upstream MCP create/edit tool was already attempted and
returned an opaque provider error such as `We are having trouble completing this
action`, use the matching REST-backed Burble tool instead of repeating the same
MCP call.

When a user provides an assignee email, use that email for Jira account lookup
before trying the display name. Prefer `jira.searchUsers` for REST-backed Jira
account resolution.

For Jira issue creation, do not let optional assignee lookup failure block
creating the issue. If project, issue type, and summary can be resolved but the
assignee cannot, create the issue unassigned and clearly say assignment was
skipped because the account could not be resolved.

For Jira edit or assign-only requests, unresolved target accounts may block the
requested edit; ask one concise clarifying question instead of guessing.

If required Jira fields such as project, issue type, or issue key cannot be
resolved from tools or the request, ask one concise clarifying question instead
of guessing.

Do not treat a natural-language workspace or project name as a Jira project key
unless a lookup/search/list tool confirms it. Do not choose a default issue type
unless a lookup/search/list tool or the user request confirms it.
