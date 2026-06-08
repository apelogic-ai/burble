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
    risk: "moderate_write",
    confirmation: "none",
    input: {}
  },
  {
    provider: "jira",
    name: "jira_search_issues",
    alias: "jira.searchIssues",
    implementation: "searchIssues",
    title: "Jira search",
    description: "Search Jira issues",
    input: {
      query: {
        type: "string",
        min: 1,
        description: "Jira issue search query"
      },
      maxResults: {
        type: "number",
        int: true,
        optional: true,
        description: "Maximum number of results"
      }
    }
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
      defaultStreaming: true,
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
        alias: "github.createPullRequest",
        provider: "github",
        title: "GitHub create PR",
        description: "Create pull request",
        enabled: false,
        risk: "moderate_write",
        routeRequired: true,
        confirmation: "explicit",
        input: []
      },
      {
        name: "github_list_my_pull_requests",
        alias: "github.listMyPullRequests",
        provider: "github",
        title: "GitHub PRs",
        description: "List pull requests",
        enabled: true,
        risk: "read",
        routeRequired: true,
        confirmation: "none",
        input: []
      },
      {
        name: "jira_search_issues",
        alias: "jira.searchIssues",
        provider: "jira",
        title: "Jira search",
        description: "Search Jira issues",
        enabled: false,
        risk: "read",
        routeRequired: true,
        confirmation: "none",
        input: [
          {
            name: "maxResults",
            type: "number",
            required: false,
            description: "Maximum number of results"
          },
          {
            name: "query",
            type: "string",
            required: true,
            description: "Jira issue search query"
          }
        ]
      }
    ]);
    expect(manifest.skills).toEqual([
      { id: "github-pr-triage", version: "1", enabled: true }
    ]);
    expect(manifest.memoryContext).toEqual([]);
    expect(manifest.memory.jobMemoryEnabled).toBe(true);
    expect(manifest.streaming.messageDeltasEnabled).toBe(true);
    expect(manifest.policyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("includes user runtime streaming preference in the policy hash", () => {
    const baseInput = {
      principal: {
        workspaceId: "T123",
        slackUserId: "U123"
      },
      runtime: {
        engine: "openclaw" as const,
        factory: "static" as const,
        ttlMs: 60_000,
        reaperEnabled: true
      },
      defaultStreaming: true,
      defaultModel: "openai:gpt-5.4",
      toolCatalog,
      workspacePolicy: [],
      userPreferences: []
    };
    const defaultManifest = buildRuntimeManifest(baseInput);
    const disabledManifest = buildRuntimeManifest({
      ...baseInput,
      userPreferences: [
        {
          workspaceId: "T123",
          slackUserId: "U123",
          key: "runtime.streaming",
          value: { enabled: false },
          updatedAt: "2026-05-28T00:01:00.000Z"
        }
      ]
    });
    const basicManifest = buildRuntimeManifest({
      ...baseInput,
      userPreferences: [
        {
          workspaceId: "T123",
          slackUserId: "U123",
          key: "runtime.streaming",
          value: "basic",
          updatedAt: "2026-05-28T00:02:00.000Z"
        }
      ]
    });

    expect(defaultManifest.streaming.messageDeltasEnabled).toBe(true);
    expect(disabledManifest.streaming.messageDeltasEnabled).toBe(false);
    expect(basicManifest.streaming.messageDeltasEnabled).toBe(true);
    expect(disabledManifest.policyHash).not.toBe(defaultManifest.policyHash);
    expect(basicManifest.policyHash).toBe(defaultManifest.policyHash);
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
      defaultStreaming: true,
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

  test("uses provider tool risk metadata when workspace policy does not override it", () => {
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
      defaultStreaming: true,
      defaultModel: "openai:gpt-5.4",
      toolCatalog,
      workspacePolicy: [],
      userPreferences: []
    });

    expect(
      manifest.tools.find((tool) => tool.name === "github_create_pr")
    ).toMatchObject({
      risk: "moderate_write",
      confirmation: "none"
    });
  });

  test("injects enabled scoped memory as redacted prompt context", () => {
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
      defaultStreaming: true,
      defaultModel: "openai:gpt-5.4",
      toolCatalog: [],
      workspacePolicy: [
        {
          workspaceId: "T123",
          key: "memory.workspace",
          value: { enabled: true },
          updatedBySlackUserId: "UADMIN",
          updatedAt: "2026-05-28T00:00:00.000Z"
        }
      ],
      userPreferences: [
        {
          workspaceId: "T123",
          slackUserId: "U123",
          key: "memory.user",
          value: { enabled: true },
          updatedAt: "2026-05-28T00:01:00.000Z"
        }
      ],
      memoryRecords: [
        {
          workspaceId: "T123",
          scope: "workspace",
          ownerId: "",
          key: "github.defaultOrg",
          value: "apelogic-ai",
          updatedAt: "2026-05-28T00:02:00.000Z"
        },
        {
          workspaceId: "T123",
          scope: "user",
          ownerId: "U123",
          key: "github.apiToken",
          value: "ghp_secret",
          updatedAt: "2026-05-28T00:03:00.000Z"
        }
      ]
    });

    expect(manifest.memoryContext).toEqual([
      {
        scope: "user",
        ownerId: "U123",
        key: "github.apiToken",
        valuePreview: "[redacted]",
        updatedAt: "2026-05-28T00:03:00.000Z"
      },
      {
        scope: "workspace",
        ownerId: "",
        key: "github.defaultOrg",
        valuePreview: "\"apelogic-ai\"",
        updatedAt: "2026-05-28T00:02:00.000Z"
      }
    ]);
  });
});
