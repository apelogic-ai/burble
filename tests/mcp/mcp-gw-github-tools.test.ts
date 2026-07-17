import { describe, expect, test } from "bun:test";
import {
  isFederatedGitHubToolName,
  resolveMcpGwGitHubToolName,
} from "../../src/mcp/mcp-gw-github-tools";

describe("MCP-GW GitHub tool catalog", () => {
  test("accepts single and target-prefixed GitHub tools", () => {
    expect(isFederatedGitHubToolName("github_issue_write")).toBe(true);
    expect(isFederatedGitHubToolName("github_github_issue_write")).toBe(true);
    expect(isFederatedGitHubToolName("google_drive_files_list")).toBe(false);
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
