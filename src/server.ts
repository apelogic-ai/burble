import type { Config } from "./config";
import type { TokenStore } from "./db";
import { exchangeGitHubCode, getGitHubUser } from "./github";
import { formatLogError } from "./logging";
import type { SlackRuntime } from "./slack";
import { handleToolGatewayRequest } from "./tool-gateway";

export type GitHubOAuthDeps = {
  exchangeGitHubCode: typeof exchangeGitHubCode;
  getGitHubUser: typeof getGitHubUser;
};

const defaultGitHubOAuthDeps: GitHubOAuthDeps = {
  exchangeGitHubCode,
  getGitHubUser
};

export function startOAuthServer(
  config: Config,
  store: TokenStore,
  slack: SlackRuntime
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: config.port,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/healthz") {
        return new Response("ok");
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

      if (url.pathname !== "/oauth/github/callback") {
        return new Response("Not found", { status: 404 });
      }

      return handleGitHubCallback(config, store, slack, url);
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
