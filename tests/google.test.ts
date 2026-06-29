import { describe, expect, test } from "bun:test";
import analyticsGetMetadataCassette from "./fixtures/provider-cassettes/google/analytics-get-metadata.json";
import analyticsListPropertiesCassette from "./fixtures/provider-cassettes/google/analytics-list-properties.json";
import analyticsRunReportCassette from "./fixtures/provider-cassettes/google/analytics-run-report.json";
import slidesPresentationCassette from "./fixtures/provider-cassettes/google/slides-presentation.json";
import { withProviderCassette } from "./helpers/provider-cassettes";
import type { Config } from "../src/config";
import { googleProviderToolSpecs } from "../src/providers/google/tool-specs";
import {
  buildGoogleOAuthUrl,
  exchangeGoogleCode,
  getGoogleUser,
  getGoogleAnalyticsMetadata,
  getGoogleSlidesPresentation,
  fillGoogleSlidesPlaceholders,
  listGoogleAnalyticsProperties,
  probeGoogleSlidesTemplate,
  refreshGoogleAccessToken,
  copyGoogleSlidesPresentation,
  createGoogleSlidesSlide,
  createGoogleDriveTextFile,
  runGoogleAnalyticsReport,
  searchGoogleDriveFiles,
  searchGoogleSlidesPresentations
} from "../src/providers/google/client";
import type { ProviderCassette } from "./helpers/provider-cassettes";

