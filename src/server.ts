import type { Config } from "./config";
import type { AgentRuntimeEngine, TokenStore } from "./db";
import { exchangeGitHubCode, getGitHubUser } from "./providers/github/client";
import { exchangeGoogleCode, getGoogleUser } from "./providers/google/client";
import {
  exchangeHubSpotCode,
  getHubSpotAccessTokenInfo
} from "./providers/hubspot/client";
import { exchangeJiraCode, getJiraUser } from "./providers/jira/client";
import { formatLogError } from "./logging";
import { handleProviderMcpRequest } from "./mcp/provider-server";
import type { RuntimeJwtIssuer } from "./runtime-jwt";
import type { McpIdentityIssuer } from "./mcp-identity";
import { exchangeSlackCode } from "./providers/slack/client";
import type { SlackRuntime } from "./slack";
import { handleToolGatewayRequest } from "./tool-gateway";
import type { ObservabilitySink } from "./observability";
import type { SlackTestbed } from "./testbed/slack";
import { summarizeSlackTestbed } from "./testbed/slack";
import {
  isProviderDescriptorId,
  providerDescriptorIds,
  type ProviderDescriptorId
} from "./providers/descriptors";

export type GitHubOAuthDeps = {
  exchangeGitHubCode: typeof exchangeGitHubCode;
  getGitHubUser: typeof getGitHubUser;
};

export type JiraOAuthDeps = {
  exchangeJiraCode: typeof exchangeJiraCode;
  getJiraUser: typeof getJiraUser;
};

export type GoogleOAuthDeps = {
  exchangeGoogleCode: typeof exchangeGoogleCode;
  getGoogleUser: typeof getGoogleUser;
};

export type HubSpotOAuthDeps = {
  exchangeHubSpotCode: typeof exchangeHubSpotCode;
  getHubSpotAccessTokenInfo: typeof getHubSpotAccessTokenInfo;
};

export type SlackOAuthDeps = {
  exchangeSlackCode: typeof exchangeSlackCode;
};

export type StartOAuthServerOptions = {
  observability?: ObservabilitySink;
  mcpIdentityIssuer?: McpIdentityIssuer | null;
};

const defaultGitHubOAuthDeps: GitHubOAuthDeps = {
  exchangeGitHubCode,
  getGitHubUser
};

const defaultJiraOAuthDeps: JiraOAuthDeps = {
  exchangeJiraCode,
  getJiraUser
};

const defaultGoogleOAuthDeps: GoogleOAuthDeps = {
  exchangeGoogleCode,
  getGoogleUser
};

const defaultHubSpotOAuthDeps: HubSpotOAuthDeps = {
  exchangeHubSpotCode,
  getHubSpotAccessTokenInfo
};

const defaultSlackOAuthDeps: SlackOAuthDeps = {
  exchangeSlackCode
};

const providerMcpRoutePattern = new RegExp(
  `^/mcp(?:/(${providerDescriptorIds.join("|")}))?$`
);

