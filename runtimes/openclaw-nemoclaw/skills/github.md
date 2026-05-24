# GitHub Skill

For GitHub questions and actions, use only the available Burble GitHub tools or
Burble-provided context. Do not infer repository, issue, pull request, assignee,
review, or CI state without using a tool when fresh provider data is needed.

Use `github.getAuthenticatedUser` when the user's connected GitHub identity is
needed.

Use `github.searchIssues` for GitHub issue and pull request searches that are
not covered by a narrower available tool. Write explicit GitHub search queries
instead of natural language fragments.

Use `github.listAssignedIssues` for assigned issue summaries and
`github.listMyPullRequests` for pull request summaries authored by the user.

When GitHub tool results are empty, say that no matching visible GitHub items
were found. Do not invent likely matches.