const googleProviderApiCassetteToolNames = [
  "google_analytics_get_metadata",
  "google_analytics_list_properties",
  "google_analytics_run_report",
  "google_slides_get_presentation",
  "google_slides_probe_template"
].sort();

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
  agentRuntimeSandboxUrl: null,
  agentRuntimeSandboxToken: null,
  agentRuntimeSandboxStartCommand: null,
  atlassianMcpUrl: "https://mcp.atlassian.com/v1/mcp",
  runtimeJwtIssuer: "https://example.ngrok-free.app",
  runtimeJwtPrivateKeyPath: null,
  openClawConfigPatchHostPath: null,
  internalApiToken: null,
  observabilityJsonlPath: null,
  observabilityJsonlDir: null,
  observabilityIncludeContent: false,
  taskWorkflowShadowEnabled: false,
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
    const scopes = url.searchParams.get("scope")?.split(" ") ?? [];
    expect(scopes).toContain(
      "https://www.googleapis.com/auth/drive.metadata.readonly"
    );
    expect(scopes).toContain("https://www.googleapis.com/auth/drive");
    expect(scopes).toContain("https://www.googleapis.com/auth/drive.file");
    expect(scopes).toContain("https://www.googleapis.com/auth/presentations");
    expect(scopes).toContain(
      "https://www.googleapis.com/auth/calendar.readonly"
    );
    expect(scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(scopes).toContain(
      "https://www.googleapis.com/auth/analytics.readonly"
    );
    expect(scopes).toContain(
      "https://www.googleapis.com/auth/presentations.readonly"
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

  test("rejects Google Workspace MIME types for Drive text file creation", async () => {
    const originalFetch = globalThis.fetch;
    let didFetch = false;
    globalThis.fetch = (async (_input, _init) => {
      didFetch = true;
      return Response.json({});
    }) as typeof fetch;

    try {
      await expect(
        createGoogleDriveTextFile("google-token", {
          name: "Deck",
          text: "",
          mimeType: "application/vnd.google-apps.presentation"
        })
      ).rejects.toThrow(
        "Google Drive text files cannot use Google Workspace document MIME types"
      );
      expect(didFetch).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Google OAuth and API helpers", () => {
  test("keeps provider API cassette coverage for Google Analytics and Slides template reads", () => {
    const requiredToolNames = googleProviderToolSpecs
      .filter(
        (tool) =>
          tool.name.startsWith("google_analytics_") ||
          tool.name === "google_slides_get_presentation" ||
          tool.name === "google_slides_probe_template"
      )
      .map((tool) => tool.name)
      .sort();

    expect(googleProviderApiCassetteToolNames).toEqual(requiredToolNames);
  });

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
    await withProviderCassette(
      analyticsListPropertiesCassette as ProviderCassette,
      async (cassette) => {
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
        cassette.assertComplete();
        const url = new URL(cassette.requests[0]?.url ?? "");
        expect(url.origin + url.pathname).toBe(
          "https://analyticsadmin.googleapis.com/v1beta/accountSummaries"
        );
        expect(url.searchParams.get("pageSize")).toBe("5");
        expect(url.searchParams.get("fields")).toBe(
          "accountSummaries(account,displayName,propertySummaries(property,displayName,parent,propertyType))"
        );
      }
    );
  });

  test("reads and filters Google Analytics metadata", async () => {
    await withProviderCassette(
      analyticsGetMetadataCassette as ProviderCassette,
      async (cassette) => {
        const metadata = await getGoogleAnalyticsMetadata("google-token", {
          propertyId: "properties/456",
          dimensionQuery: "geo",
          metricQuery: "session",
          limit: 10
        });
        expect(metadata).toEqual({
          dimensions: [
            {
              apiName: "country",
              uiName: "Country",
              description: "The country from which activity originated.",
              category: "Geo"
            }
          ],
          metrics: [
            {
              apiName: "sessions",
              uiName: "Sessions",
              description: "The number of sessions that began.",
              category: "Session"
            }
          ]
        });
        cassette.assertComplete();
        const url = new URL(cassette.requests[0]?.url ?? "");
        expect(url.origin + url.pathname).toBe(
          "https://analyticsdata.googleapis.com/v1beta/properties/456/metadata"
        );
      }
    );
  });

  test("runs a Google Analytics report through the Data API", async () => {
    await withProviderCassette(
      analyticsRunReportCassette as ProviderCassette,
      async (cassette) => {
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
        cassette.assertComplete();
        expect(cassette.requests[0]?.url).toBe(
          "https://analyticsdata.googleapis.com/v1beta/properties/456:runReport"
        );
        expect(cassette.requests[0]?.bodyJson).toEqual({
          dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
          metrics: [{ name: "activeUsers" }],
          dimensions: [{ name: "country" }],
          limit: "3"
        });
      }
    );
  });

  test("rejects Google Analytics reports with too-wide date ranges before fetching", async () => {
    const originalFetch = globalThis.fetch;
    let didFetch = false;
    globalThis.fetch = (async (_input, _init) => {
      didFetch = true;
      return Response.json({});
    }) as typeof fetch;

    try {
      await expect(
        runGoogleAnalyticsReport("google-token", {
          propertyId: "456",
          startDate: "2024-01-01",
          endDate: "2026-01-01",
          metrics: ["activeUsers"]
        })
      ).rejects.toThrow("Google Analytics report date range is limited to 366 days");
      expect(didFetch).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("searches Google Slides presentations through Drive metadata", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer google-token"
      );
      return Response.json({
        files: [
          {
            id: "deck-1",
            name: "QBR",
            mimeType: "application/vnd.google-apps.presentation",
            webViewLink: "https://docs.google.com/presentation/d/deck-1",
            modifiedTime: "2026-06-01T00:00:00Z"
          }
        ]
      });
    }) as typeof fetch;

    try {
      const decks = await searchGoogleSlidesPresentations("google-token", {
        query: "QBR",
        limit: 4
      });
      expect(decks).toEqual([
        {
          id: "deck-1",
          name: "QBR",
          mimeType: "application/vnd.google-apps.presentation",
          webViewLink: "https://docs.google.com/presentation/d/deck-1",
          modifiedTime: "2026-06-01T00:00:00Z"
        }
      ]);
      const url = new URL(requestedUrl);
      expect(url.origin + url.pathname).toBe(
        "https://www.googleapis.com/drive/v3/files"
      );
      expect(url.searchParams.get("q")).toBe(
        "trashed = false and mimeType = 'application/vnd.google-apps.presentation' and name contains 'QBR'"
      );
      expect(url.searchParams.get("pageSize")).toBe("4");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("copies a Google Slides presentation through Drive copy", async () => {
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
        id: "deck-copy",
        name: "ApeLogic Template Copy",
        mimeType: "application/vnd.google-apps.presentation",
        webViewLink: "https://docs.google.com/presentation/d/deck-copy"
      });
    }) as typeof fetch;

    try {
      const copied = await copyGoogleSlidesPresentation("google-token", {
        presentationId: "deck-template",
        name: "ApeLogic Template Copy"
      });
      expect(copied).toEqual({
        id: "deck-copy",
        name: "ApeLogic Template Copy",
        mimeType: "application/vnd.google-apps.presentation",
        webViewLink: "https://docs.google.com/presentation/d/deck-copy"
      });
      const url = new URL(requestedUrl);
      expect(url.origin + url.pathname).toBe(
        "https://www.googleapis.com/drive/v3/files/deck-template/copy"
      );
      expect(url.searchParams.get("fields")).toBe(
        "id,name,mimeType,webViewLink"
      );
      expect(requestedBody).toEqual({
        name: "ApeLogic Template Copy"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("creates a Google Slides slide through batchUpdate and fills placeholders", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
      });
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer google-token"
      );
      if (url.endsWith(":batchUpdate")) {
        expect(init?.method).toBe("POST");
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (
          Array.isArray(body.requests) &&
          body.requests.some((request: unknown) =>
            Boolean((request as { createSlide?: unknown }).createSlide)
          )
        ) {
          return Response.json({
            presentationId: "deck-1",
            replies: [{ createSlide: { objectId: "slide-3" } }]
          });
        }
        return Response.json({
          presentationId: "deck-1",
          replies: [{}, {}, {}, {}]
        });
      }
      return Response.json({
        presentationId: "deck-1",
        title: "ApeLogic",
        layouts: [],
        slides: [
          {
            objectId: "slide-3",
            slideProperties: { layoutObjectId: "layout-two-columns" },
            pageElements: [
              {
                objectId: "title-shape",
                shape: {
                  shapeType: "TEXT_BOX",
                  placeholder: { type: "TITLE", index: 0 },
                  text: { textElements: [] }
                }
              },
              {
                objectId: "left-body",
                shape: {
                  shapeType: "TEXT_BOX",
                  placeholder: { type: "BODY", index: 0 },
                  text: { textElements: [] }
                }
              },
              {
                objectId: "right-body",
                shape: {
                  shapeType: "TEXT_BOX",
                  placeholder: { type: "BODY", index: 1 },
                  text: { textElements: [] }
                }
              }
            ]
          }
        ]
      });
    }) as typeof fetch;

    try {
      const result = await createGoogleSlidesSlide("google-token", {
        presentationId: "deck-1",
        insertionIndex: 2,
        predefinedLayout: "TITLE_AND_TWO_COLUMNS",
        replacements: [
          { placeholderType: "TITLE", text: "Test slide 3" },
          { placeholderType: "BODY", index: 0, text: "Left side text" },
          { placeholderType: "BODY", index: 1, text: "Right side text" }
        ]
      });

      expect(result).toEqual({
        presentationId: "deck-1",
        slideObjectId: "slide-3",
        layoutObjectId: "layout-two-columns",
        filledPlaceholders: {
          presentationId: "deck-1",
          slideObjectId: "slide-3",
          updatedPlaceholders: [
            {
              placeholderType: "TITLE",
              matchedPlaceholderType: "TITLE",
              objectId: "title-shape",
              text: "Test slide 3"
            },
            {
              placeholderType: "BODY",
              matchedPlaceholderType: "BODY",
              objectId: "left-body",
              text: "Left side text",
              index: 0
            },
            {
              placeholderType: "BODY",
              matchedPlaceholderType: "BODY",
              objectId: "right-body",
              text: "Right side text",
              index: 1
            }
          ],
          skippedPlaceholders: []
        }
      });
      expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
        "/v1/presentations/deck-1:batchUpdate",
        "/v1/presentations/deck-1",
        "/v1/presentations/deck-1:batchUpdate",
        "/v1/presentations/deck-1"
      ]);
      expect(requests[0]?.body).toEqual({
        requests: [
          {
            createSlide: {
              insertionIndex: 2,
              slideLayoutReference: {
                predefinedLayout: "TITLE_AND_TWO_COLUMNS"
              }
            }
          }
        ]
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fills Google Slides placeholders through batchUpdate", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
      });
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer google-token"
      );
      if (url.includes(":batchUpdate")) {
        expect(init?.method).toBe("POST");
        return Response.json({
          presentationId: "deck-1",
          replies: [{}, {}, {}, {}]
        });
      }
      return Response.json({
        presentationId: "deck-1",
        title: "ApeLogic",
        layouts: [],
        slides: [
          {
            objectId: "slide-1",
            pageElements: [
              {
                objectId: "title-shape",
                shape: {
                  shapeType: "TEXT_BOX",
                  placeholder: { type: "TITLE", index: 0 },
                  text: {
                    textElements: [{ textRun: { content: "Click to add title\n" } }]
                  }
                }
              },
              {
                objectId: "subtitle-shape",
                shape: {
                  shapeType: "TEXT_BOX",
                  placeholder: { type: "SUBTITLE", index: 0 },
                  text: {
                    textElements: [
                      { textRun: { content: "Click to add subtitle\n" } }
                    ]
                  }
                }
              }
            ]
          }
        ]
      });
    }) as typeof fetch;

    try {
      const result = await fillGoogleSlidesPlaceholders("google-token", {
        presentationId: "deck-1",
        replacements: [
          { placeholderType: "TITLE", text: "ApeLogic" },
          {
            placeholderType: "SUBTITLE",
            text: "Test presentation from template"
          }
        ]
      });

      expect(result).toEqual({
        presentationId: "deck-1",
        slideObjectId: "slide-1",
        updatedPlaceholders: [
          {
            placeholderType: "TITLE",
            matchedPlaceholderType: "TITLE",
            objectId: "title-shape",
            text: "ApeLogic"
          },
          {
            placeholderType: "SUBTITLE",
            matchedPlaceholderType: "SUBTITLE",
            objectId: "subtitle-shape",
            text: "Test presentation from template"
          }
        ],
        skippedPlaceholders: []
      });
      expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
        "/v1/presentations/deck-1",
        "/v1/presentations/deck-1:batchUpdate"
      ]);
      expect(requests[1]?.body).toEqual({
        requests: [
          {
            deleteText: {
              objectId: "title-shape",
              textRange: { type: "ALL" }
            }
          },
          {
            insertText: {
              objectId: "title-shape",
              insertionIndex: 0,
              text: "ApeLogic"
            }
          },
          {
            deleteText: {
              objectId: "subtitle-shape",
              textRange: { type: "ALL" }
            }
          },
          {
            insertText: {
              objectId: "subtitle-shape",
              insertionIndex: 0,
              text: "Test presentation from template"
            }
          }
        ]
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fills title slide placeholders using logical placeholder roles", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
      });
      if (url.includes(":batchUpdate")) {
        expect(init?.method).toBe("POST");
        return Response.json({
          presentationId: "deck-title",
          replies: [{}, {}, {}, {}]
        });
      }
      return Response.json({
        presentationId: "deck-title",
        title: "ApeLogic",
        layouts: [],
        slides: [
          {
            objectId: "slide-body",
            pageElements: [
              {
                objectId: "body-shape",
                shape: {
                  shapeType: "TEXT_BOX",
                  placeholder: { type: "BODY", index: 0 },
                  text: {
                    textElements: [{ textRun: { content: "Click to add text\n" } }]
                  }
                }
              }
            ]
          },
          {
            objectId: "slide-title",
            pageElements: [
              {
                objectId: "centered-title-shape",
                shape: {
                  shapeType: "TEXT_BOX",
                  placeholder: { type: "CENTERED_TITLE", index: 0 },
                  text: {
                    textElements: [{ textRun: { content: "Click to add title\n" } }]
                  }
                }
              },
              {
                objectId: "subtitle-shape",
                shape: {
                  shapeType: "TEXT_BOX",
                  placeholder: { type: "SUBTITLE", index: 0 },
                  text: {
                    textElements: [
                      { textRun: { content: "Click to add subtitle\n" } }
                    ]
                  }
                }
              }
            ]
          }
        ]
      });
    }) as typeof fetch;

    try {
      const result = await fillGoogleSlidesPlaceholders("google-token", {
        presentationId: "deck-title",
        replacements: [
          { placeholderType: "TITLE", text: "ApeLogic" },
          {
            placeholderType: "SUBTITLE",
            text: "Test presentation from template"
          }
        ]
      });

      expect(result).toEqual({
        presentationId: "deck-title",
        slideObjectId: "slide-title",
        updatedPlaceholders: [
          {
            placeholderType: "TITLE",
            matchedPlaceholderType: "CENTERED_TITLE",
            objectId: "centered-title-shape",
            text: "ApeLogic"
          },
          {
            placeholderType: "SUBTITLE",
            matchedPlaceholderType: "SUBTITLE",
            objectId: "subtitle-shape",
            text: "Test presentation from template"
          }
        ],
        skippedPlaceholders: []
      });
      expect(requests[1]?.body).toEqual({
        requests: [
          {
            deleteText: {
              objectId: "centered-title-shape",
              textRange: { type: "ALL" }
            }
          },
          {
            insertText: {
              objectId: "centered-title-shape",
              insertionIndex: 0,
              text: "ApeLogic"
            }
          },
          {
            deleteText: {
              objectId: "subtitle-shape",
              textRange: { type: "ALL" }
            }
          },
          {
            insertText: {
              objectId: "subtitle-shape",
              insertionIndex: 0,
              text: "Test presentation from template"
            }
          }
        ]
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reports missing Google Slides placeholders while applying matches", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
      });
      if (url.includes(":batchUpdate")) {
        expect(init?.method).toBe("POST");
        return Response.json({
          presentationId: "deck-partial",
          replies: [{}, {}]
        });
      }
      return Response.json({
        presentationId: "deck-partial",
        title: "ApeLogic",
        layouts: [],
        slides: [
          {
            objectId: "slide-1",
            pageElements: [
              {
                objectId: "title-shape",
                shape: {
                  shapeType: "TEXT_BOX",
                  placeholder: { type: "CENTERED_TITLE", index: 0 },
                  text: {
                    textElements: [{ textRun: { content: "Click to add title\n" } }]
                  }
                }
              }
            ]
          }
        ]
      });
    }) as typeof fetch;

    try {
      const result = await fillGoogleSlidesPlaceholders("google-token", {
        presentationId: "deck-partial",
        replacements: [
          { placeholderType: "TITLE", text: "ApeLogic" },
          { placeholderType: "SUBTITLE", text: "Test presentation from template" }
        ]
      });

      expect(result).toEqual({
        presentationId: "deck-partial",
        slideObjectId: "slide-1",
        updatedPlaceholders: [
          {
            placeholderType: "TITLE",
            matchedPlaceholderType: "CENTERED_TITLE",
            objectId: "title-shape",
            text: "ApeLogic"
          }
        ],
        skippedPlaceholders: [
          {
            placeholderType: "SUBTITLE",
            slideObjectId: "slide-1",
            text: "Test presentation from template",
            reason: "placeholder_not_found"
          }
        ]
      });
      expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
        "/v1/presentations/deck-partial",
        "/v1/presentations/deck-partial:batchUpdate"
      ]);
      expect(requests[1]?.body).toEqual({
        requests: [
          {
            deleteText: {
              objectId: "title-shape",
              textRange: { type: "ALL" }
            }
          },
          {
            insertText: {
              objectId: "title-shape",
              insertionIndex: 0,
              text: "ApeLogic"
            }
          }
        ]
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fills empty Google Slides placeholders without deleting empty text ranges", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
      });
      if (url.includes(":batchUpdate")) {
        expect(init?.method).toBe("POST");
        return Response.json({
          presentationId: "deck-empty",
          replies: [{}, {}]
        });
      }
      return Response.json({
        presentationId: "deck-empty",
        title: "ApeLogic",
        layouts: [],
        slides: [
          {
            objectId: "slide-1",
            pageElements: [
              {
                objectId: "title-shape",
                shape: {
                  shapeType: "TEXT_BOX",
                  placeholder: { type: "TITLE", index: 0 },
                  text: { textElements: [] }
                }
              },
              {
                objectId: "subtitle-shape",
                shape: {
                  shapeType: "TEXT_BOX",
                  placeholder: { type: "SUBTITLE", index: 0 }
                }
              }
            ]
          }
        ]
      });
    }) as typeof fetch;

    try {
      await fillGoogleSlidesPlaceholders("google-token", {
        presentationId: "deck-empty",
        replacements: [
          { placeholderType: "TITLE", text: "ApeLogic" },
          {
            placeholderType: "SUBTITLE",
            text: "Test presentation from template"
          }
        ]
      });

      expect(requests[1]?.body).toEqual({
        requests: [
          {
            insertText: {
              objectId: "title-shape",
              insertionIndex: 0,
              text: "ApeLogic"
            }
          },
          {
            insertText: {
              objectId: "subtitle-shape",
              insertionIndex: 0,
              text: "Test presentation from template"
            }
          }
        ]
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reads sanitized Google Slides presentation structure", async () => {
    await withProviderCassette(
      slidesPresentationCassette as ProviderCassette,
      async (cassette) => {
        const presentation = await getGoogleSlidesPresentation("google-token", {
          presentationId: "deck-1"
        });
        expect(presentation).toEqual({
          presentationId: "deck-1",
          title: "ApeLogic Presentation Template",
          layouts: [
            {
              objectId: "layout-title",
              name: "Title slide",
              slots: [
                {
                  role: "title",
                  objectId: "layout-centered-title",
                  placeholder: { type: "CENTERED_TITLE", index: 0 }
                },
                {
                  role: "subtitle",
                  objectId: "layout-subtitle",
                  placeholder: { type: "SUBTITLE", index: 0 }
                }
              ],
              elements: [
                {
                  objectId: "layout-centered-title",
                  elementType: "shape",
                  shapeType: "TEXT_BOX",
                  placeholder: { type: "CENTERED_TITLE", index: 0 },
                  text: "Click to add title"
                },
                {
                  objectId: "layout-subtitle",
                  elementType: "shape",
                  shapeType: "TEXT_BOX",
                  placeholder: { type: "SUBTITLE", index: 0 }
                }
              ]
            },
            {
              objectId: "layout-two-column",
              name: "Title and two columns",
              slots: [
                {
                  role: "title",
                  objectId: "layout-two-column-title",
                  placeholder: { type: "TITLE", index: 0 }
                },
                {
                  role: "body",
                  objectId: "layout-left-body",
                  placeholder: { type: "BODY", index: 0 }
                },
                {
                  role: "body_2",
                  objectId: "layout-right-body",
                  placeholder: { type: "BODY", index: 1 }
                }
              ],
              elements: [
                {
                  objectId: "layout-two-column-title",
                  elementType: "shape",
                  shapeType: "TEXT_BOX",
                  placeholder: { type: "TITLE", index: 0 }
                },
                {
                  objectId: "layout-left-body",
                  elementType: "shape",
                  shapeType: "TEXT_BOX",
                  placeholder: { type: "BODY", index: 0 }
                },
                {
                  objectId: "layout-right-body",
                  elementType: "shape",
                  shapeType: "TEXT_BOX",
                  placeholder: { type: "BODY", index: 1 }
                }
              ]
            }
          ],
          slides: [
            {
              objectId: "slide-title",
              layoutObjectId: "layout-title",
              elements: [
                {
                  objectId: "slide-title-shape",
                  elementType: "shape",
                  shapeType: "TEXT_BOX",
                  placeholder: {
                    type: "CENTERED_TITLE",
                    index: 0,
                    parentObjectId: "layout-centered-title"
                  },
                  text: "ApeLogic"
                },
                {
                  objectId: "slide-subtitle-shape",
                  elementType: "shape",
                  shapeType: "TEXT_BOX",
                  placeholder: {
                    type: "SUBTITLE",
                    index: 0,
                    parentObjectId: "layout-subtitle"
                  }
                },
                {
                  objectId: "slide-logo",
                  elementType: "image",
                  imageContentUrl:
                    "https://lh3.googleusercontent.com/template-logo"
                }
              ]
            }
          ]
        });
        cassette.assertComplete();
        const url = new URL(cassette.requests[0]?.url ?? "");
        expect(url.origin + url.pathname).toBe(
          "https://slides.googleapis.com/v1/presentations/deck-1"
        );
      }
    );
  });

  test("probes Google Slides layout placeholders into a template manifest", async () => {
    await withProviderCassette(
      slidesPresentationCassette as ProviderCassette,
      async (cassette) => {
        const probe = await probeGoogleSlidesTemplate("google-token", {
          presentationId: "deck-1"
        });
        expect(probe).toEqual({
          presentationId: "deck-1",
          title: "ApeLogic Presentation Template",
          layouts: [
            {
              layoutId: "layout-title",
              name: "Title slide",
              slots: [
                {
                  role: "title",
                  objectId: "layout-centered-title",
                  placeholder: { type: "CENTERED_TITLE", index: 0 }
                },
                {
                  role: "subtitle",
                  objectId: "layout-subtitle",
                  placeholder: { type: "SUBTITLE", index: 0 }
                }
              ]
            },
            {
              layoutId: "layout-two-column",
              name: "Title and two columns",
              slots: [
                {
                  role: "title",
                  objectId: "layout-two-column-title",
                  placeholder: { type: "TITLE", index: 0 }
                },
                {
                  role: "body",
                  objectId: "layout-left-body",
                  placeholder: { type: "BODY", index: 0 }
                },
                {
                  role: "body_2",
                  objectId: "layout-right-body",
                  placeholder: { type: "BODY", index: 1 }
                }
              ]
            }
          ]
        });
        cassette.assertComplete();
      }
    );
  });
});
