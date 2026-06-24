export type TestbedLlmGatewayRequest = {
  method: string;
  pathname: string;
  authorization: string | null;
};

export type TestbedLlmGateway = {
  port: number;
  requests: TestbedLlmGatewayRequest[];
  stop(): void;
};

function json(data: unknown): Response {
  return Response.json(data, {
    headers: {
      "cache-control": "no-store"
    }
  });
}

function textFromRequestBody(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "testbed response";
  }
  const input = (body as { input?: unknown }).input;
  if (typeof input === "string" && input.trim()) {
    return `testbed response: ${input.trim()}`;
  }
  const messages = (body as { messages?: unknown }).messages;
  if (Array.isArray(messages)) {
    const last = messages.at(-1);
    if (last && typeof last === "object" && !Array.isArray(last)) {
      const content = (last as { content?: unknown }).content;
      if (typeof content === "string" && content.trim()) {
        return `testbed response: ${content.trim()}`;
      }
    }
  }
  return "testbed response";
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export function createTestbedLlmGatewayHandler(
  requests: TestbedLlmGatewayRequest[] = []
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    requests.push({
      method: request.method,
      pathname: url.pathname,
      authorization: request.headers.get("authorization")
    });
    if (url.pathname === "/healthz") {
      return new Response("ok");
    }
    if (url.pathname === "/v1/models") {
      return json({
        object: "list",
        data: [
          {
            id: "gpt-5.4",
            object: "model",
            owned_by: "burble-testbed"
          }
        ]
      });
    }
    if (url.pathname === "/v1/responses" && request.method === "POST") {
      const body = await readJson(request);
      const text = textFromRequestBody(body);
      return json({
        id: `resp_testbed_${crypto.randomUUID().replaceAll("-", "")}`,
        object: "response",
        status: "completed",
        model: "gpt-5.4",
        output_text: text,
        output: [
          {
            id: "msg_testbed",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text
              }
            ]
          }
        ],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2
        }
      });
    }
    if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      const body = await readJson(request);
      return json({
        id: `chatcmpl_testbed_${crypto.randomUUID().replaceAll("-", "")}`,
        object: "chat.completion",
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: textFromRequestBody(body)
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2
        }
      });
    }
    if (url.pathname === "/api/show") {
      return json({
        model: "gpt-5.4",
        details: {
          family: "testbed"
        }
      });
    }
    return new Response("not found", { status: 404 });
  };
}

export function startTestbedLlmGateway(input: {
  port?: number;
  hostname?: string;
} = {}): TestbedLlmGateway {
  const requests: TestbedLlmGatewayRequest[] = [];
  const server = Bun.serve({
    port: input.port ?? 0,
    hostname: input.hostname ?? "127.0.0.1",
    fetch: createTestbedLlmGatewayHandler(requests)
  });

  return {
    get port() {
      return server.port ?? input.port ?? 0;
    },
    requests,
    stop() {
      server.stop(true);
    }
  };
}

if (import.meta.main) {
  const server = startTestbedLlmGateway({
    port: Number.parseInt(Bun.env.PORT ?? "4000", 10),
    hostname: "0.0.0.0"
  });
  console.log(`Testbed LLM gateway listening on http://0.0.0.0:${server.port}`);
}
