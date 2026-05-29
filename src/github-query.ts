import type { ListMyPullRequestsOptions } from "./providers/github/client";

const githubSlugPattern = "[A-Za-z0-9_.-]+";
const githubRepoPattern = `${githubSlugPattern}\\/${githubSlugPattern}`;

export function parseGitHubPullRequestListInput(
  text: string
): ListMyPullRequestsOptions {
  const limit = parseRequestedItemLimit(text) ?? parseImplicitLatestLimit(text) ?? 10;
  return {
    limit,
    state: parsePullRequestState(text),
    sort: parsePullRequestSort(text),
    order: "desc",
    ...parseGitHubScope(text)
  };
}

function parseRequestedItemLimit(text: string): number | null {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const match =
    /\b(?:top|latest|last|recent|most recent)\s+(\d{1,2})\b/.exec(normalized) ??
    /\b(\d{1,2})\s+(?:latest|last|recent|most recent|open)?\s*(?:github\s+)?(?:pull requests?|prs?)\b/.exec(
      normalized
    );
  if (!match?.[1]) {
    return null;
  }
  const value = Number.parseInt(match[1], 10);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 20) : null;
}

function parseImplicitLatestLimit(text: string): number | null {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (
    /\b(latest|last|newest|most recent)\b/.test(normalized) &&
    /\b(pull request|pr)\b/.test(normalized) &&
    !/\b(pull requests|prs)\b/.test(normalized)
  ) {
    return 1;
  }
  return null;
}

function parsePullRequestState(
  text: string
): ListMyPullRequestsOptions["state"] {
  const normalized = text.toLowerCase();
  if (/\b(closed|merged)\b/.test(normalized)) {
    return "closed";
  }
  if (/\b(all|any)\b/.test(normalized)) {
    return "all";
  }
  return "open";
}

function parsePullRequestSort(text: string): ListMyPullRequestsOptions["sort"] {
  const normalized = text.toLowerCase();
  if (/\b(created|opened|newest)\b/.test(normalized)) {
    return "created";
  }
  if (/\b(comments|commented)\b/.test(normalized)) {
    return "comments";
  }
  return "updated";
}

function parseGitHubScope(
  text: string
): Pick<ListMyPullRequestsOptions, "owner" | "repo"> {
  const explicitRepo =
    new RegExp(`\\brepo:(${githubRepoPattern})\\b`, "i").exec(text)?.[1] ??
    new RegExp(`\\b(${githubRepoPattern})\\b`, "i").exec(text)?.[1];
  if (explicitRepo) {
    return { repo: normalizeGitHubIdentifier(explicitRepo) };
  }

  const owner =
    new RegExp(
      `\\b(?:org|organization|owner):(${githubSlugPattern})\\b`,
      "i"
    ).exec(text)?.[1] ??
    new RegExp(
      `\\b(?:in|from|under|within)\\s+(${githubSlugPattern})\\s+(?:org|organization|owner)\\b`,
      "i"
    ).exec(text)?.[1] ??
    new RegExp(
      `\\b(${githubSlugPattern})\\s+(?:org|organization)\\b`,
      "i"
    ).exec(text)?.[1];

  return owner ? { owner: normalizeGitHubIdentifier(owner) } : {};
}

function normalizeGitHubIdentifier(value: string): string {
  return value.trim().replace(/[.,;:!?]+$/g, "");
}
