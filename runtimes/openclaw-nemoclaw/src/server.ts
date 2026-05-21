import type { RuntimeConfig } from "./config";
import { createRuntimeRunner } from "./runtime";
import type { RunRequest, ToolExecutor } from "./types";

export async function handleRuntimeRequest(
  request: Request,
  config: RuntimeConfig,
  executeTool?: ToolExecutor
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/healthz") {
    return new Response("ok");
  }

  if (url.pathname !== "/runs") {
    return new Response("Not found", { status: 404 });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const body = await readRunRequest(request);
  if (!body || !isRunRequest(body)) {
    return new Response("Invalid run request", { status: 400 });
  }

  const result = await createRuntimeRunner(config).run(body, executeTool);
  return Response.json(result, {
    headers: {
      "cache-control": "no-store"
    }
  });
}

async function readRunRequest(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function isRunRequest(body: unknown): body is RunRequest {
  if (typeof body !== "object" || body === null || !("input" in body)) {
    return false;
  }

  const input = body.input;
  if (
    "runtime" in body &&
    body.runtime !== undefined &&
    !isRuntimeSummary(body.runtime)
  ) {
    return false;
  }

  if (
    typeof input !== "object" ||
    input === null ||
    !("text" in input) ||
    typeof input.text !== "string" ||
    input.text.trim().length === 0 ||
    !("connections" in input)
  ) {
    return false;
  }

  const connections = input.connections;
  if (
    typeof connections !== "object" ||
    connections === null ||
    !("github" in connections)
  ) {
    return false;
  }

  const github = connections.github;
  return (
    typeof github === "object" &&
    github !== null &&
    "connected" in github &&
    typeof github.connected === "boolean"
  );
}

function isRuntimeSummary(runtime: unknown): runtime is RunRequest["runtime"] {
  return (
    typeof runtime === "object" &&
    runtime !== null &&
    "id" in runtime &&
    typeof runtime.id === "string" &&
    runtime.id.trim().length > 0
  );
}