export function startOAuthServer(
  config: Config,
  store: TokenStore,
  slack: SlackRuntime,
  runtimeJwtIssuer: RuntimeJwtIssuer,
  observabilityOrOptions?: ObservabilitySink | StartOAuthServerOptions,
  testbed?: SlackTestbed
): ReturnType<typeof Bun.serve> {
  const options = normalizeStartOAuthServerOptions(observabilityOrOptions);
  return Bun.serve({
    port: config.port,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/healthz") {
        return new Response("ok");
      }

      if (url.pathname === "/oauth/jwks") {
        return jsonResponse(runtimeJwtIssuer.jwks());
      }

      if (
        (url.pathname === "/.well-known/jwks.json" ||
          url.pathname === "/mcp-identity/jwks") &&
        options.mcpIdentityIssuer
      ) {
        return jsonResponse(options.mcpIdentityIssuer.jwks());
      }

      if (config.testbed && testbed && url.pathname.startsWith("/__testbed")) {
        return handleTestbedRequest(request, url, store, testbed);
      }

      const providerMcpMatch = url.pathname.match(providerMcpRoutePattern);
      if (providerMcpMatch) {
        const providerScope = providerMcpScopeFromPath(providerMcpMatch[1]);
        return handleProviderMcpRequest(
          config,
          store,
          runtimeJwtIssuer,
          request,
          {
            mcpIdentityIssuer: options.mcpIdentityIssuer,
            getSlackEmail: (slackUserId) => slack.getSlackEmail(slackUserId)
          },
          providerScope
        );
      }

      const toolGatewayMatch = url.pathname.match(
        /^\/internal\/tools\/([^/]+)\/execute$/
      );
      if (toolGatewayMatch) {
        return handleToolGatewayRequest(
          config,
          store,
          decodeURIComponent(toolGatewayMatch[1]),
          request,
          {
            observability: options.observability,
            mcpIdentityIssuer: options.mcpIdentityIssuer,
            getSlackEmail: (slackUserId) => slack.getSlackEmail(slackUserId)
          }
        );
      }

      if (url.pathname === "/oauth/github/callback") {
        return handleGitHubCallback(config, store, slack, url);
      }

      if (url.pathname === "/oauth/jira/callback") {
        return handleJiraCallback(config, store, slack, url);
      }

      if (url.pathname === "/oauth/google/callback") {
        return handleGoogleCallback(config, store, slack, url);
      }

      if (url.pathname === "/oauth/hubspot/callback") {
        return handleHubSpotCallback(config, store, slack, url);
      }

      if (url.pathname === "/oauth/slack/callback") {
        return handleSlackCallback(config, store, slack, url);
      }

      return new Response("Not found", { status: 404 });
    }
  });
}

function normalizeStartOAuthServerOptions(
  input: ObservabilitySink | StartOAuthServerOptions | undefined
): StartOAuthServerOptions {
  if (!input) {
    return {};
  }
  if ("emit" in input) {
    return { observability: input };
  }
  return input;
}

