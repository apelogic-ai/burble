import { describe, expect, test } from "bun:test";
import {
  callUpstreamMcpTool,
  listUpstreamMcpTools
} from "../../src/mcp/upstream-http-client";

describe("upstream MCP HTTP client", () => {
  test("initializes a streamable HTTP session and lists tools", async () => {
    const requests: Request[] = [];
    const fetchStub = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const payload = await request.clone().json();

      if (payload.method === "initialize") {
        return Response.json(
          {
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {}
            }
          },
          { headers: { "mcp-session-id": "upstream-session" } }
        );
      }

      if (payload.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }

      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          tools: [
            {
              name: "searchJiraIssuesUsingJql",
              title: "Search Jira issues using JQL",
              description: "Search Jira issues visible to the user"
            }
          ]
        }
      });
    }) as typeof fetch;

    const tools = await listUpstreamMcpTools({
      url: "https://mcp.atlassian.test/v1/mcp",
      authorization: "Bearer atlassian-token",
      fetch: fetchStub
    });

    expect(tools).toEqual([
      {
        name: "searchJiraIssuesUsingJql",
        title: "Search Jira issues using JQL",
        description: "Search Jira issues visible to the user"
      }
    ]);
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer atlassian-token",
      "Bearer atlassian-token",
      "Bearer atlassian-token"
    ]);
    expect(requests[1].headers.get("mcp-session-id")).toBe("upstream-session");
    expect(requests[2].headers.get("mcp-session-id")).toBe("upstream-session");
  });

  test("parses SSE JSON-RPC responses", async () => {
    const fetchStub = (async (input, init) => {
      const request = new Request(input, init);
      const payload = await request.json();
      if (payload.method === "initialize") {
        return sseResponse({
          jsonrpc: "2.0",
          id: payload.id,
          result: { protocolVersion: "2025-06-18", capabilities: {} }
        });
      }
      if (payload.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }

      return sseResponse({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          content: [{ type: "text", text: "ok" }]
        }
      });
    }) as typeof fetch;

    const result = await callUpstreamMcpTool(
      {
        url: "https://mcp.example.test/mcp",
        authorization: "Bearer token",
        fetch: fetchStub
      },
      { name: "echo", arguments: { text: "ok" } }
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "ok" }]
    });
  });

  test("surfaces upstream MCP JSON-RPC errors", async () => {
    const fetchStub = (async (input, init) => {
      const request = new Request(input, init);
      const payload = await request.json();
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        error: {
          code: -32000,
          message: "token scope rejected"
        }
      });
    }) as typeof fetch;

    await expect(
      listUpstreamMcpTools({
        url: "https://mcp.example.test/mcp",
        authorization: "Bearer token",
        fetch: fetchStub
      })
    ).rejects.toThrow("Upstream MCP error: token scope rejected");
  });
});

function sseResponse(payload: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    headers: { "content-type": "text/event-stream" }
  });
}
