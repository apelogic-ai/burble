import type { GitHubIssue } from "./providers/github/client";

export function formatIssuesMessage(issues: GitHubIssue[]): string {
  if (issues.length === 0) {
    return "No open issues assigned to you.";
  }

  return issues
    .map((issue) => `- <${issue.html_url}|${issue.title}>`)
    .join("\n");
}

export function formatGitHubIdentityMessage(
  githubLogin: string,
  slackEmail: string
): string {
  return `Authenticated to GitHub as \`${githubLogin}\` for Slack email ${slackEmail}.`;
}

export function formatConnectGitHubMessage(url: string): string {
  return `<${url}|Connect your GitHub account>`;
}

export function formatWorkingMessage(command: string): string {
  return `Working on \`${command}\`...`;
}

export function formatMentionWorkingMessage(): string {
  return "Starting agent runtime...";
}