function providerMcpScopeFromPath(value: string | undefined): "all" | ProviderDescriptorId {
  if (!value) {
    return "all";
  }
  if (!isProviderDescriptorId(value)) {
    throw new Error(`Unknown provider MCP scope: ${value}`);
  }
  return value;
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      ...init?.headers,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

async function handleTestbedRequest(
  request: Request,
  url: URL,
  store: TokenStore,
  testbed: SlackTestbed
): Promise<Response> {
  if (url.pathname === "/__testbed/reset" && request.method === "POST") {
    testbed.reset();
    return jsonResponse({ ok: true });
  }

  if (
    url.pathname === "/__testbed/slack/events/message.im" &&
    request.method === "POST"
  ) {
    const body = await readJsonObject(request);
    await testbed.processMessage({
      text: stringField(body, "text") ?? "",
      user: stringField(body, "user"),
      channel: stringField(body, "channel"),
      team: stringField(body, "team"),
      ts: stringField(body, "ts")
    });
    return jsonResponse({ ok: true, slack: summarizeSlackTestbed(testbed.state) });
  }

  if (
    url.pathname === "/__testbed/slack/events/app_home_opened" &&
    request.method === "POST"
  ) {
    const body = await readJsonObject(request);
    await testbed.processAppHomeOpened({
      user: stringField(body, "user"),
      team: stringField(body, "team")
    });
    return jsonResponse({ ok: true, slack: summarizeSlackTestbed(testbed.state) });
  }

  if (url.pathname === "/__testbed/slack/actions" && request.method === "POST") {
    const body = await readJsonObject(request);
    const actionId = stringField(body, "actionId");
    if (!actionId) {
      return jsonResponse({ ok: false, error: "Missing actionId" }, { status: 400 });
    }
    await testbed.processBlockAction({
      actionId,
      value: stringField(body, "value"),
      selectedValue: stringField(body, "selectedValue"),
      user: stringField(body, "user"),
      team: stringField(body, "team"),
      triggerId: stringField(body, "triggerId")
    });
    return jsonResponse({ ok: true, slack: summarizeSlackTestbed(testbed.state) });
  }

  const channelMessagesMatch = url.pathname.match(
    /^\/__testbed\/slack\/channels\/([^/]+)\/messages$/
  );
  if (channelMessagesMatch && request.method === "GET") {
    const channel = decodeURIComponent(channelMessagesMatch[1]);
    return jsonResponse({
      ok: true,
      messages: testbed.state.messages.filter(
        (message) => message.channel === channel
      )
    });
  }

  const userHomeMatch = url.pathname.match(
    /^\/__testbed\/slack\/users\/([^/]+)\/home$/
  );
  if (userHomeMatch && request.method === "GET") {
    const user = decodeURIComponent(userHomeMatch[1]);
    return jsonResponse({
      ok: true,
      home: testbed.state.homes[user] ?? null
    });
  }

  if (url.pathname === "/__testbed/slack/state" && request.method === "GET") {
    return jsonResponse({ ok: true, slack: summarizeSlackTestbed(testbed.state) });
  }

  if (url.pathname === "/__testbed/runtimes" && request.method === "GET") {
    return jsonResponse({
      ok: true,
      runtimes: (["hermes", "openclaw", "burble-native"] as AgentRuntimeEngine[]).map((engine) =>
        store.getAgentRuntimeForPrincipal({
          workspaceId: "T_TESTBED",
          slackUserId: "U_TESTBED",
          engine
        })
      )
    });
  }

  return new Response("Not found", { status: 404 });
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => ({}));
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function stringField(
  input: Record<string, unknown>,
  field: string
): string | undefined {
  const value = input[field];
  return typeof value === "string" ? value : undefined;
}

export async function handleGitHubCallback(
  config: Config,
  store: TokenStore,
  slack: SlackRuntime,
  url: URL,
  deps: GitHubOAuthDeps = defaultGitHubOAuthDeps
): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response("Missing code or state", { status: 400 });
  }

  const stateRow = store.consumeOAuthState(state);
  if (!stateRow) {
    return new Response("Invalid or expired OAuth state", { status: 400 });
  }

  try {
    const token = await deps.exchangeGitHubCode(config, code, state);
    const githubUser = await deps.getGitHubUser(token);
    const email = await slack.getSlackEmail(stateRow.slackUserId);

    store.upsertConnectedUser({
      email,
      slackUserId: stateRow.slackUserId,
      githubLogin: githubUser.login,
      githubToken: token
    });

    await slack.app.client.chat.postMessage({
      channel: stateRow.slackUserId,
      text: `Connected as \`${githubUser.login}\` (${email}).`
    });

    return htmlResponse("Connected. You can close this tab.");
  } catch (error) {
    console.error(formatLogError(error));
    await slack.app.client.chat.postMessage({
      channel: stateRow.slackUserId,
      text: "GitHub connection failed. Run `/auth github` and try again."
    });
    return new Response("GitHub connection failed", { status: 400 });
  }
}

export async function handleJiraCallback(
  config: Config,
  store: TokenStore,
  slack: SlackRuntime,
  url: URL,
  deps: JiraOAuthDeps = defaultJiraOAuthDeps
): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response("Missing code or state", { status: 400 });
  }

  const stateRow = store.consumeOAuthState(state);
  if (!stateRow) {
    return new Response("Invalid or expired OAuth state", { status: 400 });
  }

  try {
    const token = await deps.exchangeJiraCode(config, code);
    const jiraUser = await deps.getJiraUser(token.accessToken);
    const email = await slack.getSlackEmail(stateRow.slackUserId);

    store.upsertProviderConnection({
      provider: "jira",
      email,
      slackUserId: stateRow.slackUserId,
      providerLogin: jiraUser.displayName,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      accessTokenExpiresAt: token.accessTokenExpiresAt
    });

    await slack.app.client.chat.postMessage({
      channel: stateRow.slackUserId,
      text: `Connected to Jira as \`${jiraUser.displayName}\` (${email}).`
    });

    return htmlResponse("Connected. You can close this tab.");
  } catch (error) {
    console.error(formatLogError(error));
    await slack.app.client.chat.postMessage({
      channel: stateRow.slackUserId,
      text: "Jira connection failed. Run `/auth jira` and try again."
    });
    return new Response("Jira connection failed", { status: 400 });
  }
}

