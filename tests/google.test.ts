import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import {
  buildGoogleOAuthUrl,
  exchangeGoogleCode,
  getGoogleUser,
  getGoogleAnalyticsMetadata,
  listGoogleAnalyticsProperties,
  refreshGoogleAccessToken,
  createGoogleDriveTextFile,
  runGoogleAnalyticsReport,
  searchGoogleDriveFiles
} from "../src/providers/google/client";

const config: Config = {
  slackBotToken: "xoxb-test",
  slackAppToken: "xapp-test",
  slackClientId: null,
  slackClientSecret: null,
  slackRedirectUri: "https://example.ngrok-free.app/oauth/slack/callback",
  githubClientId: "github-client-id",
  githubClientSecret: "github-client-secret",
  jiraClientId: null,
  jiraClientSecret: null,
  googleClientId: "google-client-id",
  googleClientSecret: "google-client-secret",
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
  atlassianMcpUrl: "https://mcp.atlassian.com/v1/mcp",
  runtimeJwtIssuer: "https://example.ngrok-free.app",
  runtimeJwtPrivateKeyPath: null,
  openClawConfigPatchHostPath: null,
  internalApiToken: null,
  observabilityJsonlPath: null,
  observabilityJsonlDir: null,
  observabilityIncludeContent: false,
  aiModel: "openai:gpt-5.4"
};

