import type { Config } from "./config";
import type { TokenStore } from "./db";
import {
  getGitHubUser,
  listAssignedIssues,
  listMyPullRequests,
  searchIssues
} from "./github";
import { createGitHubTools } from "./tools/github";
import type { ToolResult } from "./tools/types";

type ToolGatewayDeps = Partial<Parameters<typeof createGitHubTools>[0]>;

type ToolGatewayBody = {
  user?: {
    email?: unknown;
  };
  input?: unknown;
};

const defaultDeps = {
  getGitHubUser,
  listAssignedIssues,
  searchIssues,
  listMyPullRequests
};

export async function handleToolGatewayRequest(
  config: Config,
  store: TokenStore,
  toolName: string,
  request: Request,
  deps: ToolGatewayDeps = {}
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!isAuthorized(config, request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!isKnownTool(toolName)) {
    return new Response("Unknown tool", { status: 404 });
  }

  const body = await readToolGatewayBody(request);
  if (!body || typeof body.user?.email !== "string") {
    return new Response("Invalid tool input", { status: 400 });
  }

  const connection = store.getConnection("github", body.user.email);
  if (!connection) {
    return jsonResponse({
      classification: "user_private",
      content: {
        error: "github_not_connected",
        message: "Connect GitHub first: `@Burble connect github`."
      }
    });
  }

  const tools = createGitHubTools({ ...defaultDeps, ...deps });

  switch (toolName) {
    case "github.getAuthenticatedUser":
      return jsonResponse(
        await tools.getAuthenticatedUser.execute({ connection })
      );

    case "github.listAssignedIssues":
      return jsonResponse(await tools.listAssignedIssues.execute({ connection }));

    case "github.searchIssues": {
      if (!isSearchIssuesInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return jsonResponse(
        await tools.searchIssues.execute({
          connection,
          input: { query: body.input.query }
        })
      );
    }

    case "github.listMyPullRequests":
      return jsonResponse(await tools.listMyPullRequests.execute({ connection }));
  }

  return new Response("Unknown tool", { status: 404 });
}

function isAuthorized(config: Config, request: Request): boolean {
  if (!config.internalApiToken) {
    return true;
  }

  return request.headers.get("authorization") === `Bearer ${config.internalApiToken}`;
}

function isKnownTool(toolName: string): boolean {
  return (
    toolName === "github.getAuthenticatedUser" ||
    toolName === "github.listAssignedIssues" ||
    toolName === "github.searchIssues" ||
    toolName === "github.listMyPullRequests"
  );
}

async function readToolGatewayBody(
  request: Request
): Promise<ToolGatewayBody | null> {
  try {
    return (await request.json()) as ToolGatewayBody;
  } catch {
    return null;
  }
}

function isSearchIssuesInput(input: unknown): input is { query: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    "query" in input &&
    typeof input.query === "string" &&
    input.query.trim().length > 0
  );
}

function jsonResponse(result: ToolResult<unknown>): Response {
  return Response.json(result, {
    headers: {
      "cache-control": "no-store"
    }
  });
}
