# Atlassian Jira Skill

For Atlassian/Jira actions, call `atlassian.callMcpTool` with the upstream tool
name in `arguments.name` and the upstream tool arguments in
`arguments.arguments`.

Use upstream MCP tool schemas from Available Burble tools. Do not invent
argument names when a schema is available.

If an Atlassian MCP result has `isError=true`, treat its text content as the
provider error. Retry once with corrected schema arguments when the error
identifies a fix; otherwise report the concise provider error instead of calling
it a temporary error.

For Jira issue creation/editing, first resolve site, project, issue type, and
user identifiers with available Atlassian MCP lookup tools when required by the
schema.

When a user provides an assignee email, use that email for Jira account lookup
before trying the display name.

For Jira issue creation, do not let optional assignee lookup failure block
creating the issue. If project, issue type, and summary can be resolved but the
assignee cannot, create the issue unassigned and clearly say assignment was
skipped because the account could not be resolved.

For Jira edit or assign-only requests, unresolved target accounts may block the
requested edit; ask one concise clarifying question instead of guessing.

If required Jira fields such as project, issue type, or issue key cannot be
resolved from tools or the request, ask one concise clarifying question instead
of guessing.