describe("buildGoogleOAuthUrl", () => {
  test("builds an authorize URL with Google Workspace scopes", () => {
    const url = new URL(buildGoogleOAuthUrl(config, "state-123"));

    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.pathname).toBe("/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("google-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://example.ngrok-free.app/oauth/google/callback"
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/drive.metadata.readonly"
    );
    expect(url.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/drive.file"
    );
    expect(url.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/calendar.readonly"
    );
    expect(url.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/gmail.readonly"
    );
    expect(url.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/analytics.readonly"
    );
  });

  test("creates a Drive text file with multipart upload", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let requestedBody = "";
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input);
      requestedBody = String(init?.body);
      const headers = new Headers(init?.headers);
      expect(init?.method).toBe("POST");
      expect(headers.get("authorization")).toBe("Bearer google-token");
      expect(headers.get("content-type")).toContain("multipart/related");
      return Response.json({
        id: "file-1",
        name: "Test",
        mimeType: "text/plain",
        webViewLink: "https://drive.google.com/file-1"
      });
    }) as typeof fetch;

    try {
      const file = await createGoogleDriveTextFile("google-token", {
        name: "Test",
        text: "Test One"
      });
      expect(file).toEqual({
        id: "file-1",
        name: "Test",
        mimeType: "text/plain",
        webViewLink: "https://drive.google.com/file-1"
      });
      const url = new URL(requestedUrl);
      expect(url.origin + url.pathname).toBe(
        "https://www.googleapis.com/upload/drive/v3/files"
      );
      expect(url.searchParams.get("uploadType")).toBe("multipart");
      expect(requestedBody).toContain('"name":"Test"');
      expect(requestedBody).toContain("Test One");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Google OAuth and API helpers", () => {
  test("exchanges an OAuth code", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe("https://oauth2.googleapis.com/token");
      expect(init?.method).toBe("POST");
      const body = init?.body as URLSearchParams;
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("code-123");
      expect(body.get("redirect_uri")).toBe(
        "https://example.ngrok-free.app/oauth/google/callback"
      );
      return Response.json({
        access_token: "google-token",
        refresh_token: "google-refresh",
        expires_in: 3600
      });
    }) as typeof fetch;

    try {
      const token = await exchangeGoogleCode(config, "code-123");
      expect(token.accessToken).toBe("google-token");
      expect(token.refreshToken).toBe("google-refresh");
      expect(typeof token.accessTokenExpiresAt).toBe("string");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("refreshes an access token", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      const body = init?.body as URLSearchParams;
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("refresh-token");
      return Response.json({
        access_token: "refreshed-token",
        expires_in: 3600
      });
    }) as typeof fetch;

    try {
      const token = await refreshGoogleAccessToken(config, "refresh-token");
      expect(token.accessToken).toBe("refreshed-token");
      expect(token.refreshToken).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reads Google user info", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer google-token"
      );
      return Response.json({ email: "person@example.com", name: "Person" });
    }) as typeof fetch;

    try {
      await expect(getGoogleUser("google-token")).resolves.toEqual({
        email: "person@example.com",
        name: "Person"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("searches Drive metadata by file name", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return Response.json({
        files: [{ id: "file-1", name: "Roadmap", webViewLink: "https://drive" }]
      });
    }) as typeof fetch;

    try {
      const files = await searchGoogleDriveFiles("google-token", {
        query: "roadmap",
        limit: 3
      });
      expect(files).toEqual([
        { id: "file-1", name: "Roadmap", webViewLink: "https://drive" }
      ]);
      const url = new URL(requestedUrl);
      expect(url.searchParams.get("pageSize")).toBe("3");
      expect(url.searchParams.get("q")).toBe(
        "trashed = false and name contains 'roadmap'"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("lists Google Analytics properties through the Admin API", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer google-token"
      );
      return Response.json({
        accountSummaries: [
          {
            account: "accounts/123",
            displayName: "ApeLogic",
            propertySummaries: [
              {
                property: "properties/456",
                displayName: "Website",
                parent: "accounts/123",
                currentPropertyType: "PROPERTY_TYPE_ORDINARY"
              }
            ]
          }
        ]
      });
    }) as typeof fetch;

    try {
      const properties = await listGoogleAnalyticsProperties("google-token", {
        limit: 5
      });
      expect(properties).toEqual([
        {
          account: "accounts/123",
          accountDisplayName: "ApeLogic",
          property: "properties/456",
          propertyId: "456",
          displayName: "Website",
          parent: "accounts/123",
          propertyType: "PROPERTY_TYPE_ORDINARY"
        }
      ]);
      const url = new URL(requestedUrl);
      expect(url.origin + url.pathname).toBe(
        "https://analyticsadmin.googleapis.com/v1beta/accountSummaries"
      );
      expect(url.searchParams.get("pageSize")).toBe("5");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reads and filters Google Analytics metadata", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return Response.json({
        dimensions: [
          { apiName: "country", uiName: "Country", category: "Geo" },
          { apiName: "browser", uiName: "Browser", category: "Platform" }
        ],
        metrics: [
          { apiName: "activeUsers", uiName: "Active users", category: "User" },
          { apiName: "sessions", uiName: "Sessions", category: "Session" }
        ]
      });
    }) as typeof fetch;

    try {
      const metadata = await getGoogleAnalyticsMetadata("google-token", {
        propertyId: "properties/456",
        dimensionQuery: "geo",
        metricQuery: "session",
        limit: 10
      });
      expect(metadata).toEqual({
        dimensions: [{ apiName: "country", uiName: "Country", category: "Geo" }],
        metrics: [{ apiName: "sessions", uiName: "Sessions", category: "Session" }]
      });
      const url = new URL(requestedUrl);
      expect(url.origin + url.pathname).toBe(
        "https://analyticsdata.googleapis.com/v1beta/properties/456/metadata"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("runs a Google Analytics report through the Data API", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let requestedBody: unknown = null;
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body));
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer google-token"
      );
      return Response.json({
        dimensionHeaders: [{ name: "country" }],
        metricHeaders: [{ name: "activeUsers" }],
        rows: [
          {
            dimensionValues: [{ value: "US" }],
            metricValues: [{ value: "42" }]
          }
        ],
        rowCount: 1
      });
    }) as typeof fetch;

    try {
      const report = await runGoogleAnalyticsReport("google-token", {
        propertyId: "456",
        startDate: "7daysAgo",
        endDate: "today",
        dimensions: ["country"],
        metrics: ["activeUsers"],
        limit: 3
      });
      expect(report).toEqual({
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
      });
      expect(requestedUrl).toBe(
        "https://analyticsdata.googleapis.com/v1beta/properties/456:runReport"
      );
      expect(requestedBody).toEqual({
        dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
        metrics: [{ name: "activeUsers" }],
        dimensions: [{ name: "country" }],
        limit: "3"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
