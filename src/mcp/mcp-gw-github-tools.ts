const burbleDiscoveryToolNames = new Set([
  "github_list_mcp_tools",
  "github_call_mcp_tool",
]);
const mcpGwGitHubOAuthToolNames = new Set([
  "github_oauth_status",
  "github_oauth_start",
]);

// Exact names advertised by the pinned official GitHub MCP v1.6.0 backend.
// MCP-GW may expose these unchanged or through a provider/target prefix.
const officialGitHubToolNames = new Set([
  "actions_get",
  "actions_list",
  "actions_run_trigger",
  "add_comment_to_pending_review",
  "add_issue_comment",
  "add_reply_to_pull_request_comment",
  "assign_copilot_to_issue",
  "create_branch",
  "create_or_update_file",
  "create_pull_request",
  "create_repository",
  "delete_file",
  "discussion_comment_write",
  "dismiss_notification",
  "fork_repository",
  "get_code_scanning_alert",
  "get_commit",
  "get_discussion",
  "get_discussion_comments",
  "get_file_contents",
  "get_job_logs",
  "get_label",
  "get_latest_release",
  "get_me",
  "get_notification_details",
  "get_release_by_tag",
  "get_tag",
  "get_team_members",
  "get_teams",
  "issue_read",
  "issue_write",
  "list_branches",
  "list_code_scanning_alerts",
  "list_commits",
  "list_discussion_categories",
  "list_discussions",
  "list_issue_fields",
  "list_issue_types",
  "list_issues",
  "list_notifications",
  "list_pull_requests",
  "list_releases",
  "list_repository_collaborators",
  "list_tags",
  "manage_notification_subscription",
  "manage_repository_notification_subscription",
  "mark_all_notifications_read",
  "merge_pull_request",
  "projects_get",
  "projects_list",
  "projects_write",
  "pull_request_read",
  "pull_request_review_write",
  "push_files",
  "request_copilot_review",
  "search_code",
  "search_commits",
  "search_issues",
  "search_orgs",
  "search_pull_requests",
  "search_repositories",
  "search_users",
  "sub_issue_write",
  "update_pull_request",
  "update_pull_request_branch",
]);

export function isFederatedGitHubToolName(name: string): boolean {
  return (
    /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(name) &&
    !burbleDiscoveryToolNames.has(name) &&
    (officialGitHubToolNames.has(name) ||
      /(?:^|_)github_[a-z0-9_]+$/.test(name))
  );
}

export function resolveMcpGwGitHubToolName(
  canonicalName: string,
  advertisedNames: readonly string[],
): string {
  if (advertisedNames.includes(canonicalName)) {
    return canonicalName;
  }

  const officialName = canonicalName.replace(/^github_/, "");
  if (
    officialGitHubToolNames.has(officialName) &&
    advertisedNames.includes(officialName)
  ) {
    return officialName;
  }

  const matches = advertisedNames.filter(
    (name) =>
      isFederatedGitHubToolName(name) &&
      name.endsWith(`_${canonicalName}`),
  );
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(
      `GitHub tool ${canonicalName} has multiple advertised MCP-GW matches: ${matches.join(", ")}.`,
    );
  }
  throw new Error(`GitHub tool ${canonicalName} is not advertised by MCP-GW.`);
}

export function hasMcpGwGitHubProviderTools(
  advertisedNames: readonly string[],
): boolean {
  return advertisedNames.some(
    (name) =>
      isFederatedGitHubToolName(name) &&
      !mcpGwGitHubOAuthToolNames.has(name),
  );
}
