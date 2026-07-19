import { describe, expect, test } from "bun:test";
import {
  hasMcpGwGitHubProviderTools,
  isFederatedGitHubToolName,
  resolveMcpGwGitHubToolName,
} from "../../src/mcp/mcp-gw-github-tools";

describe("MCP-GW GitHub tool catalog", () => {
  test("accepts official, provider-prefixed, and target-prefixed GitHub tools", () => {
    expect(isFederatedGitHubToolName("search_issues")).toBe(true);
    expect(isFederatedGitHubToolName("github_issue_write")).toBe(true);
    expect(isFederatedGitHubToolName("github_github_issue_write")).toBe(true);
    expect(isFederatedGitHubToolName("google_drive_files_list")).toBe(false);
    expect(isFederatedGitHubToolName("run_sql")).toBe(false);
  });

  test("distinguishes OAuth helpers from connected GitHub provider tools", () => {
    expect(
      hasMcpGwGitHubProviderTools([
        "github_oauth_status",
        "github_oauth_start",
      ]),
    ).toBe(false);
    expect(
      hasMcpGwGitHubProviderTools([
        "github_oauth_status",
        "github_search_repositories",
      ]),
    ).toBe(true);
    expect(
      hasMcpGwGitHubProviderTools([
        "github_oauth_status",
        "search_repositories",
      ]),
    ).toBe(true);
  });

  test("prefers the exact canonical tool name when advertised", () => {
    expect(
      resolveMcpGwGitHubToolName("github_issue_write", [
        "github_github_issue_write",
        "github_issue_write",
      ]),
    ).toBe("github_issue_write");
  });

  test("resolves a canonical tool to its advertised target-prefixed name", () => {
    expect(
      resolveMcpGwGitHubToolName("github_issue_write", [
        "google_drive_files_list",
        "github_github_issue_write",
      ]),
    ).toBe("github_github_issue_write");
  });

  test("resolves a canonical tool to its advertised official name", () => {
    expect(
      resolveMcpGwGitHubToolName("github_issue_write", [
        "google_drive_files_list",
        "issue_write",
      ]),
    ).toBe("issue_write");
  });

  test("rejects missing and ambiguous advertised tools", () => {
    expect(() =>
      resolveMcpGwGitHubToolName("github_issue_write", [
        "google_drive_files_list",
      ]),
    ).toThrow("is not advertised by MCP-GW");

    expect(() =>
      resolveMcpGwGitHubToolName("github_issue_write", [
        "first_github_issue_write",
        "second_github_issue_write",
      ]),
    ).toThrow("has multiple advertised MCP-GW matches");
  });
});