export async function handleGoogleCallback(
  config: Config,
  store: TokenStore,
  slack: SlackRuntime,
  url: URL,
  deps: GoogleOAuthDeps = defaultGoogleOAuthDeps
): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response("Missing code or state", { status: 400 });
  }

  const stateRow = store.consumeOAuthState(state);
  if (!stateRow) {
    return new Response("Invalid or expired OAuth state", { status: 400 });
  }

  try {
    const token = await deps.exchangeGoogleCode(config, code);
    const googleUser = await deps.getGoogleUser(token.accessToken);
    const email = await slack.getSlackEmail(stateRow.slackUserId);

    store.upsertProviderConnection({
      provider: "google",
      email,
      slackUserId: stateRow.slackUserId,
      providerLogin: googleUser.email,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      accessTokenExpiresAt: token.accessTokenExpiresAt
    });

    await slack.app.client.chat.postMessage({
      channel: stateRow.slackUserId,
      text: `Connected to Google as \`${googleUser.email}\` (${email}).`
    });

    return htmlResponse("Connected. You can close this tab.");
  } catch (error) {
    console.error(formatLogError(error));
    await slack.app.client.chat.postMessage({
      channel: stateRow.slackUserId,
      text: "Google connection failed. Run `/auth google` and try again."
    });
    return new Response("Google connection failed", { status: 400 });
  }
}

export async function handleHubSpotCallback(
  config: Config,
  store: TokenStore,
  slack: SlackRuntime,
  url: URL,
  deps: HubSpotOAuthDeps = defaultHubSpotOAuthDeps
): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response("Missing code or state", { status: 400 });
  }

  const stateRow = store.consumeOAuthState(state);
  if (!stateRow) {
    return new Response("Invalid or expired OAuth state", { status: 400 });
  }

  try {
    const token = await deps.exchangeHubSpotCode(config, code);
    const hubspotInfo = await deps.getHubSpotAccessTokenInfo(token.accessToken);
    const email = await slack.getSlackEmail(stateRow.slackUserId);
    const providerLogin =
      hubspotInfo.user ??
      hubspotInfo.hubDomain ??
      (hubspotInfo.hubId !== null ? String(hubspotInfo.hubId) : "HubSpot");

    store.upsertProviderConnection({
      provider: "hubspot",
      email,
      slackUserId: stateRow.slackUserId,
      providerLogin,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      accessTokenExpiresAt: token.accessTokenExpiresAt
    });

    await slack.app.client.chat.postMessage({
      channel: stateRow.slackUserId,
      text: `Connected to HubSpot as \`${providerLogin}\` (${email}).`
    });

    return htmlResponse("Connected. You can close this tab.");
  } catch (error) {
    console.error(formatLogError(error));
    await slack.app.client.chat.postMessage({
      channel: stateRow.slackUserId,
      text: "HubSpot connection failed. Run `/auth hubspot` and try again."
    });
    return new Response("HubSpot connection failed", { status: 400 });
  }
}

export async function handleSlackCallback(
  config: Config,
  store: TokenStore,
  slack: SlackRuntime,
  url: URL,
  deps: SlackOAuthDeps = defaultSlackOAuthDeps
): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response("Missing code or state", { status: 400 });
  }

  const stateRow = store.consumeOAuthState(state);
  if (!stateRow) {
    return new Response("Invalid or expired OAuth state", { status: 400 });
  }

  try {
    const token = await deps.exchangeSlackCode(config, code);
    if (token.slackUserId !== stateRow.slackUserId) {
      throw new Error("Slack OAuth user did not match the initiating Slack user");
    }

    const email = await slack.getSlackEmail(stateRow.slackUserId);

    store.upsertProviderConnection({
      provider: "slack",
      email,
      slackUserId: stateRow.slackUserId,
      providerLogin: token.slackUserId,
      accessToken: token.accessToken
    });

    await slack.app.client.chat.postMessage({
      channel: stateRow.slackUserId,
      text: `Connected Slack search for <@${token.slackUserId}> (${email}).`
    });

    return htmlResponse("Connected. You can close this tab.");
  } catch (error) {
    console.error(formatLogError(error));
    await slack.app.client.chat.postMessage({
      channel: stateRow.slackUserId,
      text: "Slack connection failed. Run `/auth slack` and try again."
    });
    return new Response("Slack connection failed", { status: 400 });
  }
}

function htmlResponse(message: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Burble</title></head><body><main><h1>${escapeHtml(
      message
    )}</h1></main></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8"
      }
    }
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
