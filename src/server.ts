import type { Config } from "./config";
import type { TokenStore } from "./db";
import { exchangeGitHubCode, getGitHubUser } from "./github";
import { exchangeJiraCode, getJiraUser } from "./jira";
import { formatLogError } from "./logging";
import { handleProviderMcpRequest } from "./mcp/provider-server";
import type { RuntimeJwtIssuer } from "./runtime-jwt";
import { exchangeSlackCode } from "./slack-api";
import type { SlackRuntime } from "./slack";
import { handleToolGatewayRequest } from "./tool-gateway";

export type GitHubOAuthDeps = {
  exchangeGitHubCode: typeof exchangeGitHubCode;
  getGitHubUser: typeof getGitHubUser;
};

export type JiraOAuthDeps = {
  exchangeJiraCode: typeof exchangeJiraCode;
  getJiraUser: typeof getJiraUser;
};

export type SlackOAuthDeps = {
  exchangeSlackCode: typeof exchangeSlackCode;
};

const defaultGitHubOAuthDeps: GitHubOAuthDeps = {
  exchangeGitHubCode,
  getGitHubUser
};

const defaultJiraOAuthDeps: JiraOAuthDeps = {
  exchangeJiraCode,
  getJiraUser
};

const defaultSlackOAuthDeps: SlackOAuthDeps = {
  exchangeSlackCode
};

export function startOAuthServer(
  config: Config,
  store: TokenStore,
  slack: SlackRuntime,
  runtimeJwtIssuer: RuntimeJwtIssuer
): ReturnType<typeof Bun.serve> {
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

      if (url.pathname === "/mcp") {
        return handleProviderMcpRequest(
          config,
          store,
          runtimeJwtIssuer,
          request
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
          request
        );
      }

      if (url.pathname === "/oauth/github/callback") {
        return handleGitHubCallback(config, store, slack, url);
      }

      if (url.pathname === "/oauth/jira/callback") {
        return handleJiraCallback(config, store, slack, url);
      }

      if (url.pathname === "/oauth/slack/callback") {
        return handleSlackCallback(config, store, slack, url);
      }

      return new Response("Not found", { status: 404 });
    }
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
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
      text: "GitHub connection failed. Run `/connect-github` and try again."
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
