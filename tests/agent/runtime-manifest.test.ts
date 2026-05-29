import { describe, expect, test } from "bun:test";
import { buildRuntimeManifest } from "../../src/agent/runtime-manifest";
import type { ProviderToolSpec } from "../../src/providers/tool-specs";

const toolCatalog: ProviderToolSpec[] = [
  {
    provider: "github",
    name: "github_list_my_pull_requests",
    alias: "github.listMyPullRequests",
    implementation: "listMyPullRequests",
    title: "GitHub PRs",
    description: "List pull requests",
    input: {}
  },
  {
    provider: "github",
    name: "github_create_pr",
    alias: "github.createPullRequest",
    implementation: "createPullRequest",
    title: "GitHub create PR",
    description: "Create pull request",
    input: {}
  },
  {
    provider: "jira",
    name: "jira_search_issues",
    alias: "jira.searchIssues",
    implementation: "searchIssues",
    title: "Jira search",
    description: "Search Jira issues",
    input: {}
  }
];

describe("buildRuntimeManifest", () => {
  test("builds deterministic effective runtime policy from workspace and user config", () => {
    const manifest = buildRuntimeManifest({
      principal: {
        workspaceId: "T123",
        slackUserId: "U123"
      },
      runtime: {
        engine: "openclaw-gateway",
        factory: "docker",
        ttlMs: 86_400_000,
        reaperEnabled: true
      },
      defaultModel: "openai:gpt-5.4",
      toolCatalog,
      workspacePolicy: [
        {
          workspaceId: "T123",
          key: "providers.allowed",
          value: ["github"],
          updatedBySlackUserId: "UADMIN",
          updatedAt: "2026-05-28T00:00:00.000Z"
        },
        {
          workspaceId: "T123",
          key: "models.allowed",
          value: [
            { provider: "openai", model: "gpt-5.4-mini" },
            { provider: "openai", model: "gpt-5.4" }
          ],
          updatedBySlackUserId: "UADMIN",
          updatedAt: "2026-05-28T00:00:00.000Z"
        },
        {
          workspaceId: "T123",
          key: "tools.policy",
          value: [
            {
              provider: "github",
              tool: "github_create_pr",
              effect: "allow",
              risk: "moderate_write",
              confirmation: "explicit"
            }
          ],
          updatedBySlackUserId: "UADMIN",
          updatedAt: "2026-05-28T00:00:00.000Z"
        },
        {
          workspaceId: "T123",
          key: "skills.allowed",
          value: [{ id: "github-pr-triage", versions: ["1"] }],
          updatedBySlackUserId: "UADMIN",
          updatedAt: "2026-05-28T00:00:00.000Z"
        },
        {
          workspaceId: "T123",
          key: "memory.jobs",
          value: { enabled: true },
          updatedBySlackUserId: "UADMIN",
          updatedAt: "2026-05-28T00:00:00.000Z"
        }
      ],
      userPreferences: [
        {
          workspaceId: "T123",
          slackUserId: "U123",
          key: "runtime.model",
          value: { provider: "openai", model: "gpt-5.4-mini" },
          updatedAt: "2026-05-28T00:01:00.000Z"
        },
        {
          workspaceId: "T123",
          slackUserId: "U123",
          key: "tools.disabled",
          value: ["github_create_pr"],
          updatedAt: "2026-05-28T00:01:00.000Z"
        },
        {
          workspaceId: "T123",
          slackUserId: "U123",
          key: "skills.enabled",
          value: [{ id: "github-pr-triage", version: "1" }],
          updatedAt: "2026-05-28T00:01:00.000Z"
        }
      ]
    });

    expect(manifest.model).toEqual({
      provider: "openai",
      model: "gpt-5.4-mini"
    });
    expect(manifest.tools).toEqual([
      {
        name: "github_create_pr",
        provider: "github",
        enabled: false,
        risk: "moderate_write",
        routeRequired: true,
        confirmation: "explicit"
      },
      {
        name: "github_list_my_pull_requests",
        provider: "github",
        enabled: true,
        risk: "read",
        routeRequired: true,
        confirmation: "none"
      },
      {
        name: "jira_search_issues",
        provider: "jira",
        enabled: false,
        risk: "read",
        routeRequired: true,
        confirmation: "none"
      }
    ]);
    expect(manifest.skills).toEqual([
      { id: "github-pr-triage", version: "1", enabled: true }
    ]);
    expect(manifest.memory.jobMemoryEnabled).toBe(true);
    expect(manifest.policyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("falls back to an allowed model when user preference is outside policy", () => {
    const manifest = buildRuntimeManifest({
      principal: {
        workspaceId: "T123",
        slackUserId: "U123"
      },
      runtime: {
        engine: "openclaw",
        factory: "static",
        ttlMs: 60_000,
        reaperEnabled: true
      },
      defaultModel: "openai:gpt-5.4",
      toolCatalog: [],
      workspacePolicy: [
        {
          workspaceId: "T123",
          key: "models.allowed",
          value: [{ provider: "openai", model: "gpt-5.4" }],
          updatedBySlackUserId: "UADMIN",
          updatedAt: "2026-05-28T00:00:00.000Z"
        }
      ],
      userPreferences: [
        {
          workspaceId: "T123",
          slackUserId: "U123",
          key: "runtime.model",
          value: { provider: "openai", model: "gpt-5.4-mini" },
          updatedAt: "2026-05-28T00:01:00.000Z"
        }
      ]
    });

    expect(manifest.model).toEqual({
      provider: "openai",
      model: "gpt-5.4"
    });
    expect(manifest.skills).toEqual([
      { id: "atlassian-jira", version: "1", enabled: true },
      { id: "core", version: "1", enabled: true },
      { id: "github", version: "1", enabled: true }
    ]);
    expect(manifest.memory).toEqual({
      userMemoryEnabled: false,
      workspaceMemoryEnabled: false,
      jobMemoryEnabled: true
    });
  });
});
