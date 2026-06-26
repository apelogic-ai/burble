import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import type {
  AgentJobCapabilityRecord,
  AgentJobRunRecord,
  AgentRuntimeRecord,
  ConversationRouteRecord,
  ProviderConnection,
  TokenStore
} from "../src/db";
import { JiraApiError } from "../src/providers/jira/client";
import { handleToolGatewayRequest } from "../src/tool-gateway";
import type { ObservabilityEventInput } from "../src/observability";
import { createConversationAttachmentCapability } from "../src/conversation/attachment-capabilities";
import analyticsRunReportCassette from "./fixtures/provider-cassettes/google/analytics-run-report.json";
import {
  withProviderCassette,
  type ProviderCassette
} from "./helpers/provider-cassettes";

const config: Config = {
  slackBotToken: "xoxb-test",
  slackAppToken: "xapp-test",
  slackClientId: null,
  slackClientSecret: null,
  slackRedirectUri: "https://example.ngrok-free.app/oauth/slack/callback",
  githubClientId: "client-id",
  githubClientSecret: "client-secret",
  jiraClientId: null,
  jiraClientSecret: null,
  googleClientId: null,
  googleClientSecret: null,
  hubspotClientId: null,
  hubspotClientSecret: null,
  baseUrl: "https://example.ngrok-free.app",
  port: 3000,
  databasePath: ":memory:",
  slackLogLevel: "info",
  agentMode: "deterministic",
  agentFastTrack: false,
  agentRuntime: "ai-sdk",
  agentRuntimeFactory: "static",
  managedRuntimeUrl: null,
  openClawNemoClawUrl: null,
  agentRuntimeEngine: "openclaw",
  openClawNemoClawEngine: "openclaw",
  agentRuntimeDataRoot: "/data/runtimes",
  agentRuntimeDockerNetwork: "compose_default",
  agentRuntimeImage: "burble-openclaw-nemoclaw:dev",
  agentRuntimeIdleTtlMs: 86400000,
  agentRuntimeReaperEnabled: true,
  agentRuntimeReaperIntervalMs: 60000,
  agentRuntimeJwtTtlSeconds: 604800,
  agentRuntimeTokenSecret: null,
  agentRuntimeToolGatewayUrl: "http://burble-app:3000/internal/tools",
  agentRuntimeMcpGatewayUrl: null,
  agentRuntimeMcpAudience: null,
  agentRuntimeSandboxUrl: null,
  agentRuntimeSandboxToken: null,
  agentRuntimeSandboxStartCommand: null,
  atlassianMcpUrl: "https://mcp.atlassian.com/v1/mcp",
  runtimeJwtIssuer: "https://example.ngrok-free.app",
  runtimeJwtPrivateKeyPath: null,
  openClawConfigPatchHostPath: null,
  internalApiToken: "internal-secret",
  observabilityJsonlPath: null,
  observabilityJsonlDir: null,
  observabilityIncludeContent: false,
  aiModel: "openai:gpt-5.4"
};

const connection: ProviderConnection = {
  provider: "github",
  email: "person@example.com",
  slackUserId: "U123",
  providerLogin: "octocat",
  accessToken: "secret-token",
  connectedAt: "2026-05-19T00:00:00Z"
};

const jiraConnection: ProviderConnection = {
  provider: "jira",
  email: "person@example.com",
  slackUserId: "U123",
  providerLogin: "person@atlassian.example",
  accessToken: "jira-token",
  connectedAt: "2026-05-22T00:00:00Z"
};

const slackConnection: ProviderConnection = {
  provider: "slack",
  email: "person@example.com",
  slackUserId: "U123",
  providerLogin: "U123",
  accessToken: "xoxp-user-token",
  connectedAt: "2026-05-25T00:00:00Z"
};

const googleConnection: ProviderConnection = {
  provider: "google",
  email: "person@example.com",
  slackUserId: "U123",
  providerLogin: "person@example.com",
  accessToken: "google-token",
  connectedAt: "2026-05-25T00:00:00Z"
};

const hubspotConnection: ProviderConnection = {
  provider: "hubspot",
  email: "person@example.com",
  slackUserId: "U123",
  providerLogin: "hubspot-user@example.com",
  accessToken: "hubspot-token",
  connectedAt: "2026-05-25T00:00:00Z"
};

const runtime: AgentRuntimeRecord = {
  id: "rt_u123",
  workspaceId: "T123",
  slackUserId: "U123",
  engine: "openclaw",
  status: "ready",
  endpointUrl: "http://runtime-u123:8080",
  authTokenHash:
    "d61d816e93bafb888da9bccc1fe342e978ee8619f396b6a1dbb9eaa09584eaba",
  statePath: "/data/runtimes/u123/state",
  configPath: "/data/runtimes/u123/config/openclaw.json",
  workspacePath: "/data/runtimes/u123/workspace",
  sandboxId: null,
  policyHash: "policy-hash",
  createdAt: "2026-05-21T00:00:00.000Z",
  lastSeenAt: "2026-05-21T00:00:00.000Z",
  lastUsedAt: "2026-05-21T00:00:00.000Z",
  stoppedAt: null,
  failureReason: null
};

const hermesRuntime: AgentRuntimeRecord = {
  ...runtime,
  id: "rt_hermes",
  engine: "hermes",
  endpointUrl: "http://runtime-hermes:8080",
  configPath: "/data/runtimes/u123/config/hermes.yaml"
};

function createStore(
  foundConnection: ProviderConnection | null,
  foundRuntime: AgentRuntimeRecord | null = null,
  runtimeEvents: unknown[] = [],
  foundRoute: ConversationRouteRecord | null = null,
  touchedRuntimeIds: string[] = [],
  jobCapabilities: {
    found?: AgentJobCapabilityRecord | null;
    list?: AgentJobCapabilityRecord[];
    upserts?: unknown[];
  } = {},
  routeRevocations: unknown[] = [],
  routeUpserts: unknown[] | null = null,
  jobRuns: {
    created?: AgentJobRunRecord[];
    latest?: AgentJobRunRecord | null;
  } = {},
  scheduledJobs: {
    list?: ReturnType<TokenStore["listScheduledJobsForPrincipal"]>;
    upserts?: unknown[];
  } = {}
): TokenStore {
  let route = foundRoute;
  return {
    createOAuthState: () => "state",
    consumeOAuthState: () => null,
    upsertConnectedUser: () => undefined,
    upsertProviderConnection: () => undefined,
    getConnectedUserByEmail: () => null,
    getConnection: (provider, email) =>
      provider === foundConnection?.provider && email === "person@example.com"
        ? foundConnection
        : null,
    getConnectionForSlackUser: (provider, slackUserId) =>
      provider === foundConnection?.provider &&
      slackUserId === foundConnection.slackUserId
        ? foundConnection
        : null,
    deleteConnectionForSlackUser: () => false,
    getOrCreateAgentRuntime: () => {
      throw new Error("unexpected agent runtime call");
    },
    getAgentRuntime: (id) => (id === foundRuntime?.id ? foundRuntime : null),
    getAgentRuntimeForPrincipal: () => foundRuntime,
    listAgentRuntimesForPrincipal: () =>
      foundRuntime ? [foundRuntime] : [],
    listIdleAgentRuntimes: () => [],
    recordAgentRuntimeEvent: (event) => {
      runtimeEvents.push(event);
    },
    listAgentRuntimeEvents: () => runtimeEvents as never,
    upsertConversationRoute: (input) => {
      if (!routeUpserts) {
        throw new Error("unexpected conversation route write");
      }
      routeUpserts.push(input);
      route = {
        id: "convrt_aaaaaaaaaaaaaaaaaaaaaaaa",
        workspaceId: input.workspaceId,
        slackUserId: input.slackUserId,
        transport: input.transport,
        destinationJson: JSON.stringify(input.destination),
        kind: input.kind ?? "origin",
        grantedBySlackUserId: input.grantedBySlackUserId ?? null,
        expiresAt: input.expiresAt ?? null,
        bindingJson: input.binding ? JSON.stringify(input.binding) : null,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
        revokedAt: null
      };
      return route;
    },
    getConversationRoute: (id) => (id === route?.id ? route : null),
    getConversationGrantRouteForSlackChannel: (input) => {
      if (!route) {
        return null;
      }
      const destination = JSON.parse(route.destinationJson) as {
        channelId?: unknown;
      };
      return route.workspaceId === input.workspaceId &&
        route.slackUserId === input.slackUserId &&
        route.kind === "grant" &&
        destination.channelId === input.channelId
        ? route
        : null;
    },
    recordConversationRouteDeliveryFailure: (input) => {
      if (!route || input.routeId !== route.id) {
        return null;
      }
      route = {
        ...route,
        lastDeliveryFailureAt: new Date().toISOString(),
        lastDeliveryFailureCode: input.code ?? null,
        lastDeliveryFailureNotifiedAt: input.notificationSent
          ? new Date().toISOString()
          : route.lastDeliveryFailureNotifiedAt ?? null,
        consecutiveDeliveryFailures:
          (route.consecutiveDeliveryFailures ?? 0) + 1
      };
      return route;
    },
    resetConversationRouteDeliveryFailure: (input) => {
      if (!route || input.routeId !== route.id) {
        return null;
      }
      route = {
        ...route,
        lastDeliveryFailureAt: null,
        lastDeliveryFailureCode: null,
        lastDeliveryFailureNotifiedAt: null,
        consecutiveDeliveryFailures: 0
      };
      return route;
    },
    revokeConversationRoute: (input) => {
      if (!route || input.routeId !== route.id || route.revokedAt) {
        return null;
      }
      route = {
        ...route,
        revokedAt: new Date().toISOString()
      };
      routeRevocations.push(input);
      return route;
    },
    revokeConversationRoutesForDestination: (input) => {
      routeRevocations.push(input);
      return 1;
    },
    upsertWorkspacePolicy: () => {
      throw new Error("unexpected workspace policy write");
    },
    getWorkspacePolicy: () => null,
    listWorkspacePolicy: () => [],
    upsertUserPreference: () => {
      throw new Error("unexpected user preference write");
    },
    getUserPreference: () => null,
    listUserPreferences: () => [],
    upsertAgentMemory: () => {
      throw new Error("unexpected agent memory write");
    },
    listAgentMemory: () => [],
    deleteAgentMemory: () => undefined,
    upsertAgentJobState: () => {
      throw new Error("unexpected agent job state write");
    },
    getAgentJobState: () => null,
    listAgentJobStatesForPrincipal: () => [],
    deleteAgentJobState: () => undefined,
    upsertScheduledJob: (input) => {
      scheduledJobs.upserts?.push(input);
      const now = (input.now ?? new Date("2026-06-24T12:00:00.000Z")).toISOString();
      const existing = (scheduledJobs.list ?? []).find(
        (job) => job.jobId === input.jobId
      );
      const record = {
        jobId: input.jobId,
        workspaceId: input.workspaceId,
        slackUserId: input.slackUserId,
        title: input.title,
        prompt: input.prompt,
        schedule: input.schedule,
        routeId: input.routeId ?? null,
        state: input.state ?? "scheduled",
        runtimeType: input.runtimeType ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      if (existing && scheduledJobs.list) {
        scheduledJobs.list.splice(scheduledJobs.list.indexOf(existing), 1, record);
      }
      return record;
    },
    getScheduledJob: (jobId) =>
      (scheduledJobs.list ?? []).find((job) => job.jobId === jobId) ?? null,
    listScheduledJobsForPrincipal: (workspaceId, slackUserId) =>
      (scheduledJobs.list ?? []).filter(
        (job) =>
          job.workspaceId === workspaceId && job.slackUserId === slackUserId
      ),
    listScheduledJobs: () => scheduledJobs.list ?? [],
    deleteScheduledJob: (jobId) => {
      const index = (scheduledJobs.list ?? []).findIndex(
        (job) => job.jobId === jobId
      );
      if (index >= 0) {
        scheduledJobs.list?.splice(index, 1);
      }
    },
    createAgentJobRun: (input) => {
      const now = (input.now ?? new Date("2026-06-24T12:00:00.000Z")).toISOString();
      const record: AgentJobRunRecord = {
        runId: input.runId?.trim() || "jobrun_test",
        jobId: input.jobId,
        workspaceId: input.workspaceId,
        slackUserId: input.slackUserId,
        triggerSource: input.triggerSource,
        status: input.status ?? "queued",
        failureReason: input.failureReason ?? null,
        createdAt: now,
        updatedAt: now,
        startedAt: input.startedAt ?? null,
        finishedAt: input.finishedAt ?? null
      };
      jobRuns.created?.push(record);
      return record;
    },
    getAgentJobRun: () => null,
    listAgentJobRunsForJob: () => [],
    listAgentJobRunsForPrincipal: () => jobRuns.created ?? [],
    getLatestAgentJobRunForPrincipal: () => jobRuns.latest ?? null,
    listQueuedAgentJobRuns: () => [],
    claimAgentJobRun: () => null,
    finishAgentJobRun: () => null,
    upsertAgentJobCapability: (input) => {
      jobCapabilities.upserts?.push(input);
      return {
        jobId: input.jobId,
        workspaceId: input.workspaceId,
        slackUserId: input.slackUserId,
        requiredTools: input.requiredTools,
        routeId: input.routeId ?? null,
        policyHash: input.policyHash ?? null,
        capabilityProfile: input.capabilityProfile ?? "scheduled_job",
        runtimeType: input.runtimeType ?? null,
        stateRefs: input.stateRefs ?? [],
        visibilityPolicy: input.visibilityPolicy ?? {},
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z"
      };
    },
    getAgentJobCapability: (jobId) =>
      jobId === jobCapabilities.found?.jobId ? jobCapabilities.found : null,
    listAgentJobCapabilitiesForPrincipal: (workspaceId, slackUserId) =>
      (jobCapabilities.list ?? [])
        .filter(
          (capability) =>
            capability.workspaceId === workspaceId &&
            capability.slackUserId === slackUserId
        ),
    deleteAgentJobCapability: () => undefined,
    upsertSkillCatalog: () => {
      throw new Error("unexpected skill catalog write");
    },
    getSkillCatalog: () => null,
    listSkillCatalog: () => [],
    upsertWorkspaceSkill: () => {
      throw new Error("unexpected workspace skill write");
    },
    listWorkspaceSkills: () => [],
    upsertUserSkill: () => {
      throw new Error("unexpected user skill write");
    },
    listUserSkills: () => [],
    updateAgentRuntimeStatus: () => undefined,
    touchAgentRuntime: (id) => {
      touchedRuntimeIds.push(id);
    },
    close: () => undefined
  } as TokenStore;
}

function request(
  toolName: string,
  body: unknown,
  token = "internal-secret",
  runtimeId?: string
): Request {
  const headers = new Headers({
    "content-type": "application/json",
    authorization: `Bearer ${token}`
  });
  if (runtimeId) {
    headers.set("x-burble-runtime-id", runtimeId);
  }

  return new Request(`https://example.test/internal/tools/${toolName}/execute`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

describe("handleToolGatewayRequest", () => {
  test("executes an allowlisted GitHub tool with the stored caller token", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(connection),
      "github.listAssignedIssues",
      request("github.listAssignedIssues", {
        user: { email: "person@example.com" }
      }),
      {
        listAssignedIssues: async (token) => {
          expect(token).toBe("secret-token");
          return [
            {
              title: "Fix billing export",
              html_url: "https://github.com/acme/app/issues/1"
            }
          ];
        }
      }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      classification: "user_private",
      content: [
        {
          title: "Fix billing export",
          url: "https://github.com/acme/app/issues/1"
        }
      ]
    });
    expect(JSON.stringify(body)).not.toContain("secret-token");
  });

  test("passes GitHub pull request list options to the provider tool", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(connection),
      "github.listMyPullRequests",
      request("github.listMyPullRequests", {
        user: { email: "person@example.com" },
        input: {
          limit: 3,
          state: "closed",
          sort: "created",
          order: "asc",
          owner: "example-org"
        }
      }),
      {
        listMyPullRequests: async (token, options) => {
          expect(token).toBe("secret-token");
          expect(options).toEqual({
            limit: 3,
            state: "closed",
            sort: "created",
            order: "asc",
            owner: "example-org"
          });
          return [
            {
              title: "Fix release notes",
              html_url: "https://github.com/acme/app/pull/9"
            }
          ];
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: [
        {
          title: "Fix release notes",
          url: "https://github.com/acme/app/pull/9"
        }
      ]
    });
  });

  test("executes brokered public web search without a provider connection", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime),
      "web.search",
      request(
        "web.search",
        {
          input: {
            query: "latest AI news",
            limit: 2
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        searchWeb: async (input) => {
          expect(input).toEqual({
            query: "latest AI news",
            limit: 2
          });
          return {
            classification: "public",
            content: {
              query: input.query,
              results: [
                {
                  title: "AI research update",
                  url: "https://example.com/ai",
                  snippet: "A short public news summary."
                }
              ]
            }
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "public",
      content: {
        query: "latest AI news",
        results: [
          {
            title: "AI research update",
            url: "https://example.com/ai",
            snippet: "A short public news summary."
          }
        ]
      }
    });
  });

  test("passes Google Analytics report inputs to the provider tool", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(googleConnection),
      "google.analyticsRunReport",
      request("google.analyticsRunReport", {
        user: { email: "person@example.com" },
        input: {
          propertyId: "456",
          startDate: "7daysAgo",
          endDate: "today",
          metrics: ["activeUsers"],
          dimensions: ["country"],
          limit: 3
        }
      }),
      {
        runGoogleAnalyticsReport: async (token, input) => {
          expect(token).toBe("google-token");
          expect(input).toEqual({
            propertyId: "456",
            startDate: "7daysAgo",
            endDate: "today",
            metrics: ["activeUsers"],
            dimensions: ["country"],
            limit: 3
          });
          return {
            propertyId: "456",
            dimensionHeaders: ["country"],
            metricHeaders: ["activeUsers"],
            rows: [
              {
                dimensions: { country: "US" },
                metrics: { activeUsers: "42" }
              }
            ]
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        propertyId: "456",
        dimensionHeaders: ["country"],
        metricHeaders: ["activeUsers"],
        rows: [
          {
            dimensions: { country: "US" },
            metrics: { activeUsers: "42" }
          }
        ]
      }
    });
  });

  test("coerces provider-spec aliases and primitive values at the gateway", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(googleConnection),
      "google.analyticsRunReport",
      request("google.analyticsRunReport", {
        user: { email: "person@example.com" },
        input: {
          property_id: "456",
          start_date: "7daysAgo",
          end_date: "today",
          metrics: ["activeUsers"],
          dimensions: ["country"],
          limit: "3"
        }
      }),
      {
        runGoogleAnalyticsReport: async (_token, input) => {
          expect(input).toEqual({
            propertyId: "456",
            startDate: "7daysAgo",
            endDate: "today",
            metrics: ["activeUsers"],
            dimensions: ["country"],
            limit: 3
          });
          return {
            propertyId: "456",
            dimensionHeaders: ["country"],
            metricHeaders: ["activeUsers"],
            rows: []
          };
        }
      }
    );

    expect(response.status).toBe(200);
  });

  test("preserves undeclared provider fields while coercing declared fields", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(hubspotConnection),
      "hubspot.searchContacts",
      request("hubspot.searchContacts", {
        user: { email: "person@example.com" },
        input: {
          query: "Acme",
          limit: "3",
          experimentalField: "keep-me"
        }
      }),
      {
        searchHubSpotContacts: async (_token, input) => {
          expect(input as Record<string, unknown>).toEqual({
            query: "Acme",
            limit: 3,
            experimentalField: "keep-me"
          });
          return [];
        }
      }
    );

    expect(response.status).toBe(200);
  });

  test("replays coerced Google Analytics gateway calls against the provider cassette", async () => {
    await withProviderCassette(
      analyticsRunReportCassette as ProviderCassette,
      async (cassette) => {
        const response = await handleToolGatewayRequest(
          config,
          createStore(googleConnection),
          "google.analyticsRunReport",
          request("google.analyticsRunReport", {
            user: { email: "person@example.com" },
            input: {
              property_id: "456",
              start_date: "7daysAgo",
              end_date: "today",
              metrics: ["activeUsers"],
              dimensions: ["country"],
              limit: "3"
            }
          })
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          classification: "user_private",
          content: {
            propertyId: "456",
            dimensionHeaders: ["country"],
            metricHeaders: ["activeUsers"],
            rows: [
              {
                dimensions: { country: "US" },
                metrics: { activeUsers: "42" }
              }
            ],
            rowCount: 1
          }
        });
        cassette.assertComplete();
        expect(cassette.requests[0]?.bodyJson).toEqual({
          dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
          metrics: [{ name: "activeUsers" }],
          dimensions: [{ name: "country" }],
          limit: "3"
        });
      }
    );
  });

  test("passes Google Slides template probe inputs to the provider tool", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(googleConnection),
      "google.slidesProbeTemplate",
      request("google.slidesProbeTemplate", {
        user: { email: "person@example.com" },
        input: {
          presentationId: "deck-1"
        }
      }),
      {
        probeGoogleSlidesTemplate: async (token, input) => {
          expect(token).toBe("google-token");
          expect(input).toEqual({ presentationId: "deck-1" });
          return {
            presentationId: "deck-1",
            layouts: [
              {
                layoutId: "layout-1",
                slots: [
                  {
                    role: "title",
                    objectId: "slot-title",
                    placeholder: { type: "TITLE", index: 0 }
                  }
                ]
              }
            ]
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        presentationId: "deck-1",
        layouts: [
          {
            layoutId: "layout-1",
            slots: [
              {
                role: "title",
                objectId: "slot-title",
                placeholder: { type: "TITLE", index: 0 }
              }
            ]
          }
        ]
      }
    });
  });

  test("passes Google Slides copy inputs to the provider tool", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(googleConnection),
      "google.slidesCopyPresentation",
      request("google.slidesCopyPresentation", {
        user: { email: "person@example.com" },
        input: {
          presentationId: "deck-template",
          name: "ApeLogic Template Copy"
        }
      }),
      {
        copyGoogleSlidesPresentation: async (token, input) => {
          expect(token).toBe("google-token");
          expect(input).toEqual({
            presentationId: "deck-template",
            name: "ApeLogic Template Copy"
          });
          return {
            id: "deck-copy",
            name: "ApeLogic Template Copy",
            mimeType: "application/vnd.google-apps.presentation",
            webViewLink: "https://docs.google.com/presentation/d/deck-copy"
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        id: "deck-copy",
        name: "ApeLogic Template Copy",
        mimeType: "application/vnd.google-apps.presentation",
        webViewLink: "https://docs.google.com/presentation/d/deck-copy"
      }
    });
  });

  test("normalizes Google Slides slide creation inputs to the provider tool", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(googleConnection),
      "google.slidesCreateSlide",
      request("google.slidesCreateSlide", {
        user: { email: "person@example.com" },
        input: {
          presentation_id: "deck-copy",
          slide_index: "2",
          predefined_layout: "title_and_two_columns",
          placeholders: [
            { placeholder_type: "title", value: "Test slide 3" },
            { role: "body", index: 0, content: "Left text" },
            { role: "body", index: "1", content: "Right text" }
          ]
        }
      }),
      {
        createGoogleSlidesSlide: async (token, input) => {
          expect(token).toBe("google-token");
          expect(input).toMatchObject({
            presentationId: "deck-copy",
            insertionIndex: 2,
            predefinedLayout: "TITLE_AND_TWO_COLUMNS",
            objectId: expect.stringMatching(/^burble_slide_[0-9a-f]{32}$/),
            replacements: [
              { placeholderType: "TITLE", text: "Test slide 3" },
              { placeholderType: "BODY", index: 0, text: "Left text" },
              { placeholderType: "BODY", index: 1, text: "Right text" }
            ]
          });
          return {
            presentationId: "deck-copy",
            slideObjectId: "slide-3",
            layoutObjectId: "layout-two-columns"
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        presentationId: "deck-copy",
        slideObjectId: "slide-3",
        layoutObjectId: "layout-two-columns"
      }
    });
  });

  test("passes Google Slides placeholder fill inputs to the provider tool", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(googleConnection),
      "google.slidesFillPlaceholders",
      request("google.slidesFillPlaceholders", {
        user: { email: "person@example.com" },
        input: {
          presentationId: "deck-copy",
          replacements: [
            { placeholderType: "TITLE", text: "ApeLogic" },
            {
              placeholderType: "SUBTITLE",
              text: "Test presentation from template"
            }
          ]
        }
      }),
      {
        fillGoogleSlidesPlaceholders: async (token, input) => {
          expect(token).toBe("google-token");
          expect(input).toEqual({
            presentationId: "deck-copy",
            replacements: [
              { placeholderType: "TITLE", text: "ApeLogic" },
              {
                placeholderType: "SUBTITLE",
                text: "Test presentation from template"
              }
            ]
          });
          return {
            presentationId: "deck-copy",
            slideObjectId: "slide-1",
            updatedPlaceholders: [
              {
                placeholderType: "TITLE",
                matchedPlaceholderType: "TITLE",
                objectId: "title-shape",
                text: "ApeLogic"
              }
            ],
            skippedPlaceholders: []
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        presentationId: "deck-copy",
        slideObjectId: "slide-1",
        updatedPlaceholders: [
          {
            placeholderType: "TITLE",
            matchedPlaceholderType: "TITLE",
            objectId: "title-shape",
            text: "ApeLogic"
          }
        ],
        skippedPlaceholders: []
      }
    });
  });

  test("normalizes Google Slides placeholder fill aliases from provider bridge calls", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(googleConnection),
      "google.slidesFillPlaceholders",
      request("google.slidesFillPlaceholders", {
        user: { email: "person@example.com" },
        input: {
          presentation_id: "deck-copy",
          slide_object_id: "slide-2",
          placeholders: [
            { placeholder_type: "title", value: "Test slide 2" },
            {
              role: "body",
              content: "This slide was updated by Burble."
            }
          ]
        }
      }),
      {
        fillGoogleSlidesPlaceholders: async (token, input) => {
          expect(token).toBe("google-token");
          expect(input).toEqual({
            presentationId: "deck-copy",
            slideObjectId: "slide-2",
            replacements: [
              { placeholderType: "TITLE", text: "Test slide 2" },
              {
                placeholderType: "BODY",
                text: "This slide was updated by Burble."
              }
            ]
          });
          return {
            presentationId: "deck-copy",
            slideObjectId: "slide-2",
            updatedPlaceholders: [
              {
                placeholderType: "TITLE",
                matchedPlaceholderType: "TITLE",
                objectId: "title-shape",
                text: "Test slide 2"
              },
              {
                placeholderType: "BODY",
                matchedPlaceholderType: "BODY",
                objectId: "body-shape",
                text: "This slide was updated by Burble."
              }
            ],
            skippedPlaceholders: []
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        presentationId: "deck-copy",
        slideObjectId: "slide-2",
        updatedPlaceholders: [
          {
            placeholderType: "TITLE",
            matchedPlaceholderType: "TITLE",
            objectId: "title-shape",
            text: "Test slide 2"
          },
          {
            placeholderType: "BODY",
            matchedPlaceholderType: "BODY",
            objectId: "body-shape",
            text: "This slide was updated by Burble."
          }
        ],
        skippedPlaceholders: []
      }
    });
  });

  test("normalizes top-level Google Slides placeholder fill fields", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(googleConnection),
      "google.slidesFillPlaceholders",
      request("google.slidesFillPlaceholders", {
        user: { email: "person@example.com" },
        input: {
          presentationId: "deck-copy",
          slideObjectId: "slide-2",
          placeholder_type: "title",
          text: "Test slide 2"
        }
      }),
      {
        fillGoogleSlidesPlaceholders: async (_token, input) => {
          expect(input).toEqual({
            presentationId: "deck-copy",
            slideObjectId: "slide-2",
            replacements: [{ placeholderType: "TITLE", text: "Test slide 2" }]
          });
          return {
            presentationId: "deck-copy",
            slideObjectId: "slide-2",
            updatedPlaceholders: [],
            skippedPlaceholders: []
          };
        }
      }
    );

    expect(response.status).toBe(200);
  });

  test("explains invalid Google Slides placeholder fill inputs", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(googleConnection),
      "google.slidesFillPlaceholders",
      request("google.slidesFillPlaceholders", {
        user: { email: "person@example.com" },
        input: {
          presentationId: "deck-copy",
          replacements: [{ placeholderType: "TITLE" }]
        }
      })
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "google.slidesFillPlaceholders requires presentationId and at least one replacement"
    );
  });

  test("rejects invalid GitHub pull request list options", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(connection),
      "github.listMyPullRequests",
      request("github.listMyPullRequests", {
        user: { email: "person@example.com" },
        input: { limit: 1000 }
      })
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid tool input");
  });

  test("executes GitHub write tools with the stored caller token", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(connection),
      "github.createIssue",
      request("github.createIssue", {
        user: { email: "person@example.com" },
        input: {
          repo: "acme/app",
          title: "New issue",
          body: "Body",
          labels: ["bug"],
          assignees: ["octocat"]
        }
      }),
      {
        createIssue: async (token, input) => {
          expect(token).toBe("secret-token");
          expect(input).toEqual({
            repo: "acme/app",
            title: "New issue",
            body: "Body",
            labels: ["bug"],
            assignees: ["octocat"]
          });
          return {
            title: "New issue",
            html_url: "https://github.com/acme/app/issues/12",
            number: 12
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        title: "New issue",
        url: "https://github.com/acme/app/issues/12",
        number: 12
      }
    });
  });

  test("rejects Hermes runtime provider write tools at the gateway", async () => {
    const observabilityEvents: ObservabilityEventInput[] = [];
    const response = await handleToolGatewayRequest(
      config,
      createStore(connection, hermesRuntime),
      "github.createIssue",
      request(
        "github.createIssue",
        {
          user: { email: "person@example.com" },
          input: {
            repo: "acme/app",
            title: "Do not create this"
          }
        },
        "runtime-token-u123",
        "rt_hermes"
      ),
      {
        observability: {
          emit: (event) => {
            observabilityEvents.push(event);
          }
        },
        createIssue: async () => {
          throw new Error("Hermes runtime write should not reach provider client");
        }
      }
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        error: "provider_write_not_allowed",
        message:
          "Hermes provider tools may only execute read-only Burble provider calls through the runtime gateway."
      }
    });
    expect(observabilityEvents.map((event) => event.name)).toEqual([
      "tool.gateway.started",
      "tool.gateway.failed"
    ]);
    expect(observabilityEvents[1]).toMatchObject({
      runtimeId: "rt_hermes",
      runtimeType: "hermes",
      workspaceId: "T123",
      principalId: "T123:U123",
      toolName: "github.createIssue",
      status: "error",
      error: {
        code: "provider_write_not_allowed"
      },
      attributes: {
        authKind: "runtime",
        provider: "github",
        deliveryFailureRetryable: false
      }
    });
  });

  test("executes newer GitHub file tools through the HTTP fallback gateway", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(connection),
      "github.createOrUpdateFile",
      request("github.createOrUpdateFile", {
        user: { email: "person@example.com" },
        input: {
          repo: "acme/app",
          path: "notes.md",
          content: "hello",
          message: "Update notes",
          branch: "main",
          sha: "abc123"
        }
      }),
      {
        createOrUpdateFile: async (token, input) => {
          expect(token).toBe("secret-token");
          expect(input).toEqual({
            repo: "acme/app",
            path: "notes.md",
            content: "hello",
            message: "Update notes",
            branch: "main",
            sha: "abc123"
          });
          return {
            content: {
              name: "notes.md",
              path: "notes.md",
              sha: "def456",
              html_url: "https://github.com/acme/app/blob/main/notes.md"
            },
            commit: {
              sha: "commit456",
              html_url: "https://github.com/acme/app/commit/commit456"
            }
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        content: {
          name: "notes.md",
          path: "notes.md",
          sha: "def456",
          html_url: "https://github.com/acme/app/blob/main/notes.md"
        },
        commit: {
          sha: "commit456",
          html_url: "https://github.com/acme/app/commit/commit456"
        }
      }
    });
  });

  test("requires the configured internal bearer token", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(connection),
      "github.getAuthenticatedUser",
      request("github.getAuthenticatedUser", {
        user: { email: "person@example.com" }
      }, "wrong-token")
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
  });

  test("executes Slack message search with the stored Slack user token", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(slackConnection),
      "slack.searchMessages",
      request("slack.searchMessages", {
        user: { email: "person@example.com" },
        input: { query: "launch", fromUserId: "U123", limit: 3 }
      }),
      {
        searchSlackMessages: async (token, input) => {
          expect(token).toBe("xoxp-user-token");
          expect(input).toEqual({
            query: "launch",
            fromUserId: "U123",
            limit: 3
          });
          return [
            {
              channelId: "C123",
              channelName: "eng",
              userId: "U123",
              text: "launch notes",
              permalink: "https://slack.test/archives/C123/p1"
            }
          ];
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: [
        {
          channelId: "C123",
          channelName: "eng",
          userId: "U123",
          text: "launch notes",
          permalink: "https://slack.test/archives/C123/p1"
        }
      ]
    });
  });

  test("creates an empty Google Drive text file when text is omitted", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(googleConnection),
      "google.createDriveTextFile",
      request("google.createDriveTextFile", {
        user: { email: "person@example.com" },
        input: { name: "Blank" }
      }),
      {
        createGoogleDriveTextFile: async (token, input) => {
          expect(token).toBe("google-token");
          expect(input).toEqual({
            name: "Blank",
            text: ""
          });
          return {
            id: "file-2",
            name: "Blank"
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        id: "file-2",
        name: "Blank"
      }
    });
  });

  test("rejects Google Workspace MIME types for Drive text file creation", async () => {
    let didCallProvider = false;
    const response = await handleToolGatewayRequest(
      config,
      createStore(googleConnection),
      "google.createDriveTextFile",
      request("google.createDriveTextFile", {
        user: { email: "person@example.com" },
        input: {
          name: "Deck",
          text: "",
          mimeType: "application/vnd.google-apps.presentation"
        }
      }),
      {
        createGoogleDriveTextFile: async () => {
          didCallProvider = true;
          return {
            id: "file-2",
            name: "Deck"
          };
        }
      }
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid tool input");
    expect(didCallProvider).toBe(false);
  });

  test("executes HubSpot CRM search tools with the stored caller token", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(hubspotConnection),
      "hubspot.searchContacts",
      request("hubspot.searchContacts", {
        user: { email: "person@example.com" },
        input: { query: "Acme", limit: 5 }
      }),
      {
        searchHubSpotContacts: async (token, input) => {
          expect(token).toBe("hubspot-token");
          expect(input).toEqual({ query: "Acme", limit: 5 });
          return [
            {
              id: "contact-1",
              properties: {
                email: "person@example.com",
                firstname: "Person"
              },
              createdAt: "2026-06-01T00:00:00.000Z"
            }
          ];
        }
      }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      classification: "user_private",
      content: [
        {
          id: "contact-1",
          properties: {
            email: "person@example.com",
            firstname: "Person"
          },
          createdAt: "2026-06-01T00:00:00.000Z"
        }
      ]
    });
    expect(JSON.stringify(body)).not.toContain("hubspot-token");
  });

  test("allows a principal-bound runtime token for its own provider account", async () => {
    const runtimeEvents: unknown[] = [];
    const touchedRuntimeIds: string[] = [];
    const response = await handleToolGatewayRequest(
      config,
      createStore(connection, runtime, runtimeEvents, null, touchedRuntimeIds),
      "github.getAuthenticatedUser",
      request(
        "github.getAuthenticatedUser",
        {
          user: { email: "person@example.com" }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        getGitHubUser: async (token) => {
          expect(token).toBe("secret-token");
          return { login: "octocat" };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(touchedRuntimeIds).toEqual(["rt_u123"]);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: { login: "octocat" }
    });
    expect(runtimeEvents).toEqual([
      {
        runtimeId: "rt_u123",
        eventType: "runtime_tool_called",
        summary: {
          toolName: "github.getAuthenticatedUser",
          classification: "user_private",
          itemCount: null
        }
      }
    ]);
  });

  test("allows a runtime token to use its own provider account without user email", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(connection, runtime),
      "github.getAuthenticatedUser",
      request(
        "github.getAuthenticatedUser",
        {
          input: {}
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        getGitHubUser: async (token) => {
          expect(token).toBe("secret-token");
          return { login: "octocat" };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: { login: "octocat" }
    });
  });

  test("rejects runtime tokens without a runtime id header", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(connection, runtime),
      "github.getAuthenticatedUser",
      request(
        "github.getAuthenticatedUser",
        {
          input: {}
        },
        "runtime-token-u123"
      )
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
  });

  test("executes expanded HubSpot read tools with the stored caller token", async () => {
    const crmResponse = await handleToolGatewayRequest(
      config,
      createStore(hubspotConnection),
      "hubspot.searchCrmObjects",
      request("hubspot.searchCrmObjects", {
        user: { email: "person@example.com" },
        input: {
          objectType: "users",
          limit: 3,
          properties: ["hs_email"]
        }
      }),
      {
        searchHubSpotReadableCrmObjects: async (token, input) => {
          expect(token).toBe("hubspot-token");
          expect(input).toEqual({
            objectType: "users",
            limit: 3,
            properties: ["hs_email"]
          });
          return [
            {
              id: "user-object-1",
              properties: {
                hs_email: "user@example.com"
              }
            }
          ];
        }
      }
    );

    expect(crmResponse.status).toBe(200);
    expect(await crmResponse.json()).toEqual({
      classification: "user_private",
      content: [
        {
          id: "user-object-1",
          properties: {
            hs_email: "user@example.com"
          }
        }
      ]
    });

    const usersResponse = await handleToolGatewayRequest(
      config,
      createStore(hubspotConnection),
      "hubspot.listUsers",
      request("hubspot.listUsers", {
        user: { email: "person@example.com" },
        input: { limit: 2 }
      }),
      {
        listHubSpotUsers: async (token, input) => {
          expect(token).toBe("hubspot-token");
          expect(input).toEqual({ limit: 2 });
          return [{ id: "7", email: "user@example.com" }];
        }
      }
    );

    expect(usersResponse.status).toBe(200);
    expect(await usersResponse.json()).toEqual({
      classification: "user_private",
      content: [{ id: "7", email: "user@example.com" }]
    });

    const readResponse = await handleToolGatewayRequest(
      config,
      createStore(hubspotConnection),
      "hubspot.readApiResource",
      request("hubspot.readApiResource", {
        user: { email: "person@example.com" },
        input: {
          path: "/crm/v3/schemas/deals",
          query: { archived: false }
        }
      }),
      {
        readHubSpotApiResource: async (token, input) => {
          expect(token).toBe("hubspot-token");
          expect(input).toEqual({
            path: "/crm/v3/schemas/deals",
            query: { archived: false }
          });
          return {
            path: "/crm/v3/schemas/deals",
            query: { archived: "false" },
            content: { name: "deals" }
          };
        }
      }
    );

    expect(readResponse.status).toBe(200);
    expect(await readResponse.json()).toEqual({
      classification: "user_private",
      content: {
        path: "/crm/v3/schemas/deals",
        query: { archived: "false" },
        content: { name: "deals" }
      }
    });
  });

  test("lets a runtime register a scheduled job provider capability", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_abcdefabcdefabcdefabcdef",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "C123"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const upserts: unknown[] = [];
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], { upserts }),
      "scheduledJob.registerCapability",
      request(
        "scheduledJob.registerCapability",
        {
          input: {
            jobId: "ai-news-hourly",
            requiredTools: [
              "google.getDriveFile",
              "google.appendToDriveTextFile"
            ],
            routeId: "convrt_abcdefabcdefabcdefabcdef",
            stateRefs: [
              {
                provider: "google",
                kind: "drive_file",
                id: "file-1",
                purpose: "dedupe scratchpad"
              }
            ],
            visibilityPolicy: {
              maxOutputVisibility: "public",
              allowPrivateToolDeclassification: true
            }
          }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(200);
    expect(upserts).toEqual([
      expect.objectContaining({
        jobId: "ai-news-hourly",
        workspaceId: "T123",
        slackUserId: "U123",
        routeId: "convrt_abcdefabcdefabcdefabcdef",
        requiredTools: [
          "google_append_to_drive_text_file",
          "google_get_drive_file"
        ],
        runtimeType: "openclaw",
        policyHash: "policy-hash"
      })
    ]);
    const body = await response.json();
    expect(body.content.scheduledJob).toMatchObject({
      jobId: "ai-news-hourly",
      allowedTools: [
        "google_append_to_drive_text_file",
        "google_get_drive_file"
      ],
      routeId: "convrt_abcdefabcdefabcdefabcdef"
    });
    expect(body.content.scheduledPromptInstruction).toContain(
      "jobId=ai-news-hourly"
    );
    expect(body.content.scheduledPromptInstruction).toContain(
      "Use Burble provider calls with this jobId"
    );
    expect(body.content.scheduledPromptInstruction).toContain(
      "These allowedTools are Burble provider tool names, not necessarily native runtime tool names."
    );
    expect(body.content.scheduledPromptInstruction).not.toContain("cronjob");
    expect(body.content.scheduledPromptInstruction).toContain(
      "burble_provider_call"
    );
    expect(body.content.scheduledPromptInstruction).toContain(
      "toolName set to one allowedTools value"
    );
    expect(body.content.scheduledPromptInstruction).toContain(
      "input set to that provider tool's required arguments plus jobId=ai-news-hourly"
    );
    expect(body.content.scheduledPromptInstruction).toContain(
      "Do not call burble_provider_call with only jobId"
    );
    expect(body.content.scheduledPromptInstruction).not.toContain(
      '"input":{"jobId":"ai-news-hourly"}}'
    );
    expect(body.content.scheduledPromptInstruction).toContain(
      "Do not use direct web/browser access to provider URLs"
    );
    expect(body.content.scheduledPromptInstruction).toContain(
      "For every scheduled provider call, include this jobId"
    );
    expect(body.content.scheduledPromptInstruction).toContain(
      "use only the listed allowedTools"
    );
    expect(body.content.scheduledPromptInstruction).toContain(
      'For scheduled/background delivery, use the resolved Burble conversation route id "convrt_abcdefabcdefabcdefabcdef".'
    );
    expect(body.content.scheduledPromptInstruction).toContain(
      "Do not use Slack channel names, Slack mentions, channel ids, or the original destination label as a delivery route."
    );
    expect(body.content.scheduledPromptInstruction).not.toContain("Hermes");
  });

  test("returns Hermes native toolset requirements for scheduled provider capabilities", async () => {
    const upserts: unknown[] = [];
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, hermesRuntime, [], null, [], { upserts }),
      "scheduledJob.registerCapability",
      request(
        "scheduledJob.registerCapability",
        {
          input: {
            jobId: "github-pr-monitor",
            requiredTools: [
              "github.searchIssues",
              "google.getDriveFile"
            ]
          }
        },
        "runtime-token-u123",
        "rt_hermes"
      )
    );

    expect(response.status).toBe(200);
    expect(upserts).toEqual([
      expect.objectContaining({
        jobId: "github-pr-monitor",
        runtimeType: "hermes",
        requiredTools: [
          "github_search_issues",
          "google_get_drive_file"
        ]
      })
    ]);
    const body = await response.json();
    expect(body.content.scheduledJob).toMatchObject({
      jobId: "github-pr-monitor",
      runtimeType: "hermes",
      nativeToolsets: ["burble"],
      allowedTools: [
        "github_search_issues",
        "google_get_drive_file"
      ]
    });
    expect(body.content.scheduledPromptInstruction).not.toContain("Hermes");
  });

  test("adds Hermes web native toolset only for native scheduled web tools", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, hermesRuntime),
      "scheduledJob.registerCapability",
      request(
        "scheduledJob.registerCapability",
        {
          input: {
            jobId: "public-ai-news",
            requiredTools: ["web_extract"]
          }
        },
        "runtime-token-u123",
        "rt_hermes"
      )
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.content.scheduledJob).toMatchObject({
      jobId: "public-ai-news",
      runtimeType: "hermes",
      nativeToolsets: ["burble", "web"],
      allowedTools: ["web_extract"]
    });
  });

  test("lets a runtime list scheduled jobs through the control plane", async () => {
    const jobs: ReturnType<TokenStore["listScheduledJobsForPrincipal"]> = [
      {
        jobId: "ai-news-hourly",
        workspaceId: "T123",
        slackUserId: "U123",
        title: "Hourly AI news summary",
        prompt: "Find fresh AI news and summarize it.",
        schedule: { kind: "interval", every: { hours: 1 } },
        routeId: "convrt_abcdefabcdefabcdefabcdef",
        state: "scheduled",
        runtimeType: "hermes",
        createdAt: "2026-06-24T11:00:00.000Z",
        updatedAt: "2026-06-24T11:05:00.000Z"
      }
    ];
    const capability: AgentJobCapabilityRecord = {
      jobId: "legacy-ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["web_extract"],
      routeId: "convrt_abcdefabcdefabcdefabcdef",
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "hermes",
      stateRefs: [],
      visibilityPolicy: {},
      createdAt: "2026-06-24T11:00:00.000Z",
      updatedAt: "2026-06-24T11:05:00.000Z"
    };

    const response = await handleToolGatewayRequest(
      config,
      createStore(
        null,
        runtime,
        [],
        null,
        [],
        { list: [capability] },
        [],
        null,
        {},
        { list: jobs }
      ),
      "scheduledJob.list",
      request(
        "scheduledJob.list",
        { input: {} },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        jobs: [
          {
            jobId: "ai-news-hourly",
            title: "Hourly AI news summary",
            prompt: "Find fresh AI news and summarize it.",
            schedule: { kind: "interval", every: { hours: 1 } },
            state: "scheduled",
            runtimeType: "hermes",
            requiredTools: [],
            routeId: "convrt_abcdefabcdefabcdefabcdef",
            updatedAt: "2026-06-24T11:05:00.000Z"
          }
        ]
      }
    });
  });

  test("lets a runtime create a Burble-owned scheduled job", async () => {
    const upserts: unknown[] = [];
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], null, [], {}, [], null, {}, { upserts }),
      "scheduledJob.create",
      request(
        "scheduledJob.create",
        {
          input: {
            title: "Hourly AI news summary",
            prompt: "look for fresh AI-related news and post a short summary",
            schedule: {
              kind: "interval",
              every: { hours: 1 }
            },
            routeId: "convrt_abcdefabcdefabcdefabcdef"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(200);
    expect(upserts).toEqual([
      expect.objectContaining({
        jobId: expect.stringMatching(/^job_/),
        workspaceId: "T123",
        slackUserId: "U123",
        title: "Hourly AI news summary",
        prompt: "look for fresh AI-related news and post a short summary",
        schedule: {
          kind: "interval",
          every: { hours: 1 }
        },
        routeId: "convrt_abcdefabcdefabcdefabcdef",
        runtimeType: "openclaw",
        state: "scheduled"
      })
    ]);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        ok: true,
        job: expect.objectContaining({
          jobId: expect.stringMatching(/^job_/),
          title: "Hourly AI news summary",
          state: "scheduled",
          runtimeType: "openclaw"
        })
      }
    });
  });

  test("lets a runtime pause, resume, and delete a Burble-owned scheduled job", async () => {
    const jobs: ReturnType<TokenStore["listScheduledJobsForPrincipal"]> = [
      {
        jobId: "job-ai-news-hourly",
        workspaceId: "T123",
        slackUserId: "U123",
        title: "Hourly AI news summary",
        prompt: "Find fresh AI news and summarize it.",
        schedule: {
          kind: "interval",
          every: { hours: 1 }
        },
        routeId: "convrt_abcdefabcdefabcdefabcdef",
        state: "scheduled",
        runtimeType: "openclaw",
        createdAt: "2026-06-24T12:00:00.000Z",
        updatedAt: "2026-06-24T12:00:00.000Z"
      }
    ];
    const store = createStore(
      null,
      runtime,
      [],
      null,
      [],
      {},
      [],
      null,
      {},
      { list: jobs }
    );

    const pause = await handleToolGatewayRequest(
      config,
      store,
      "scheduledJob.pause",
      request(
        "scheduledJob.pause",
        { input: { jobId: "job-ai-news-hourly" } },
        "runtime-token-u123",
        "rt_u123"
      )
    );
    expect(pause.status).toBe(200);
    expect(await pause.json()).toMatchObject({
      classification: "user_private",
      content: {
        ok: true,
        job: {
          jobId: "job-ai-news-hourly",
          state: "paused"
        }
      }
    });

    const resume = await handleToolGatewayRequest(
      config,
      store,
      "scheduledJob.resume",
      request(
        "scheduledJob.resume",
        { input: { jobId: "job-ai-news-hourly" } },
        "runtime-token-u123",
        "rt_u123"
      )
    );
    expect(resume.status).toBe(200);
    expect(await resume.json()).toMatchObject({
      classification: "user_private",
      content: {
        ok: true,
        job: {
          jobId: "job-ai-news-hourly",
          state: "scheduled"
        }
      }
    });

    const deletion = await handleToolGatewayRequest(
      config,
      store,
      "scheduledJob.delete",
      request(
        "scheduledJob.delete",
        { input: { jobId: "job-ai-news-hourly" } },
        "runtime-token-u123",
        "rt_u123"
      )
    );
    expect(deletion.status).toBe(200);
    expect(await deletion.json()).toEqual({
      classification: "user_private",
      content: {
        ok: true,
        jobId: "job-ai-news-hourly"
      }
    });
    expect(jobs).toEqual([]);
  });

  test("lets a runtime trigger a scheduled job through the control plane", async () => {
    const jobs: ReturnType<TokenStore["listScheduledJobsForPrincipal"]> = [
      {
        jobId: "ai-news-hourly",
        workspaceId: "T123",
        slackUserId: "U123",
        title: "Hourly AI news summary",
        prompt: "Find fresh AI news and summarize it.",
        schedule: { kind: "interval", every: { hours: 1 } },
        routeId: null,
        state: "scheduled",
        runtimeType: "openclaw",
        createdAt: "2026-06-24T11:00:00.000Z",
        updatedAt: "2026-06-24T11:05:00.000Z"
      }
    ];
    const capability: AgentJobCapabilityRecord = {
      jobId: "legacy-ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["web_extract"],
      routeId: null,
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {},
      createdAt: "2026-06-24T11:00:00.000Z",
      updatedAt: "2026-06-24T11:05:00.000Z"
    };
    const runs: AgentJobRunRecord[] = [];

    const response = await handleToolGatewayRequest(
      config,
      createStore(
        null,
        runtime,
        [],
        null,
        [],
        { list: [capability] },
        [],
        null,
        { created: runs },
        { list: jobs }
      ),
      "scheduledJob.trigger",
      request(
        "scheduledJob.trigger",
        { input: { jobId: "ai-news-hourly" } },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(200);
    expect(runs).toEqual([
      expect.objectContaining({
        runId: expect.stringMatching(/^jobrun_/),
        jobId: "ai-news-hourly",
        workspaceId: "T123",
        slackUserId: "U123",
        triggerSource: "manual",
        status: "queued"
      })
    ]);
    const body = await response.json();
    expect(body.content).toMatchObject({
      ok: true,
      jobId: "ai-news-hourly",
      run: {
        jobId: "ai-news-hourly",
        triggerSource: "manual",
        status: "queued"
      }
    });
  });

  test("lets a runtime read the latest scheduled job run status", async () => {
    const latest: AgentJobRunRecord = {
      runId: "jobrun_latest",
      jobId: "ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      triggerSource: "manual",
      status: "succeeded",
      failureReason: null,
      createdAt: "2026-06-24T12:00:00.000Z",
      updatedAt: "2026-06-24T12:01:00.000Z",
      startedAt: "2026-06-24T12:00:01.000Z",
      finishedAt: "2026-06-24T12:01:00.000Z"
    };

    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], null, [], {}, [], null, {
        latest
      }),
      "scheduledJob.latestRunStatus",
      request(
        "scheduledJob.latestRunStatus",
        { input: { jobId: "ai-news-hourly" } },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        ok: true,
        run: latest
      }
    });
  });

  test("requires runtime auth for scheduler control tools", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime),
      "scheduledJob.list",
      request("scheduledJob.list", { input: {} })
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Runtime auth required");
  });

  test("binds channel destination routes to the scheduled job during registration", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "C123",
        isDirectMessage: false,
        rootId: "channel:C123"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: null,
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const upserts: unknown[] = [];
    const routeUpserts: unknown[] = [];

    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], { upserts }, [], routeUpserts),
      "scheduledJob.registerCapability",
      request(
        "scheduledJob.registerCapability",
        {
          input: {
            jobId: "ai-news-public-safe-15m",
            requiredTools: ["web.search"],
            destination: {
              channelName: "#burble-test"
            },
            visibilityPolicy: {
              maxOutputVisibility: "public"
            }
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        resolveSlackChannelIdByName: async (input) => {
          expect(input).toEqual({
            workspaceId: "T123",
            channelName: "burble-test"
          });
          return "C123";
        }
      }
    );

    expect(response.status).toBe(200);
    expect(routeUpserts).toEqual([
      expect.objectContaining({
        workspaceId: "T123",
        slackUserId: "U123",
        transport: "slack",
        kind: "grant",
        grantedBySlackUserId: "U123",
        destination: {
          channelId: "C123",
          isDirectMessage: false,
          rootId: "channel:C123"
        },
        binding: {
          jobId: "ai-news-public-safe-15m",
          runtimeId: "rt_u123"
        }
      })
    ]);
    expect(upserts).toEqual([
      expect.objectContaining({
        jobId: "ai-news-public-safe-15m",
        routeId: "convrt_aaaaaaaaaaaaaaaaaaaaaaaa",
        visibilityPolicy: {
          maxOutputVisibility: "public"
        }
      })
    ]);
    const body = await response.json();
    expect(body.content.scheduledJob).toMatchObject({
      jobId: "ai-news-public-safe-15m",
      routeId: "convrt_aaaaaaaaaaaaaaaaaaaaaaaa"
    });
    expect(body.content.scheduledPromptInstruction).toContain(
      'For scheduled/background delivery, use the resolved Burble conversation route id "convrt_aaaaaaaaaaaaaaaaaaaaaaaa".'
    );
  });

  test("rejects channel destination grants for non-public scheduled output", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "C123",
        isDirectMessage: false,
        rootId: "channel:C123"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: null,
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };

    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route),
      "scheduledJob.registerCapability",
      request(
        "scheduledJob.registerCapability",
        {
          input: {
            jobId: "ai-news-hourly",
            requiredTools: ["google.getDriveFile"],
            routeId: "convrt_1234567890abcdef12345678",
            visibilityPolicy: {
              maxOutputVisibility: "user_private"
            }
          }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(403);
    const text = await response.text();
    expect(text).toContain(
      "Destination grant requires public scheduled output visibility"
    );
    expect(text).toContain(
      '"maxOutputVisibility":"public"'
    );
  });

  test("allows private channel destination grants for non-public scheduled output", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "G123",
        isDirectMessage: false,
        isPrivateChannel: true,
        rootId: "channel:G123"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: null,
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const upserts: unknown[] = [];

    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], { upserts }),
      "scheduledJob.registerCapability",
      request(
        "scheduledJob.registerCapability",
        {
          input: {
            jobId: "private-digest",
            requiredTools: ["github.searchIssues", "conversation.sendMessage"],
            routeId: "convrt_1234567890abcdef12345678",
            visibilityPolicy: {
              maxOutputVisibility: "user_private"
            }
          }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(200);
    expect(upserts).toMatchObject([
      {
        jobId: "private-digest",
        requiredTools: ["conversation.sendMessage", "github_search_issues"],
        routeId: "convrt_1234567890abcdef12345678",
        visibilityPolicy: {
          maxOutputVisibility: "user_private"
        }
      }
    ]);
  });

  test("rejects channel destination grants for authenticated provider read-source jobs", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "C123",
        isDirectMessage: false,
        rootId: "channel:C123"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: null,
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const upserts: unknown[] = [];
    const routeUpserts: unknown[] = [];

    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], { upserts }, [], routeUpserts),
      "scheduledJob.registerCapability",
      request(
        "scheduledJob.registerCapability",
        {
          input: {
            jobId: "github-digest",
            requiredTools: ["github.searchIssues"],
            destination: "#eng",
            visibilityPolicy: {
              maxOutputVisibility: "public"
            }
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        resolveSlackChannelIdByName: async () => "C123"
      }
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain(
      "Public Slack channel destination grants cannot be used for scheduled jobs that read from authenticated Burble provider sources"
    );
    expect(upserts).toEqual([]);
  });

  test("allows channel destination grants for public jobs that only write provider state", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "C123",
        isDirectMessage: false,
        rootId: "channel:C123"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: null,
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const upserts: unknown[] = [];
    const routeUpserts: unknown[] = [];

    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], { upserts }, [], routeUpserts),
      "scheduledJob.registerCapability",
      request(
        "scheduledJob.registerCapability",
        {
          input: {
            jobId: "public-news-dedupe",
            requiredTools: [
              "conversation.sendMessage",
              "google.createDriveTextFile"
            ],
            destination: "#eng",
            visibilityPolicy: {
              maxOutputVisibility: "public"
            }
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        resolveSlackChannelIdByName: async () => "C123"
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      content: {
        ok: true,
        scheduledJob: {
          routeId: "convrt_aaaaaaaaaaaaaaaaaaaaaaaa"
        }
      }
    });
    expect(upserts).toMatchObject([
      {
        jobId: "public-news-dedupe",
        requiredTools: [
          "conversation.sendMessage",
          "google_create_drive_text_file"
        ],
        routeId: "convrt_aaaaaaaaaaaaaaaaaaaaaaaa",
        visibilityPolicy: {
          maxOutputVisibility: "public"
        }
      }
    ]);
  });

  for (const { name, visibilityInput } of [
    {
      name: "JSON string visibilityPolicy",
      visibilityInput: {
        visibilityPolicy: '{"maxOutputVisibility":"public"}'
      }
    }
  ]) {
    test(`accepts scheduled channel visibility policy from ${name}`, async () => {
      const route: ConversationRouteRecord = {
        id: "convrt_1234567890abcdef12345678",
        workspaceId: "T123",
        slackUserId: "U123",
        transport: "slack",
        destinationJson: JSON.stringify({
          channelId: "C123",
          isDirectMessage: false,
          rootId: "channel:C123"
        }),
        kind: "grant",
        grantedBySlackUserId: "U123",
        expiresAt: null,
        bindingJson: null,
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.000Z",
        revokedAt: null
      };
      const upserts: unknown[] = [];
      const routeUpserts: unknown[] = [];

      const response = await handleToolGatewayRequest(
        config,
        createStore(null, runtime, [], route, [], { upserts }, [], routeUpserts),
        "scheduledJob.registerCapability",
        request(
          "scheduledJob.registerCapability",
          {
            input: {
              jobId: "public-news-dedupe",
              requiredTools: [
                "conversation.sendMessage",
                "google.updateDriveTextFile"
              ],
              destination: "#eng",
              ...visibilityInput
            }
          },
          "runtime-token-u123",
          "rt_u123"
        ),
        {
          resolveSlackChannelIdByName: async () => "C123"
        }
      );

      expect(response.status).toBe(200);
      expect(upserts).toEqual([
        expect.objectContaining({
          jobId: "public-news-dedupe",
          routeId: "convrt_aaaaaaaaaaaaaaaaaaaaaaaa",
          visibilityPolicy: {
            maxOutputVisibility: "public"
          }
        })
      ]);
    });
  }

  test("does not accept top-level output visibility aliases for scheduled channel grants", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "C123",
        isDirectMessage: false,
        rootId: "channel:C123"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: null,
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const upserts: unknown[] = [];

    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], { upserts }),
      "scheduledJob.registerCapability",
      request(
        "scheduledJob.registerCapability",
        {
          input: {
            jobId: "public-news-dedupe",
            requiredTools: ["conversation.sendMessage"],
            destination: "#eng",
            maxOutputVisibility: "public"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        resolveSlackChannelIdByName: async () => "C123"
      }
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain(
      "Destination grant requires public scheduled output visibility"
    );
    expect(upserts).toEqual([]);
  });

  test("resolves a scheduled job destination channel name to an existing grant", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "CENG",
        isDirectMessage: false,
        rootId: "channel:CENG"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: null,
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const upserts: unknown[] = [];
    const routeUpserts: unknown[] = [];
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], { upserts }, [], routeUpserts),
      "scheduledJob.registerCapability",
      request(
        "scheduledJob.registerCapability",
        {
          input: {
            jobId: "daily-standup",
            requiredTools: ["conversation.sendMessage"],
            destination: "#eng",
            visibilityPolicy: {
              maxOutputVisibility: "public"
            }
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        resolveSlackChannelIdByName: async (input) => {
          expect(input).toEqual({
            workspaceId: "T123",
            channelName: "eng"
          });
          return "CENG";
        }
      }
    );

    expect(response.status).toBe(200);
    expect(upserts).toEqual([
      expect.objectContaining({
        jobId: "daily-standup",
        routeId: "convrt_aaaaaaaaaaaaaaaaaaaaaaaa"
      })
    ]);
    const body = await response.json();
    expect(body.content.scheduledJob).toMatchObject({
      jobId: "daily-standup",
      routeId: "convrt_aaaaaaaaaaaaaaaaaaaaaaaa"
    });
    expect(body.content.scheduledPromptInstruction).toContain(
      'For scheduled/background delivery, use the resolved Burble conversation route id "convrt_aaaaaaaaaaaaaaaaaaaaaaaa".'
    );
    expect(body.content.scheduledPromptInstruction).toContain(
      "Do not use Slack channel names, Slack mentions, channel ids, or the original destination label as a delivery route."
    );
  });

  test("stores trimmed scheduled route ids from top-level input", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "CENG",
        isDirectMessage: false,
        rootId: "channel:CENG"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: null,
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const upserts: unknown[] = [];
    const routeUpserts: unknown[] = [];
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], { upserts }, [], routeUpserts),
      "scheduledJob.registerCapability",
      request(
        "scheduledJob.registerCapability",
        {
          input: {
            jobId: "daily-standup",
            requiredTools: ["conversation.sendMessage"],
            routeId: "  convrt_1234567890abcdef12345678\n",
            visibilityPolicy: {
              maxOutputVisibility: "public"
            }
          }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(200);
    expect(upserts).toEqual([
      expect.objectContaining({
        jobId: "daily-standup",
        routeId: "convrt_1234567890abcdef12345678"
      })
    ]);
    const body = await response.json();
    expect(body.content.scheduledJob).toMatchObject({
      routeId: "convrt_1234567890abcdef12345678"
    });
  });

  test("rejects scheduled registrations that mix routeId with a named destination", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "D123",
        isDirectMessage: true,
        rootId: "dm:D123"
      }),
      kind: "origin",
      grantedBySlackUserId: null,
      expiresAt: null,
      bindingJson: null,
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const upserts: unknown[] = [];

    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], { upserts }),
      "scheduledJob.registerCapability",
      request(
        "scheduledJob.registerCapability",
        {
          input: {
            jobId: "public-news-dedupe",
            requiredTools: ["conversation.sendMessage"],
            routeId: "convrt_1234567890abcdef12345678",
            destination: "#burble-test",
            visibilityPolicy: {
              maxOutputVisibility: "public"
            }
          }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "requires either routeId or destination, not both"
    );
    expect(upserts).toEqual([]);
  });

  test("warns routeless scheduled jobs not to configure Burble channel delivery", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime),
      "scheduledJob.registerCapability",
      request(
        "scheduledJob.registerCapability",
        {
          input: {
            jobId: "daily-standup",
            requiredTools: ["google.getDriveFile"]
          }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.content.scheduledJob).toMatchObject({
      jobId: "daily-standup"
    });
    expect(body.content.scheduledJob.routeId).toBeUndefined();
    expect(body.content.scheduledPromptInstruction).toContain(
      "No scheduled/background Burble delivery route is authorized for this job."
    );
    expect(body.content.scheduledPromptInstruction).toContain(
      "Do not set delivery.channel to \"burble\" or delivery.to to a Slack channel name, Slack mention, channel id, or guessed route id."
    );
  });

  test("rejects malformed object-form scheduled route ids", async () => {
    const upserts: unknown[] = [];
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], null, [], { upserts }),
      "scheduledJob.registerCapability",
      request(
        "scheduledJob.registerCapability",
        {
          input: {
            jobId: "daily-standup",
            requiredTools: ["conversation.sendMessage"],
            destination: {
              routeId: "convrt_burbletest"
            },
            visibilityPolicy: {
              maxOutputVisibility: "public"
            }
          }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "Conversation route id must be a resolved convrt_* route id"
    );
    expect(upserts).toEqual([]);
  });

  test("resolves short uppercase scheduled destination names through channel lookup", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "C0GTMREAL",
        isDirectMessage: false,
        rootId: "channel:C0GTMREAL"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: null,
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const upserts: unknown[] = [];
    const routeUpserts: unknown[] = [];
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], { upserts }, [], routeUpserts),
      "scheduledJob.registerCapability",
      request(
        "scheduledJob.registerCapability",
        {
          input: {
            jobId: "daily-standup",
            requiredTools: ["conversation.sendMessage"],
            destination: "GTM",
            visibilityPolicy: {
              maxOutputVisibility: "public"
            }
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        resolveSlackChannelIdByName: async (input) => {
          expect(input).toEqual({
            workspaceId: "T123",
            channelName: "GTM"
          });
          return "C0GTMREAL";
        }
      }
    );

    expect(response.status).toBe(200);
    expect(upserts).toEqual([
      expect.objectContaining({
        routeId: "convrt_aaaaaaaaaaaaaaaaaaaaaaaa"
      })
    ]);
  });

  test("resolves a scheduled job destination Slack channel mention without name lookup", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "CENG",
        isDirectMessage: false,
        rootId: "channel:CENG"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: null,
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const upserts: unknown[] = [];
    const routeUpserts: unknown[] = [];
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], { upserts }, [], routeUpserts),
      "scheduledJob.registerCapability",
      request(
        "scheduledJob.registerCapability",
        {
          input: {
            jobId: "daily-standup",
            requiredTools: ["conversation.sendMessage"],
            destination: "<#CENG|eng>",
            visibilityPolicy: {
              maxOutputVisibility: "public"
            }
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        resolveSlackChannelIdByName: async () => {
          throw new Error("Slack mention should not require name lookup");
        }
      }
    );

    expect(response.status).toBe(200);
    expect(upserts).toEqual([
      expect.objectContaining({
        routeId: "convrt_aaaaaaaaaaaaaaaaaaaaaaaa"
      })
    ]);
  });

  test("rejects scheduled destination labels without an active grant", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime),
      "scheduledJob.registerCapability",
      request(
        "scheduledJob.registerCapability",
        {
          input: {
            jobId: "daily-standup",
            requiredTools: ["conversation.sendMessage"],
            destination: "#eng",
            visibilityPolicy: {
              maxOutputVisibility: "public"
            }
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        resolveSlackChannelIdByName: async () => "CENG"
      }
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Destination grant not found");
  });

  test("returns a clean miss when Slack channel-name lookup fails transiently", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("Slack unavailable");
    }) as unknown as typeof fetch;
    try {
      const response = await handleToolGatewayRequest(
        config,
        createStore(null, runtime),
        "scheduledJob.registerCapability",
        request(
          "scheduledJob.registerCapability",
          {
            input: {
              jobId: "daily-standup",
              requiredTools: ["conversation.sendMessage"],
              destination: "#eng",
              visibilityPolicy: {
                maxOutputVisibility: "public"
              }
            }
          },
          "runtime-token-u123",
          "rt_u123"
        )
      );

      expect(response.status).toBe(404);
      expect(await response.text()).toContain("Destination grant not found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects scheduled route grants bound to another job", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "C123",
        isDirectMessage: false,
        rootId: "channel:C123"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: JSON.stringify({
        jobId: "another-job",
        runtimeId: "rt_u123"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };

    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route),
      "scheduledJob.registerCapability",
      request(
        "scheduledJob.registerCapability",
        {
          input: {
            jobId: "ai-news-hourly",
            requiredTools: ["google.getDriveFile"],
            routeId: "convrt_1234567890abcdef12345678",
            visibilityPolicy: {
              maxOutputVisibility: "public"
            }
          }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Conversation route job mismatch");
  });

  test("accepts scheduled job provider capability aliases used by native runtimes", async () => {
    const cases: Array<{ name: string; input: unknown }> = [
      {
        name: "camelCase",
        input: {
          scheduledJobId: "ai-news-hourly",
          allowedTools: [
            "google_get_drive_file",
            "google_append_to_drive_text_file"
          ]
        }
      },
      {
        name: "snake_case",
        input: {
          scheduled_job_id: "ai-news-hourly",
          allowed_tools: [
            "google_get_drive_file",
            "google_append_to_drive_text_file"
          ]
        }
      },
      {
        name: "nested scheduledJob",
        input: {
          scheduledJob: {
            jobId: "ai-news-hourly",
            requiredTools: [
              "google_get_drive_file",
              "google_append_to_drive_text_file"
            ]
          }
        }
      },
      {
        name: "nested scheduled_job",
        input: {
          scheduled_job: {
            job_id: "ai-news-hourly",
            required_tools: [
              "google_get_drive_file",
              "google_append_to_drive_text_file"
            ]
          }
        }
      },
      {
        name: "nested capability",
        input: {
          capability: {
            job_id: "ai-news-hourly",
            tools: [
              "google_get_drive_file",
              "google_append_to_drive_text_file"
            ]
          }
        }
      },
      {
        name: "comma-delimited tools",
        input: {
          jobId: "ai-news-hourly",
          tools:
            "google_get_drive_file, google_append_to_drive_text_file",
          route_id: null,
          state_refs: {
            provider: "google",
            kind: "drive_file",
            id: "file-1"
          },
          runtime_type: "nemo-hermes"
        }
      },
      {
        name: "descriptor tools",
        input: {
          jobId: "ai-news-hourly",
          tools: [
            { name: "google_get_drive_file" },
            { toolName: "google_append_to_drive_text_file" }
          ]
        }
      },
      {
        name: "tool map",
        input: {
          jobId: "ai-news-hourly",
          tools: {
            google_get_drive_file: true,
            google_append_to_drive_text_file: {
              tool_name: "google_append_to_drive_text_file"
            }
          }
        }
      }
    ];

    for (const testCase of cases) {
      const upserts: unknown[] = [];
      const response = await handleToolGatewayRequest(
        config,
        createStore(null, runtime, [], null, [], { upserts }),
        "scheduledJob.registerCapability",
        request(
          "scheduledJob.registerCapability",
          { input: testCase.input },
          "runtime-token-u123",
          "rt_u123"
        )
      );

      expect(response.status, testCase.name).toBe(200);
      expect(upserts, testCase.name).toEqual([
        expect.objectContaining({
          jobId: "ai-news-hourly",
          requiredTools: [
            "google_append_to_drive_text_file",
            "google_get_drive_file"
          ]
        })
      ]);
      const body = await response.json();
      expect(body.content.scheduledJob, testCase.name).toMatchObject({
        jobId: "ai-news-hourly",
        allowedTools: [
          "google_append_to_drive_text_file",
          "google_get_drive_file"
        ]
      });
    }
  });

  test("normalizes scheduled job registration metadata aliases", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_abcdefabcdefabcdefabcdef",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "C123"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const upserts: unknown[] = [];
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], { upserts }),
      "scheduledJob.registerCapability",
      request(
        "scheduledJob.registerCapability",
        {
          input: {
            scheduled_job: {
              job_id: "ai-news-hourly",
              allowed_tools: [
                "google_get_drive_file",
                "google_append_to_drive_text_file"
              ],
              route_id: "convrt_abcdefabcdefabcdefabcdef",
              capability_profile: "scheduled_job",
              runtime_type: "hermes",
              state_refs: [
                {
                  provider: "google",
                  kind: "drive_file",
                  id: "file-1"
                }
              ],
              visibility_policy: {
                maxOutputVisibility: "public"
              }
            }
          }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(200);
    expect(upserts).toEqual([
      expect.objectContaining({
        jobId: "ai-news-hourly",
        routeId: "convrt_abcdefabcdefabcdefabcdef",
        capabilityProfile: "scheduled_job",
        runtimeType: "hermes",
        requiredTools: [
          "google_append_to_drive_text_file",
          "google_get_drive_file"
        ],
        stateRefs: [
          {
            provider: "google",
            kind: "drive_file",
            id: "file-1"
          }
        ],
        visibilityPolicy: {
          maxOutputVisibility: "public"
        }
      })
    ]);
  });

  test("returns field-level errors for invalid scheduled job provider registrations", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime),
      "scheduledJob.registerCapability",
      request(
        "scheduledJob.registerCapability",
        {
          input: {
            job_id: "ai-news-hourly",
            requiredTools: 42
          }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      classification: "user_private",
      content: {
        error: "invalid_scheduled_job_capability_input",
        message:
          "scheduledJob.registerCapability requires requiredTools, allowedTools, required_tools, allowed_tools, or tools to be a non-empty string, string array, or tool descriptor array.",
        diagnostics: {
          receivedKeys: ["job_id", "requiredTools"],
          nestedKeys: [],
          normalizedKeys: ["jobId", "requiredTools"]
        }
      }
    });
  });

  test("rejects overly broad scheduled job registration aliases and malformed state refs", async () => {
    const idAliasResponse = await handleToolGatewayRequest(
      config,
      createStore(null, runtime),
      "scheduledJob.registerCapability",
      request(
        "scheduledJob.registerCapability",
        {
          input: {
            id: "ai-news-hourly",
            requiredTools: ["google_get_drive_file"]
          }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(idAliasResponse.status).toBe(400);
    await expect(idAliasResponse.json()).resolves.toMatchObject({
      content: {
        error: "invalid_scheduled_job_capability_input",
        message:
          "scheduledJob.registerCapability requires jobId, scheduledJobId, job_id, or scheduled_job_id to be a non-empty string."
      }
    });

    const stateRefResponse = await handleToolGatewayRequest(
      config,
      createStore(null, runtime),
      "scheduledJob.registerCapability",
      request(
        "scheduledJob.registerCapability",
        {
          input: {
            jobId: "ai-news-hourly",
            requiredTools: ["google_get_drive_file"],
            stateRefs: [{ provider: "google", id: "file-1" }]
          }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(stateRefResponse.status).toBe(400);
    await expect(stateRefResponse.json()).resolves.toMatchObject({
      content: {
        error: "invalid_scheduled_job_capability_input",
        message:
          "scheduledJob.registerCapability requires every stateRefs entry to include provider and kind strings."
      }
    });
  });

  test("enforces scheduled job tool capabilities for runtime tool gateway calls", async () => {
    const capability: AgentJobCapabilityRecord = {
      jobId: "ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["google.searchDriveFiles"],
      routeId: null,
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {},
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };
    const response = await handleToolGatewayRequest(
      config,
      createStore(googleConnection, runtime, [], null, [], { found: capability }),
      "google.searchDriveFiles",
      request(
        "google.searchDriveFiles",
        {
          input: {
            job_id: "ai-news-hourly",
            query: "AI News Scratchpad",
            limit: 1
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        searchGoogleDriveFiles: async (token, input) => {
          expect(token).toBe("google-token");
          expect(input).toEqual({
            query: "AI News Scratchpad",
            limit: 1
          });
          return [{ id: "file-1", name: "AI News Scratchpad" }];
        }
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      classification: "user_private",
      content: [{ id: "file-1", name: "AI News Scratchpad" }]
    });
  });

  test("routes scheduled conformance echo through the gateway allowlist", async () => {
    const capability: AgentJobCapabilityRecord = {
      jobId: "contract-scheduled-job",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["runtime.conformance.echo"],
      routeId: null,
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {},
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };
    const runtimeEvents: unknown[] = [];
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, runtimeEvents, null, [], { found: capability }),
      "runtime.conformance.echo",
      request(
        "runtime.conformance.echo",
        {
          scheduledJob: {
            jobId: "contract-scheduled-job"
          },
          input: {
            jobId: "contract-scheduled-job",
            message: "scheduled provider bridge probe"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      classification: "user_private",
      content: {
        ok: true,
        toolName: "runtime.conformance.echo",
        input: {
          message: "scheduled provider bridge probe"
        }
      }
    });
    expect(runtimeEvents).toEqual([
      {
        runtimeId: "rt_u123",
        eventType: "runtime_tool_called",
        summary: {
          toolName: "runtime.conformance.echo",
          classification: "user_private",
          itemCount: null
        }
      }
    ]);
  });

  test("rejects runtime tool gateway calls outside the scheduled job capability", async () => {
    const capability: AgentJobCapabilityRecord = {
      jobId: "ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["google.searchDriveFiles"],
      routeId: null,
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {},
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };
    const response = await handleToolGatewayRequest(
      config,
      createStore(googleConnection, runtime, [], null, [], { found: capability }),
      "google.appendToDriveTextFile",
      request(
        "google.appendToDriveTextFile",
        {
          input: {
            jobId: "ai-news-hourly",
            fileId: "file-1",
            text: "Reported item"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      classification: "user_private",
      content: {
        error: "scheduled_job_tool_denied",
        message:
          "Tool google.appendToDriveTextFile is not available to scheduled job ai-news-hourly."
      }
    });
  });

  test("rejects scheduled conformance echo when the capability omits it", async () => {
    const capability: AgentJobCapabilityRecord = {
      jobId: "ai-news-hourly",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["google.searchDriveFiles"],
      routeId: null,
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {},
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], null, [], { found: capability }),
      "runtime.conformance.echo",
      request(
        "runtime.conformance.echo",
        {
          scheduledJob: {
            jobId: "ai-news-hourly"
          },
          input: {
            message: "scheduled provider bridge probe"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      classification: "user_private",
      content: {
        error: "scheduled_job_tool_denied",
        message:
          "Tool runtime.conformance.echo is not available to scheduled job ai-news-hourly."
      }
    });
  });

  test("enforces scheduled job capability from trusted runtime context when input omits job id", async () => {
    const capability: AgentJobCapabilityRecord = {
      jobId: "pr-monitor",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["github.listMyPullRequests"],
      routeId: null,
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {},
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };
    const response = await handleToolGatewayRequest(
      config,
      createStore(googleConnection, runtime, [], null, [], { found: capability }),
      "google.appendToDriveTextFile",
      request(
        "google.appendToDriveTextFile",
        {
          scheduledJob: {
            jobId: "pr-monitor"
          },
          input: {
            fileId: "file-1",
            text: "Reported item"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      classification: "user_private",
      content: {
        error: "scheduled_job_tool_denied",
        message:
          "Tool google.appendToDriveTextFile is not available to scheduled job pr-monitor."
      }
    });
  });

  test("rejects scheduled provider calls with forged inner job ids", async () => {
    const capability: AgentJobCapabilityRecord = {
      jobId: "pr-monitor",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["github.listMyPullRequests"],
      routeId: null,
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {},
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };
    const response = await handleToolGatewayRequest(
      config,
      createStore(googleConnection, runtime, [], null, [], { found: capability }),
      "github.listMyPullRequests",
      request(
        "github.listMyPullRequests",
        {
          scheduledJob: {
            jobId: "pr-monitor"
          },
          input: {
            jobId: "other-job"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      classification: "user_private",
      content: {
        error: "scheduled_job_identity_mismatch",
        message:
          "Scheduled job provider call identity does not match trusted runtime context."
      }
    });
  });

  test("emits observability events for runtime-authenticated provider tools", async () => {
    const observabilityEvents: ObservabilityEventInput[] = [];
    const response = await handleToolGatewayRequest(
      config,
      createStore(connection, runtime),
      "github.getAuthenticatedUser",
      request(
        "github.getAuthenticatedUser",
        {
          user: { email: "person@example.com" }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        observability: {
          emit: (event) => {
            observabilityEvents.push(event);
          }
        },
        getGitHubUser: async (token) => {
          expect(token).toBe("secret-token");
          return { login: "octocat" };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(observabilityEvents.map((event) => event.name)).toEqual([
      "tool.gateway.started",
      "tool.gateway.completed"
    ]);
    expect(observabilityEvents[0]).toMatchObject({
      runtimeId: "rt_u123",
      runtimeType: "openclaw",
      workspaceId: "T123",
      principalId: "T123:U123",
      toolName: "github.getAuthenticatedUser",
      attributes: {
        authKind: "runtime",
        provider: "github",
        hasUserEmail: true
      }
    });
    expect(observabilityEvents[1]).toMatchObject({
      runtimeId: "rt_u123",
      runtimeType: "openclaw",
      workspaceId: "T123",
      principalId: "T123:U123",
      toolName: "github.getAuthenticatedUser",
      classification: "user_private",
      status: "ok",
      attributes: {
        itemCount: null
      }
    });
    expect(JSON.stringify(observabilityEvents)).not.toContain("secret-token");
    expect(JSON.stringify(observabilityEvents)).not.toContain("runtime-token-u123");
  });

  test("lets a runtime send to its active conversation without provider credentials", async () => {
    const runtimeEvents: unknown[] = [];
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, runtimeEvents),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: { text: "Long task finished." },
          conversation: {
            source: "slack",
            workspaceId: "T123",
            channelId: "C123",
            rootId: "channel:C123:thread:1779841118.237",
            isDirectMessage: false
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async (input) => {
          expect(input).toEqual({
            transport: "slack",
            channelId: "C123",
            text: "Long task finished.",
            threadTs: "1779841118.237"
          });
          return {
            transport: "slack",
            channelId: "C123",
            messageId: "1779841120.000"
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        ok: true,
        transport: "slack",
        conversationId: "C123",
        messageId: "1779841120.000"
      }
    });
    expect(runtimeEvents).toEqual([
      {
        runtimeId: "rt_u123",
        eventType: "runtime_tool_called",
        summary: {
          toolName: "conversation.sendMessage",
          classification: "user_private",
          itemCount: null
        }
      }
    ]);
  });

  test("strips Hermes stream cursors from runtime conversation sends", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: {
            text:
              "I found 1 Google Slides file\u2063\n, sorted by most recently touched:\n\n1. [[BURBLE_STREAM_CURSOR]]\nApeLogic Presentation Template"
          },
          conversation: {
            source: "slack",
            workspaceId: "T123",
            channelId: "C123",
            rootId: "channel:C123:thread:1779841118.237",
            isDirectMessage: false
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async (input) => {
          expect(input).toEqual({
            transport: "slack",
            channelId: "C123",
            text:
              "I found 1 Google Slides file, sorted by most recently touched:\n\n1. ApeLogic Presentation Template",
            threadTs: "1779841118.237"
          });
          return {
            transport: "slack",
            channelId: "C123",
            messageId: "1779841120.000"
          };
        }
      }
    );

    expect(response.status).toBe(200);
  });

  test("lets a runtime refresh heartbeat without provider credentials or audit noise", async () => {
    const runtimeEvents: unknown[] = [];
    const touchedRuntimeIds: string[] = [];
    const observabilityEvents: ObservabilityEventInput[] = [];
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, runtimeEvents, null, touchedRuntimeIds),
      "runtime.heartbeat",
      request("runtime.heartbeat", {}, "runtime-token-u123", "rt_u123"),
      {
        observability: {
          emit: (event) => {
            observabilityEvents.push(event);
          }
        }
      }
    );

    expect(response.status).toBe(200);
    expect(touchedRuntimeIds).toEqual(["rt_u123"]);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        ok: true,
        runtimeId: "rt_u123"
      }
    });
    expect(runtimeEvents).toEqual([]);
    expect(observabilityEvents).toHaveLength(1);
    expect(observabilityEvents[0]).toMatchObject({
      name: "runtime.heartbeat",
      runtimeId: "rt_u123",
      runtimeType: "openclaw",
      workspaceId: "T123",
      principalId: "T123:U123",
      status: "ok",
      attributes: {
        authKind: "runtime"
      }
    });
  });

  test("lets a runtime send through a durable conversation route", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_abcdefabcdefabcdefabcdef",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "C123",
        threadTs: "1779841118.237"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: { text: "Cron finished.", routeId: "convrt_abcdefabcdefabcdefabcdef" }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async (input) => {
          expect(input).toEqual({
            transport: "slack",
            channelId: "C123",
            text: "Cron finished.",
            threadTs: "1779841118.237"
          });
          return {
            transport: "slack",
            channelId: "C123",
            messageId: "1779841130.000"
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        ok: true,
        transport: "slack",
        conversationId: "C123",
        routeId: "convrt_abcdefabcdefabcdefabcdef",
        messageId: "1779841130.000"
      }
    });
  });

  test("rejects Slack labels as conversation route ids", async () => {
    const runtimeEvents: unknown[] = [];
    const observabilityEvents: ObservabilityEventInput[] = [];
    const notifications: unknown[] = [];
    let posted = false;
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, runtimeEvents),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          scheduledJob: {
            jobId: "ai-news-hourly"
          },
          input: {
            text: "Cron finished.",
            routeId: "#burble-test",
            jobId: "ai-news-hourly"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async () => {
          posted = true;
          throw new Error("should not post");
        },
        notifyDestinationGrantDeliveryFailure: async (input) => {
          notifications.push(input);
        },
        observability: {
          emit: (event) => {
            observabilityEvents.push(event);
          }
        }
      }
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "Conversation route id must be a resolved convrt_* route id"
    );
    expect(posted).toBe(false);
    expect(runtimeEvents).toEqual([
      {
        runtimeId: "rt_u123",
        eventType: "runtime_tool_failed",
        summary: {
          toolName: "conversation.sendMessage",
          routeId: "#burble-test",
          jobId: "ai-news-hourly",
          error:
            "Conversation route id must be a resolved convrt_* route id. Register scheduled destination labels with scheduledJob.registerCapability and use the returned routeId for delivery.",
          deliveryFailureCode: "invalid_route_id",
          deliveryFailureRetryable: false,
          notificationSent: true
        }
      }
    ]);
    expect(notifications).toEqual([
      expect.objectContaining({
        runtime,
        routeId: "#burble-test",
        jobId: "ai-news-hourly",
        errorCode: "invalid_route_id"
      })
    ]);
    expect(observabilityEvents).toHaveLength(2);
    expect(observabilityEvents[0]).toMatchObject({
      name: "tool.gateway.started",
      toolName: "conversation.sendMessage"
    });
    expect(observabilityEvents[1]).toMatchObject({
      name: "tool.gateway.failed",
      toolName: "conversation.sendMessage",
      status: "error",
      error: {
        code: "invalid_route_id",
        message:
          "Conversation route id must be a resolved convrt_* route id. Register scheduled destination labels with scheduledJob.registerCapability and use the returned routeId for delivery."
      },
      attributes: {
        deliveryFailureCode: "invalid_route_id",
        deliveryFailureRetryable: false
      }
    });
  });

  test("throttles repeated invalid scheduled route notifications", async () => {
    const runtimeEvents: unknown[] = [];
    const notifications: unknown[] = [];
    const store = createStore(null, runtime, runtimeEvents);
    const deps = {
      postActiveConversationMessage: async () => {
        throw new Error("should not post");
      },
      notifyDestinationGrantDeliveryFailure: async (input: unknown) => {
        notifications.push(input);
      }
    };
    const body = {
      scheduledJob: {
        jobId: "ai-news-dedup"
      },
      input: {
        text: "Cron finished.",
        routeId: "#missing-dedup",
        jobId: "ai-news-dedup"
      }
    };

    const first = await handleToolGatewayRequest(
      config,
      store,
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        body,
        "runtime-token-u123",
        "rt_u123"
      ),
      deps
    );
    const second = await handleToolGatewayRequest(
      config,
      store,
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        body,
        "runtime-token-u123",
        "rt_u123"
      ),
      deps
    );

    expect(first.status).toBe(400);
    expect(second.status).toBe(400);
    expect(notifications).toEqual([
      expect.objectContaining({
        routeId: "#missing-dedup",
        jobId: "ai-news-dedup",
        errorCode: "invalid_route_id"
      })
    ]);
    expect(
      runtimeEvents.map((event) => (event as { summary: { notificationSent: boolean } }).summary.notificationSent)
    ).toEqual([true, false]);
  });

  test("repairs scheduled delivery labels through the stored job route", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      kind: "grant",
      grantedBySlackUserId: "U123",
      destinationJson: JSON.stringify({
        channelId: "CENG",
        isDirectMessage: false,
        rootId: "channel:CENG"
      }),
      expiresAt: null,
      bindingJson: JSON.stringify({
        jobId: "daily-standup",
        runtimeId: "rt_u123"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null,
      consecutiveDeliveryFailures: 0,
      lastDeliveryFailureAt: null,
      lastDeliveryFailureCode: null,
      lastDeliveryFailureNotifiedAt: null
    };
    const jobCapability: AgentJobCapabilityRecord = {
      jobId: "daily-standup",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["conversation.sendMessage"],
      routeId: "convrt_1234567890abcdef12345678",
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {
        maxOutputVisibility: "public"
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };

    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], { found: jobCapability }),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          scheduledJob: {
            jobId: "daily-standup"
          },
          input: {
            text: "Daily standup is ready.",
            routeId: "#eng",
            jobId: "daily-standup"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async (input) => {
          expect(input).toEqual({
            transport: "slack",
            channelId: "CENG",
            text: "Daily standup is ready."
          });
          return {
            transport: "slack",
            channelId: "CENG",
            messageId: "1779841140.000"
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      classification: "user_private",
      content: {
        ok: true,
        transport: "slack",
        conversationId: "CENG",
        routeId: "convrt_1234567890abcdef12345678",
        messageId: "1779841140.000"
      }
    });
  });

  test("rejects hallucinated convrt route ids before route lookup", async () => {
    let lookedUp = false;
    const store = createStore(null, runtime);
    const originalGetConversationRoute = store.getConversationRoute;
    store.getConversationRoute = (id) => {
      lookedUp = true;
      return originalGetConversationRoute(id);
    };

    const response = await handleToolGatewayRequest(
      config,
      store,
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: { text: "Cron finished.", routeId: "convrt_burbletest" }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "Conversation route id must be a resolved convrt_* route id"
    );
    expect(lookedUp).toBe(false);
  });

  test("lets a public scheduled job send through a destination grant", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "CENG",
        isDirectMessage: false,
        rootId: "channel:CENG"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: JSON.stringify({
        jobId: "daily-standup",
        runtimeId: "rt_u123"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const jobCapability: AgentJobCapabilityRecord = {
      jobId: "daily-standup",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["conversation.sendMessage"],
      routeId: "convrt_1234567890abcdef12345678",
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {
        maxOutputVisibility: "public"
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };

    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], { found: jobCapability }),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          scheduledJob: {
            jobId: "daily-standup"
          },
          input: {
            text: "Daily standup is ready.",
            routeId: "convrt_1234567890abcdef12345678",
            jobId: "daily-standup"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async (input) => {
          expect(input).toEqual({
            transport: "slack",
            channelId: "CENG",
            text: "Daily standup is ready."
          });
          return {
            transport: "slack",
            channelId: "CENG",
            messageId: "1779841140.000"
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      classification: "user_private",
      content: {
        ok: true,
        transport: "slack",
        conversationId: "CENG",
        routeId: "convrt_1234567890abcdef12345678",
        messageId: "1779841140.000"
      }
    });
  });

  test("lets a bound public scheduled job route send without an explicit job id", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_aaaaaaaaaaaaaaaaaaaaaaaa",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "CENG",
        isDirectMessage: false,
        rootId: "channel:CENG"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: JSON.stringify({
        jobId: "daily-standup",
        runtimeId: "rt_u123"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const jobCapability: AgentJobCapabilityRecord = {
      jobId: "daily-standup",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["conversation.sendMessage"],
      routeId: "convrt_aaaaaaaaaaaaaaaaaaaaaaaa",
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {
        maxOutputVisibility: "public"
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };

    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], { found: jobCapability }),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          scheduledJob: {
            jobId: "daily-standup"
          },
          input: {
            text: "Daily standup is ready.",
            routeId: "convrt_aaaaaaaaaaaaaaaaaaaaaaaa"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async (input) => {
          expect(input).toEqual({
            transport: "slack",
            channelId: "CENG",
            text: "Daily standup is ready."
          });
          return {
            transport: "slack",
            channelId: "CENG",
            messageId: "1779841140.000"
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      classification: "user_private",
      content: {
        ok: true,
        transport: "slack",
        conversationId: "CENG",
        routeId: "convrt_aaaaaaaaaaaaaaaaaaaaaaaa",
        messageId: "1779841140.000"
      }
    });
  });

  test("records and notifies the grant owner when permanent scheduled grant delivery fails", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "CENG",
        isDirectMessage: false,
        rootId: "channel:CENG"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: JSON.stringify({
        jobId: "daily-standup",
        runtimeId: "rt_u123"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const jobCapability: AgentJobCapabilityRecord = {
      jobId: "daily-standup",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["conversation.sendMessage"],
      routeId: "convrt_1234567890abcdef12345678",
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {
        maxOutputVisibility: "public"
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };
    const notifications: unknown[] = [];
    const routeRevocations: unknown[] = [];
    const runtimeEvents: unknown[] = [];
    const observabilityEvents: unknown[] = [];

    const response = await handleToolGatewayRequest(
      config,
      createStore(
        null,
        runtime,
        runtimeEvents,
        route,
        [],
        { found: jobCapability },
        routeRevocations
      ),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          scheduledJob: {
            jobId: "daily-standup"
          },
          input: {
            text: "Daily standup is ready.",
            routeId: "convrt_1234567890abcdef12345678",
            jobId: "daily-standup"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async () => {
          throw new Error("Slack message send failed: not_in_channel");
        },
        notifyDestinationGrantDeliveryFailure: async (input) => {
          notifications.push(input);
        },
        observability: {
          emit: (event) => {
            observabilityEvents.push(event);
          }
        }
      }
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Conversation delivery failed");
    expect(routeRevocations).toEqual([]);
    expect(runtimeEvents).toEqual([
      expect.objectContaining({
        eventType: "runtime_tool_failed",
        runtimeId: "rt_u123",
        summary: expect.objectContaining({
          toolName: "conversation.sendMessage",
          routeId: "convrt_1234567890abcdef12345678",
          routeKind: "grant",
          channelId: "CENG",
          jobId: "daily-standup",
          deliveryFailureCode: "not_in_channel",
          deliveryFailureRetryable: false,
          error: "Slack message send failed: not_in_channel"
        })
      })
    ]);
    expect(notifications).toEqual([
      expect.objectContaining({
        runtime,
        routeId: "convrt_1234567890abcdef12345678",
        jobId: "daily-standup",
        channelId: "CENG",
        errorMessage: "Slack message send failed: not_in_channel",
        errorCode: "not_in_channel"
      })
    ]);
    expect(observabilityEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "tool.gateway.failed",
          status: "error",
          error: expect.objectContaining({
            code: "not_in_channel"
          })
        })
      ])
    );
  });

  test("auto-revokes a grant route after repeated permanent delivery failures", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "CENG",
        isDirectMessage: false,
        rootId: "channel:CENG"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: JSON.stringify({
        jobId: "daily-standup",
        runtimeId: "rt_u123"
      }),
      lastDeliveryFailureAt: "2026-06-02T00:00:00.000Z",
      lastDeliveryFailureCode: "not_in_channel",
      lastDeliveryFailureNotifiedAt: "2026-06-02T00:00:00.000Z",
      consecutiveDeliveryFailures: 2,
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const jobCapability: AgentJobCapabilityRecord = {
      jobId: "daily-standup",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["conversation.sendMessage"],
      routeId: "convrt_1234567890abcdef12345678",
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {
        maxOutputVisibility: "public"
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };
    const notifications: unknown[] = [];
    const routeRevocations: unknown[] = [];
    const runtimeEvents: unknown[] = [];

    const response = await handleToolGatewayRequest(
      config,
      createStore(
        null,
        runtime,
        runtimeEvents,
        route,
        [],
        { found: jobCapability },
        routeRevocations
      ),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: {
            text: "Daily standup is ready.",
            routeId: "convrt_1234567890abcdef12345678",
            jobId: "daily-standup"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async () => {
          throw new Error("Slack message send failed: not_in_channel");
        },
        notifyDestinationGrantDeliveryFailure: async (input) => {
          notifications.push(input);
        }
      }
    );

    expect(response.status).toBe(502);
    expect(routeRevocations).toEqual([
      { routeId: "convrt_1234567890abcdef12345678" }
    ]);
    expect(notifications).toEqual([
      expect.objectContaining({
        routeId: "convrt_1234567890abcdef12345678",
        errorCode: "not_in_channel",
        autoRevoked: true
      })
    ]);
    expect(runtimeEvents).toEqual([
      expect.objectContaining({
        eventType: "runtime_tool_failed",
        summary: expect.objectContaining({
          autoRevoked: true,
          notificationSent: true
        })
      })
    ]);
  });

  test("notifies but does not revoke after repeated retryable delivery failures", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "CENG",
        isDirectMessage: false,
        rootId: "channel:CENG"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: JSON.stringify({
        jobId: "daily-standup",
        runtimeId: "rt_u123"
      }),
      lastDeliveryFailureAt: "2026-06-02T00:00:00.000Z",
      lastDeliveryFailureCode: "ratelimited",
      lastDeliveryFailureNotifiedAt: null,
      consecutiveDeliveryFailures: 2,
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const jobCapability: AgentJobCapabilityRecord = {
      jobId: "daily-standup",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["conversation.sendMessage"],
      routeId: "convrt_1234567890abcdef12345678",
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {
        maxOutputVisibility: "public"
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };
    const notifications: unknown[] = [];
    const routeRevocations: unknown[] = [];

    const response = await handleToolGatewayRequest(
      config,
      createStore(
        null,
        runtime,
        [],
        route,
        [],
        { found: jobCapability },
        routeRevocations
      ),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: {
            text: "Daily standup is ready.",
            routeId: "convrt_1234567890abcdef12345678",
            jobId: "daily-standup"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async () => {
          throw new Error("Slack message send failed: ratelimited");
        },
        notifyDestinationGrantDeliveryFailure: async (input) => {
          notifications.push(input);
        }
      }
    );

    expect(response.status).toBe(502);
    expect(routeRevocations).toEqual([]);
    expect(notifications).toEqual([
      expect.objectContaining({
        routeId: "convrt_1234567890abcdef12345678",
        errorCode: "ratelimited"
      })
    ]);
  });

  test("notifies the grant owner for unlisted non-retryable Slack failures", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "CENG",
        isDirectMessage: false,
        rootId: "channel:CENG"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: JSON.stringify({
        jobId: "daily-standup",
        runtimeId: "rt_u123"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const jobCapability: AgentJobCapabilityRecord = {
      jobId: "daily-standup",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["conversation.sendMessage"],
      routeId: "convrt_1234567890abcdef12345678",
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {
        maxOutputVisibility: "public"
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };
    const notifications: unknown[] = [];
    const routeRevocations: unknown[] = [];

    const response = await handleToolGatewayRequest(
      config,
      createStore(
        null,
        runtime,
        [],
        route,
        [],
        { found: jobCapability },
        routeRevocations
      ),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: {
            text: "Daily standup is ready.",
            routeId: "convrt_1234567890abcdef12345678",
            jobId: "daily-standup"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async () => {
          throw new Error("Slack message send failed: restricted_action");
        },
        notifyDestinationGrantDeliveryFailure: async (input) => {
          notifications.push(input);
        }
      }
    );

    expect(response.status).toBe(502);
    expect(routeRevocations).toEqual([]);
    expect(notifications).toEqual([
      expect.objectContaining({
        errorCode: "restricted_action",
        errorMessage: "Slack message send failed: restricted_action"
      })
    ]);
  });

  test("suppresses repeat grant delivery failure notifications", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "CENG",
        isDirectMessage: false,
        rootId: "channel:CENG"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: JSON.stringify({
        jobId: "daily-standup",
        runtimeId: "rt_u123"
      }),
      lastDeliveryFailureAt: "2026-06-02T00:00:00.000Z",
      lastDeliveryFailureCode: "not_in_channel",
      lastDeliveryFailureNotifiedAt: "2026-06-02T00:00:00.000Z",
      consecutiveDeliveryFailures: 1,
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const jobCapability: AgentJobCapabilityRecord = {
      jobId: "daily-standup",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["conversation.sendMessage"],
      routeId: "convrt_1234567890abcdef12345678",
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {
        maxOutputVisibility: "public"
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };
    const notifications: unknown[] = [];

    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], {
        found: jobCapability
      }),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: {
            text: "Daily standup is ready.",
            routeId: "convrt_1234567890abcdef12345678",
            jobId: "daily-standup"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async () => {
          throw new Error("Slack message send failed: not_in_channel");
        },
        notifyDestinationGrantDeliveryFailure: async (input) => {
          notifications.push(input);
        }
      }
    );

    expect(response.status).toBe(502);
    expect(notifications).toEqual([]);
  });

  test("does not revoke or notify for Slack rate-limit delivery failures", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "CENG",
        isDirectMessage: false,
        rootId: "channel:CENG"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: JSON.stringify({
        jobId: "daily-standup",
        runtimeId: "rt_u123"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const jobCapability: AgentJobCapabilityRecord = {
      jobId: "daily-standup",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["conversation.sendMessage"],
      routeId: "convrt_1234567890abcdef12345678",
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {
        maxOutputVisibility: "public"
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };
    const notifications: unknown[] = [];
    const routeRevocations: unknown[] = [];

    const response = await handleToolGatewayRequest(
      config,
      createStore(
        null,
        runtime,
        [],
        route,
        [],
        { found: jobCapability },
        routeRevocations
      ),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: {
            text: "Daily standup is ready.",
            routeId: "convrt_1234567890abcdef12345678",
            jobId: "daily-standup"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async () => {
          throw new Error("Slack message send failed: ratelimited");
        },
        notifyDestinationGrantDeliveryFailure: async (input) => {
          notifications.push(input);
        }
      }
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Conversation delivery failed");
    expect(notifications).toEqual([]);
  });

  test("treats unknown Slack delivery failures as non-retryable", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "CENG",
        isDirectMessage: false,
        rootId: "channel:CENG"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: JSON.stringify({
        jobId: "daily-standup",
        runtimeId: "rt_u123"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const jobCapability: AgentJobCapabilityRecord = {
      jobId: "daily-standup",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["conversation.sendMessage"],
      routeId: "convrt_1234567890abcdef12345678",
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {
        maxOutputVisibility: "public"
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };
    const notifications: unknown[] = [];

    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], { found: jobCapability }),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          scheduledJob: {
            jobId: "daily-standup"
          },
          input: {
            text: "Daily standup is ready.",
            routeId: "convrt_1234567890abcdef12345678",
            jobId: "daily-standup"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async () => {
          throw new Error("Slack message send failed: weird_new_slack_code");
        },
        notifyDestinationGrantDeliveryFailure: async (input) => {
          notifications.push(input);
        }
      }
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Conversation delivery failed");
    expect(notifications).toEqual([
      expect.objectContaining({
        routeId: "convrt_1234567890abcdef12345678",
        jobId: "daily-standup",
        errorCode: "weird_new_slack_code"
      })
    ]);
  });

  test("returns the delivery failure response when bookkeeping throws", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "CENG",
        isDirectMessage: false,
        rootId: "channel:CENG"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: JSON.stringify({
        jobId: "daily-standup",
        runtimeId: "rt_u123"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const jobCapability: AgentJobCapabilityRecord = {
      jobId: "daily-standup",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["conversation.sendMessage"],
      routeId: "convrt_1234567890abcdef12345678",
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {
        maxOutputVisibility: "public"
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };
    const store = createStore(null, runtime, [], route, [], {
      found: jobCapability
    });
    store.recordConversationRouteDeliveryFailure = () => {
      throw new Error("db locked");
    };
    store.recordAgentRuntimeEvent = () => {
      throw new Error("event db locked");
    };

    const response = await handleToolGatewayRequest(
      config,
      store,
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: {
            text: "Daily standup is ready.",
            routeId: "convrt_1234567890abcdef12345678",
            jobId: "daily-standup"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async () => {
          throw new Error("Slack message send failed: not_in_channel");
        },
        notifyDestinationGrantDeliveryFailure: async () => undefined,
        observability: {
          emit: () => {
            throw new Error("disk full");
          }
        }
      }
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Conversation delivery failed");
  });

  test("uses Slack DM fallback notification when grant delivery fails", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "CENG",
        isDirectMessage: false,
        rootId: "channel:CENG"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: JSON.stringify({
        jobId: "daily-standup",
        runtimeId: "rt_u123"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const jobCapability: AgentJobCapabilityRecord = {
      jobId: "daily-standup",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["conversation.sendMessage"],
      routeId: "convrt_1234567890abcdef12345678",
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {
        maxOutputVisibility: "public"
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
      });
      return new Response(
        JSON.stringify(
          calls.length === 1
            ? { ok: false, error: "not_in_channel" }
            : { ok: true, channel: "U123", ts: "1779841150.000" }
        ),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;
    try {
      const response = await handleToolGatewayRequest(
        config,
        createStore(null, runtime, [], route, [], { found: jobCapability }),
        "conversation.sendMessage",
        request(
          "conversation.sendMessage",
          {
            input: {
              text: "Daily standup is ready.",
              routeId: "convrt_1234567890abcdef12345678",
              jobId: "daily-standup"
            }
          },
          "runtime-token-u123",
          "rt_u123"
        )
      );

      expect(response.status).toBe(502);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        url: "https://slack.com/api/chat.postMessage",
        body: {
          channel: "CENG",
          text: "Daily standup is ready."
        }
      });
      expect(calls[1]).toMatchObject({
        url: "https://slack.com/api/chat.postMessage",
        body: {
          channel: "U123"
        }
      });
      expect(String(calls[1].body.text)).toContain(
        "could not post scheduled job output to <#CENG>"
      );
      expect(String(calls[1].body.text)).toContain("not_in_channel");
      expect(String(calls[1].body.text)).toContain(
        "The destination grant is still active"
      );
      expect(String(calls[1].body.text)).not.toContain(
        "revoke the destination grant with `/agent ungrant here`"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects private scheduled job output through a destination grant", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "CENG",
        isDirectMessage: false,
        rootId: "channel:CENG"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: JSON.stringify({
        jobId: "private-digest",
        runtimeId: "rt_u123"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const jobCapability: AgentJobCapabilityRecord = {
      jobId: "private-digest",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["conversation.sendMessage"],
      routeId: "convrt_1234567890abcdef12345678",
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {
        maxOutputVisibility: "user_private"
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };

    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], { found: jobCapability }),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: {
            text: "Private digest.",
            routeId: "convrt_1234567890abcdef12345678",
            jobId: "private-digest",
            visibilityPolicy: {
              maxOutputVisibility: "public"
            }
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async () => {
          throw new Error("private scheduled output should not be posted");
        }
      }
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain(
      "Destination grant requires public scheduled output visibility"
    );
  });

  test("rejects authenticated provider read-source scheduled output through a destination grant at send time", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "CENG",
        isDirectMessage: false,
        rootId: "channel:CENG"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: JSON.stringify({
        jobId: "github-digest",
        runtimeId: "rt_u123"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const jobCapability: AgentJobCapabilityRecord = {
      jobId: "github-digest",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["github_search_issues", "conversation.sendMessage"],
      routeId: "convrt_1234567890abcdef12345678",
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {
        maxOutputVisibility: "public"
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };

    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], { found: jobCapability }),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: {
            text: "Private digest.",
            routeId: "convrt_1234567890abcdef12345678",
            jobId: "github-digest"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async () => {
          throw new Error("private scheduled output should not be posted");
        }
      }
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain(
      "Public Slack channel destination grants cannot be used for scheduled jobs that read from authenticated Burble provider sources"
    );
  });

  test("allows authenticated provider read-source scheduled output through a private channel grant", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "GENG",
        isDirectMessage: false,
        isPrivateChannel: true,
        rootId: "channel:GENG"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: JSON.stringify({
        jobId: "github-digest",
        runtimeId: "rt_u123"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const jobCapability: AgentJobCapabilityRecord = {
      jobId: "github-digest",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["github_search_issues", "conversation.sendMessage"],
      routeId: "convrt_1234567890abcdef12345678",
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {
        maxOutputVisibility: "user_private"
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };
    const posts: unknown[] = [];

    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], { found: jobCapability }),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: {
            text: "Private digest.",
            routeId: "convrt_1234567890abcdef12345678",
            jobId: "github-digest"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async (input) => {
          posts.push(input);
          return { transport: "slack", channelId: input.channelId };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(posts).toMatchObject([
      {
        channelId: "GENG",
        text: "Private digest."
      }
    ]);
  });

  test("does not trust input job id for destination grant visibility", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "CENG",
        isDirectMessage: false,
        rootId: "channel:CENG"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: null,
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const throwawayCapability: AgentJobCapabilityRecord = {
      jobId: "throwaway-public",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["conversation.sendMessage"],
      routeId: "convrt_1234567890abcdef12345678",
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {
        maxOutputVisibility: "public"
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };

    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], { found: throwawayCapability }),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: {
            text: "Private digest.",
            routeId: "convrt_1234567890abcdef12345678",
            jobId: "throwaway-public"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async () => {
          throw new Error("untrusted input job id should not authorize delivery");
        }
      }
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain(
      "Destination grant requires public scheduled output visibility"
    );
  });

  test("rejects conversation sends with forged inner scheduled job ids", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          scheduledJob: {
            jobId: "trusted-job"
          },
          input: {
            text: "Private digest.",
            routeId: "convrt_1234567890abcdef12345678",
            jobId: "forged-job"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain(
      "Scheduled job provider call identity does not match trusted runtime context"
    );
  });

  test("allows scheduled public output through a destination grant when provider tools are write-only", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "CENG",
        isDirectMessage: false,
        rootId: "channel:CENG"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: JSON.stringify({
        jobId: "public-news-dedupe",
        runtimeId: "rt_u123"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const jobCapability: AgentJobCapabilityRecord = {
      jobId: "public-news-dedupe",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: [
        "conversation.sendMessage",
        "google_update_drive_text_file"
      ],
      routeId: "convrt_1234567890abcdef12345678",
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {
        maxOutputVisibility: "public"
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };
    const posts: unknown[] = [];

    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], { found: jobCapability }),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: {
            text: "Public news digest.",
            routeId: "convrt_1234567890abcdef12345678",
            jobId: "public-news-dedupe"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async (input) => {
          posts.push(input);
          return {
            transport: "slack",
            channelId: input.channelId,
            messageId: "1710000000.000100"
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      content: {
        ok: true,
        conversationId: "CENG",
        messageId: "1710000000.000100"
      }
    });
    expect(posts).toMatchObject([
      {
        channelId: "CENG",
        text: "Public news digest."
      }
    ]);
  });

  test("does not infer scheduled public visibility for route-only destination grant delivery", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "CENG",
        isDirectMessage: false,
        rootId: "channel:CENG"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: null,
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const jobCapability: AgentJobCapabilityRecord = {
      jobId: "public-news-dedupe",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: [
        "conversation.sendMessage",
        "google_update_drive_text_file"
      ],
      routeId: "convrt_1234567890abcdef12345678",
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {
        maxOutputVisibility: "public"
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], { list: [jobCapability] }),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: {
            text: "Public news digest.",
            routeId: "convrt_1234567890abcdef12345678"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async () => {
          throw new Error("route-only scheduled grant delivery should not be posted");
        }
      }
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain(
      "Destination grant requires public scheduled output visibility"
    );
  });

  test("does not infer scheduled capability for ambiguous route-only destination grant delivery", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_1234567890abcdef12345678",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "CENG",
        isDirectMessage: false,
        rootId: "channel:CENG"
      }),
      kind: "grant",
      grantedBySlackUserId: "U123",
      expiresAt: null,
      bindingJson: null,
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const baseCapability: AgentJobCapabilityRecord = {
      jobId: "public-news-dedupe",
      workspaceId: "T123",
      slackUserId: "U123",
      requiredTools: ["conversation.sendMessage"],
      routeId: "convrt_1234567890abcdef12345678",
      policyHash: "policy-hash",
      capabilityProfile: "scheduled_job",
      runtimeType: "openclaw",
      stateRefs: [],
      visibilityPolicy: {
        maxOutputVisibility: "public"
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z"
    };

    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route, [], {
        list: [
          baseCapability,
          { ...baseCapability, jobId: "second-public-news-dedupe" }
        ]
      }),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: {
            text: "Public news digest.",
            routeId: "convrt_1234567890abcdef12345678"
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async () => {
          throw new Error("ambiguous route-only delivery should not be posted");
        }
      }
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain(
      "Destination grant requires public scheduled output visibility"
    );
  });

  test("rejects invisible-only conversation messages", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_abcdefabcdefabcdefabcdef",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "C123"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: { text: "\u200B", routeId: "convrt_abcdefabcdefabcdefabcdef" }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async () => {
          throw new Error("invisible-only text should not be posted");
        }
      }
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid tool input");
  });

  test("passes outbound conversation attachment metadata through durable routes", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_abcdefabcdefabcdefabcdef",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "C123",
        threadTs: "1779841118.237"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: {
            text: "Cron finished.",
            routeId: "convrt_abcdefabcdefabcdefabcdef",
            attachments: [
              {
                id: "agent:report-1",
                source: "agent",
                kind: "file",
                mimeType: "text/plain",
                name: "report.txt",
                sizeBytes: 12
              }
            ]
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async (input) => {
          expect(input).toEqual({
            transport: "slack",
            channelId: "C123",
            text: "Cron finished.",
            threadTs: "1779841118.237",
            attachments: [
              {
                id: "agent:report-1",
                source: "agent",
                kind: "file",
                mimeType: "text/plain",
                name: "report.txt",
                sizeBytes: 12
              }
            ]
          });
          return {
            transport: "slack",
            channelId: "C123",
            messageId: "1779841130.000"
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      classification: "user_private",
      content: {
        ok: true,
        transport: "slack",
        conversationId: "C123",
        routeId: "convrt_abcdefabcdefabcdefabcdef",
        messageId: "1779841130.000"
      }
    });
  });

  test("allows attachment-only outbound conversation messages", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_abcdefabcdefabcdefabcdef",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "C123"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: {
            text: "",
            routeId: "convrt_abcdefabcdefabcdefabcdef",
            attachments: [
              {
                id: "agent:image-1",
                source: "agent",
                kind: "image",
                mimeType: "image/png",
                name: "preview.png"
              }
            ]
          }
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        postActiveConversationMessage: async (input) => {
          expect(input.text).toBe("");
          expect(input.attachments).toEqual([
            {
              id: "agent:image-1",
              source: "agent",
              kind: "image",
              mimeType: "image/png",
              name: "preview.png"
            }
          ]);
          return {
            transport: "slack",
            channelId: "C123",
            messageId: "1779841130.000"
          };
        }
      }
    );

    expect(response.status).toBe(200);
  });

  test("lets a runtime fetch a current-turn Slack attachment", async () => {
    const attachmentId = createConversationAttachmentCapability(config, {
      runtimeId: "rt_u123",
      runId: "run_123",
      source: "slack",
      externalId: "F123",
      expiresAtMs: Date.now() + 60_000
    });
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime),
      "conversation.getAttachment",
      request(
        "conversation.getAttachment",
        {
          runId: "run_123",
          input: { attachmentId },
          attachments: [
            {
              id: attachmentId,
              source: "slack",
              kind: "file",
              mimeType: "text/plain",
              name: "notes.txt",
              sizeBytes: 12
            }
          ]
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        fetchConversationAttachment: async (input) => {
          expect(input).toEqual({
            maxBytes: 5 * 1024 * 1024,
            attachment: {
              id: attachmentId,
              externalId: "F123",
              source: "slack",
              kind: "file",
              mimeType: "text/plain",
              name: "notes.txt",
              sizeBytes: 12
            }
          });
          return {
            attachment: input.attachment,
            contentBase64: Buffer.from("hello world").toString("base64"),
            text: "hello world"
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      classification: "user_private",
      content: {
        attachment: {
          id: attachmentId,
          externalId: "F123",
          source: "slack",
          kind: "file",
          mimeType: "text/plain",
          name: "notes.txt",
          sizeBytes: 12
        },
        contentBase64: "aGVsbG8gd29ybGQ=",
        text: "hello world"
      }
    });
  });

  test("ignores runtime-supplied attachment external ids", async () => {
    const attachmentId = createConversationAttachmentCapability(config, {
      runtimeId: "rt_u123",
      runId: "run_123",
      source: "slack",
      externalId: "F123",
      expiresAtMs: Date.now() + 60_000
    });
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime),
      "conversation.getAttachment",
      request(
        "conversation.getAttachment",
        {
          runId: "run_123",
          input: { attachmentId },
          attachments: [
            {
              id: attachmentId,
              externalId: "F999",
              source: "slack",
              kind: "file",
              mimeType: "text/plain"
            }
          ]
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        fetchConversationAttachment: async (input) => {
          expect(input.attachment.externalId).toBe("F123");
          return {
            attachment: input.attachment,
            contentBase64: Buffer.from("hello").toString("base64")
          };
        }
      }
    );

    expect(response.status).toBe(200);
  });

  test("rejects attachment capabilities bound to another runtime", async () => {
    const attachmentId = createConversationAttachmentCapability(config, {
      runtimeId: "rt_other",
      runId: "run_123",
      source: "slack",
      externalId: "F123",
      expiresAtMs: Date.now() + 60_000
    });
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime),
      "conversation.getAttachment",
      request(
        "conversation.getAttachment",
        {
          runId: "run_123",
          input: { attachmentId },
          attachments: [
            {
              id: attachmentId,
              source: "slack",
              kind: "file",
              mimeType: "text/plain"
            }
          ]
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        fetchConversationAttachment: async () => {
          throw new Error("unexpected attachment fetch");
        }
      }
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Attachment not available for this run");
  });

  test("rejects attachment capabilities bound to another run", async () => {
    const attachmentId = createConversationAttachmentCapability(config, {
      runtimeId: "rt_u123",
      runId: "run_other",
      source: "slack",
      externalId: "F123",
      expiresAtMs: Date.now() + 60_000
    });
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime),
      "conversation.getAttachment",
      request(
        "conversation.getAttachment",
        {
          runId: "run_123",
          input: { attachmentId },
          attachments: [
            {
              id: attachmentId,
              source: "slack",
              kind: "file",
              mimeType: "text/plain"
            }
          ]
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        fetchConversationAttachment: async () => {
          throw new Error("unexpected attachment fetch");
        }
      }
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Attachment not available for this run");
  });

  test("rejects expired attachment capabilities", async () => {
    const attachmentId = createConversationAttachmentCapability(config, {
      runtimeId: "rt_u123",
      runId: "run_123",
      source: "slack",
      externalId: "F123",
      expiresAtMs: Date.now() - 1
    });
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime),
      "conversation.getAttachment",
      request(
        "conversation.getAttachment",
        {
          runId: "run_123",
          input: { attachmentId },
          attachments: [
            {
              id: attachmentId,
              source: "slack",
              kind: "file",
              mimeType: "text/plain"
            }
          ]
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        fetchConversationAttachment: async () => {
          throw new Error("unexpected attachment fetch");
        }
      }
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Attachment not available for this run");
  });

  test("rejects tampered attachment capability signatures", async () => {
    const attachmentId = createConversationAttachmentCapability(config, {
      runtimeId: "rt_u123",
      runId: "run_123",
      source: "slack",
      externalId: "F123",
      expiresAtMs: Date.now() + 60_000
    });
    const tamperedAttachmentId = `${attachmentId.slice(0, -1)}${
      attachmentId.endsWith("a") ? "b" : "a"
    }`;
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime),
      "conversation.getAttachment",
      request(
        "conversation.getAttachment",
        {
          runId: "run_123",
          input: { attachmentId: tamperedAttachmentId },
          attachments: [
            {
              id: tamperedAttachmentId,
              source: "slack",
              kind: "file",
              mimeType: "text/plain"
            }
          ]
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        fetchConversationAttachment: async () => {
          throw new Error("unexpected attachment fetch");
        }
      }
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Attachment not available for this run");
  });

  test("rejects unsigned runtime attachment ids", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime),
      "conversation.getAttachment",
      request(
        "conversation.getAttachment",
        {
          input: { attachmentId: "slack:F123" },
          attachments: [
            {
              id: "slack:F123",
              externalId: "F123",
              source: "slack",
              kind: "file",
              mimeType: "text/plain"
            }
          ]
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        fetchConversationAttachment: async () => {
          throw new Error("unexpected attachment fetch");
        }
      }
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Attachment not available for this run");
  });

  test("rejects attachment fetches outside the current turn", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime),
      "conversation.getAttachment",
      request(
        "conversation.getAttachment",
        {
          input: { attachmentId: "slack:F999" },
          attachments: [
            {
              id: "slack:F123",
              externalId: "F123",
              source: "slack",
              kind: "file",
              mimeType: "text/plain"
            }
          ]
        },
        "runtime-token-u123",
        "rt_u123"
      ),
      {
        fetchConversationAttachment: async () => {
          throw new Error("unexpected attachment fetch");
        }
      }
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Attachment not available for this run");
  });

  test("rejects durable conversation routes bound to another runtime", async () => {
    const route: ConversationRouteRecord = {
      id: "convrt_abcdefabcdefabcdefabcdef",
      workspaceId: "T123",
      slackUserId: "U123",
      transport: "slack",
      destinationJson: JSON.stringify({
        channelId: "C123",
        runtimeId: "rt_other"
      }),
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      revokedAt: null
    };
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime, [], route),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: { text: "Cron finished.", routeId: "convrt_abcdefabcdefabcdefabcdef" }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Runtime route mismatch");
  });

  test("rejects active conversation sends for another workspace", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(null, runtime),
      "conversation.sendMessage",
      request(
        "conversation.sendMessage",
        {
          input: { text: "hello" },
          conversation: {
            source: "slack",
            workspaceId: "T999",
            channelId: "C123",
            rootId: "channel:C123:thread:1779841118.237",
            isDirectMessage: false
          }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Runtime principal mismatch");
  });

  test("rejects runtime tokens for another user's connected account", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore({ ...connection, slackUserId: "U456" }, runtime),
      "github.getAuthenticatedUser",
      request(
        "github.getAuthenticatedUser",
        {
          user: { email: "person@example.com" }
        },
        "runtime-token-u123",
        "rt_u123"
      )
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Runtime principal mismatch");
  });

  test("rejects invalid runtime tokens", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(connection, runtime),
      "github.getAuthenticatedUser",
      request(
        "github.getAuthenticatedUser",
        {
          user: { email: "person@example.com" }
        },
        "wrong-runtime-token",
        "rt_u123"
      )
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
  });

  test("returns a private connect instruction when the user is not connected", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(null),
      "github.getAuthenticatedUser",
      request("github.getAuthenticatedUser", {
        user: { email: "person@example.com" }
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        error: "github_not_connected",
        message: "Connect GitHub first: `@Burble connect github`."
      }
    });
  });

  test("executes an allowlisted Jira tool with the stored caller token", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(jiraConnection),
      "jira.searchIssues",
      request("jira.searchIssues", {
        user: { email: "person@example.com" },
        input: { jql: "assignee = currentUser() AND status != Done" }
      }),
      {
        searchJiraIssues: async (token, jql) => {
          expect(token).toBe("jira-token");
          expect(jql).toBe("assignee = currentUser() AND status != Done");
          return [
            {
              key: "ENG-123",
              summary: "Fix deploy dashboard",
              url: "https://example.atlassian.net/browse/ENG-123"
            }
          ];
        }
      }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      classification: "user_private",
      content: [
        {
          key: "ENG-123",
          title: "Fix deploy dashboard",
          url: "https://example.atlassian.net/browse/ENG-123"
        }
      ]
    });
    expect(JSON.stringify(body)).not.toContain("jira-token");
  });

  test("executes Jira accessible resource lookup through the HTTP fallback gateway", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(jiraConnection),
      "jira.listAccessibleResources",
      request("jira.listAccessibleResources", {
        user: { email: "person@example.com" }
      }),
      {
        listJiraAccessibleResources: async (token) => {
          expect(token).toBe("jira-token");
          return [
            {
              id: "cloud-123",
              name: "Example Jira Site",
              url: "https://example.atlassian.net",
              scopes: ["read:jira-work", "write:jira-work"]
            }
          ];
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: [
        {
          id: "cloud-123",
          name: "Example Jira Site",
          url: "https://example.atlassian.net"
        }
      ]
    });
  });

  test("executes Jira visible project lookup through the HTTP fallback gateway", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(jiraConnection),
      "jira.listVisibleProjects",
      request("jira.listVisibleProjects", {
        user: { email: "person@example.com" },
        input: { query: "DM", action: "create", expandIssueTypes: true }
      }),
      {
        listVisibleJiraProjects: async (token, input) => {
          expect(token).toBe("jira-token");
          expect(input).toEqual({
            query: "DM",
            action: "create",
            expandIssueTypes: true
          });
          return [
            {
              id: "10000",
              key: "DM",
              name: "DM Workspace",
              url: "https://example.atlassian.net/jira/projects/DM",
              issueTypes: [{ id: "10001", name: "Task", subtask: false }]
            }
          ];
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: [
        {
          id: "10000",
          key: "DM",
          name: "DM Workspace",
          url: "https://example.atlassian.net/jira/projects/DM",
          issueTypes: [{ id: "10001", name: "Task", subtask: false }]
        }
      ]
    });
  });

  test("executes Jira REST write helpers through the HTTP fallback gateway", async () => {
    const createResponse = await handleToolGatewayRequest(
      config,
      createStore(jiraConnection),
      "jira.createIssue",
      request("jira.createIssue", {
        user: { email: "person@example.com" },
        input: {
          projectKey: "DM",
          issueTypeName: "Task",
          summary: "test ticket from slack",
          assigneeAccountId: "acct-example"
        }
      }),
      {
        createJiraIssue: async (token, input) => {
          expect(token).toBe("jira-token");
          expect(input).toEqual({
            projectKey: "DM",
            issueTypeName: "Task",
            summary: "test ticket from slack",
            assigneeAccountId: "acct-example"
          });
          return {
            key: "DM-100",
            summary: input.summary,
            url: "https://example.atlassian.net/browse/DM-100"
          };
        }
      }
    );

    expect(createResponse.status).toBe(200);
    expect(await createResponse.json()).toEqual({
      classification: "user_private",
      content: {
        key: "DM-100",
        title: "test ticket from slack",
        url: "https://example.atlassian.net/browse/DM-100"
      }
    });

    const editResponse = await handleToolGatewayRequest(
      config,
      createStore(jiraConnection),
      "jira.editIssue",
      request("jira.editIssue", {
        user: { email: "person@example.com" },
        input: {
          issueKey: "DM-100",
          summary: "updated title",
          assigneeAccountId: null
        }
      }),
      {
        editJiraIssue: async (token, input) => {
          expect(token).toBe("jira-token");
          expect(input).toEqual({
            issueKey: "DM-100",
            summary: "updated title",
            assigneeAccountId: null
          });
          return {
            key: "DM-100",
            summary: "updated title",
            url: "https://example.atlassian.net/browse/DM-100"
          };
        }
      }
    );

    expect(editResponse.status).toBe(200);
    expect(await editResponse.json()).toEqual({
      classification: "user_private",
      content: {
        key: "DM-100",
        title: "updated title",
        url: "https://example.atlassian.net/browse/DM-100"
      }
    });
  });

  test("executes newer Jira comment helper through the HTTP fallback gateway", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(jiraConnection),
      "jira.addComment",
      request("jira.addComment", {
        user: { email: "person@example.com" },
        input: {
          issueKey: "DM-100",
          body: "Looks good from Burble."
        }
      }),
      {
        addJiraIssueComment: async (token, input) => {
          expect(token).toBe("jira-token");
          expect(input).toEqual({
            issueKey: "DM-100",
            body: "Looks good from Burble."
          });
          return {
            id: "comment-1",
            url: "https://example.atlassian.net/browse/DM-100?focusedCommentId=comment-1"
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        id: "comment-1",
        url: "https://example.atlassian.net/browse/DM-100?focusedCommentId=comment-1"
      }
    });
  });

  test("executes Google Drive update and Gmail draft tools through the HTTP fallback gateway", async () => {
    const driveResponse = await handleToolGatewayRequest(
      config,
      createStore(googleConnection),
      "google.updateDriveTextFile",
      request("google.updateDriveTextFile", {
        user: { email: "person@example.com" },
        input: {
          fileId: "file-123",
          text: "updated body",
          mimeType: "text/plain"
        }
      }),
      {
        updateGoogleDriveTextFile: async (token, input) => {
          expect(token).toBe("google-token");
          expect(input).toEqual({
            fileId: "file-123",
            text: "updated body",
            mimeType: "text/plain"
          });
          return {
            id: "file-123",
            name: "Notes",
            mimeType: "text/plain",
            webViewLink: "https://drive.google.com/file/d/file-123/view"
          };
        }
      }
    );

    expect(driveResponse.status).toBe(200);
    expect(await driveResponse.json()).toEqual({
      classification: "user_private",
      content: {
        id: "file-123",
        name: "Notes",
        mimeType: "text/plain",
        webViewLink: "https://drive.google.com/file/d/file-123/view"
      }
    });

    const draftResponse = await handleToolGatewayRequest(
      config,
      createStore(googleConnection),
      "gmail.createDraft",
      request("gmail.createDraft", {
        user: { email: "person@example.com" },
        input: {
          to: ["teammate@example.com"],
          subject: "Draft",
          body: "Hello"
        }
      }),
      {
        createGmailDraft: async (token, input) => {
          expect(token).toBe("google-token");
          expect(input).toEqual({
            to: ["teammate@example.com"],
            subject: "Draft",
            body: "Hello"
          });
          return {
            id: "draft-123",
            messageId: "message-123"
          };
        }
      }
    );

    expect(draftResponse.status).toBe(200);
    expect(await draftResponse.json()).toEqual({
      classification: "user_private",
      content: {
        id: "draft-123",
        messageId: "message-123"
      }
    });
  });

  test("executes Atlassian MCP tool discovery through the HTTP fallback gateway", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(jiraConnection),
      "atlassian.listMcpTools",
      request("atlassian.listMcpTools", {
        user: { email: "person@example.com" }
      }),
      {
        listAtlassianMcpTools: async ({ url, accessToken }) => {
          expect(url).toBe("https://mcp.atlassian.com/v1/mcp");
          expect(accessToken).toBe("jira-token");
          return [
            {
              name: "searchJiraIssuesUsingJql",
              description: "Search Jira issues using JQL",
              inputSchema: {
                type: "object",
                properties: {
                  jql: { type: "string" }
                },
                required: ["jql"]
              }
            },
            {
              name: "deleteConfluencePage",
              description: "Delete a Confluence page"
            }
          ];
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: [
        {
          name: "searchJiraIssuesUsingJql",
          description: "Search Jira issues using JQL",
          inputSchema: {
            type: "object",
            properties: {
              jql: { type: "string" }
            },
            required: ["jql"]
          }
        }
      ]
    });
  });

  test("executes allowed Atlassian MCP calls through the HTTP fallback gateway", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(jiraConnection),
      "atlassian.callMcpTool",
      request("atlassian.callMcpTool", {
        user: { email: "person@example.com" },
        input: {
          name: "searchJiraIssuesUsingJql",
          arguments: {
            jql: 'text ~ "onboarding"'
          }
        }
      }),
      {
        callAtlassianMcpTool: async ({ url, accessToken, name, arguments: args }) => {
          expect(url).toBe("https://mcp.atlassian.com/v1/mcp");
          expect(accessToken).toBe("jira-token");
          expect(name).toBe("searchJiraIssuesUsingJql");
          expect(args).toEqual({
            jql: 'text ~ "onboarding"'
          });
          return {
            content: [
              {
                type: "text",
                text: "ECS-313 onboarding crash loop"
              }
            ]
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        toolName: "searchJiraIssuesUsingJql",
        result: {
          content: [
            {
              type: "text",
              text: "ECS-313 onboarding crash loop"
            }
          ]
        }
      }
    });
  });

  test("executes allowlisted Jira write MCP calls through the HTTP fallback gateway", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(jiraConnection),
      "atlassian.callMcpTool",
      request("atlassian.callMcpTool", {
        user: { email: "person@example.com" },
        input: {
          name: "createJiraIssue",
          arguments: {
            projectKey: "ENG",
            issueType: "Task",
            summary: "Follow up on deploy dashboard"
          }
        }
      }),
      {
        callAtlassianMcpTool: async ({ accessToken, name, arguments: args }) => {
          expect(accessToken).toBe("jira-token");
          expect(name).toBe("createJiraIssue");
          expect(args).toEqual({
            projectKey: "ENG",
            issueType: "Task",
            summary: "Follow up on deploy dashboard"
          });
          return {
            content: [
              {
                type: "text",
                text: "Created ENG-124"
              }
            ]
          };
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        toolName: "createJiraIssue",
        result: {
          content: [
            {
              type: "text",
              text: "Created ENG-124"
            }
          ]
        }
      }
    });
  });

  test("classifies opaque Atlassian MCP errors as expired Jira auth when REST auth check fails", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(jiraConnection),
      "atlassian.callMcpTool",
      request("atlassian.callMcpTool", {
        user: { email: "person@example.com" },
        input: {
          name: "createJiraIssue",
          arguments: {
            cloudId: "https://example.atlassian.net",
            projectKey: "DM",
            issueTypeName: "Task",
            summary: "test ticket from slack"
          }
        }
      }),
      {
        callAtlassianMcpTool: async () => ({
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: true,
                message: "We are having trouble completing this action. Please try again shortly."
              })
            }
          ]
        }),
        getJiraUser: async () => {
          throw new JiraApiError("expired", 401);
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        error: "jira_authorization_failed",
        message: "Jira authorization expired. Reconnect Jira with `@Burble connect jira`."
      }
    });
  });

  test("rejects non-allowlisted mutating Atlassian MCP calls in the HTTP fallback gateway", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(jiraConnection),
      "atlassian.callMcpTool",
      request("atlassian.callMcpTool", {
        user: { email: "person@example.com" },
        input: {
          name: "updateJiraIssue",
          arguments: {
            key: "ENG-7"
          }
        }
      }),
      {
        callAtlassianMcpTool: async () => {
          throw new Error("unexpected upstream call");
        }
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        error: "atlassian_mcp_tool_not_allowed",
        message:
          "Atlassian MCP tool `updateJiraIssue` is not enabled for use."
      }
    });
  });

  test("returns a private Jira connect instruction when Jira is not connected", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(null),
      "jira.listAssignedIssues",
      request("jira.listAssignedIssues", {
        user: { email: "person@example.com" }
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      classification: "user_private",
      content: {
        error: "jira_not_connected",
        message: "Connect Jira first."
      }
    });
  });

  test("rejects unknown tools", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(connection),
      "github.deleteRepository",
      request("github.deleteRepository", {
        user: { email: "person@example.com" }
      })
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Unknown tool");
  });

  test("validates tool input before execution", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(connection),
      "github.searchIssues",
      request("github.searchIssues", {
        user: { email: "person@example.com" },
        input: {}
      })
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid tool input");
  });

  test("validates Jira search input before execution", async () => {
    const response = await handleToolGatewayRequest(
      config,
      createStore(jiraConnection),
      "jira.searchIssues",
      request("jira.searchIssues", {
        user: { email: "person@example.com" },
        input: {}
      })
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid tool input");
  });
});
