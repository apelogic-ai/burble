import { describe, expect, test } from "bun:test";
import {
  McpGwUnauthorizedError,
  callMcpGwTool,
  listMcpGwTools
} from "../../src/mcp/mcp-gw-client";

describe("MCP-GW client", () => {
  test("initializes a bearer-authenticated session and lists tools", async () => {
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
          { headers: { "mcp-session-id": "mcp-gw-session" } }
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
              name: "google_slides_create_slide",
              title: "Create Google Slides slide",
              description: "Create a slide"
            }
          ]
        }
      });
    }) as typeof fetch;

    const tools = await listMcpGwTools({
      url: "https://18.210.100.44.nip.io/mcp",
      bearerToken: "burble-user-assertion",
      fetch: fetchStub
    });

    expect(tools).toEqual([
      {
        name: "google_slides_create_slide",
        title: "Create Google Slides slide",
        description: "Create a slide"
      }
    ]);
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer burble-user-assertion",
      "Bearer burble-user-assertion",
      "Bearer burble-user-assertion"
    ]);
    expect(requests[2].headers.get("mcp-session-id")).toBe("mcp-gw-session");
  });

  test("calls an MCP-GW tool", async () => {
    const fetchStub = (async (input, init) => {
      const request = new Request(input, init);
      const payload = await request.json();

      if (payload.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: payload.id,
          result: { protocolVersion: "2025-06-18", capabilities: {} }
        });
      }

      if (payload.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }

      expect(payload).toMatchObject({
        method: "tools/call",
        params: {
          name: "google_search_drive_files",
          arguments: { query: "qbr" }
        }
      });
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          content: [{ type: "text", text: "QBR deck" }]
        }
      });
    }) as typeof fetch;

    await expect(
      callMcpGwTool(
        {
          url: "https://18.210.100.44.nip.io/mcp",
          bearerToken: "burble-user-assertion",
          fetch: fetchStub
        },
        { name: "google_search_drive_files", arguments: { query: "qbr" } }
      )
    ).resolves.toEqual({
      status: "ok",
      result: {
        content: [{ type: "text", text: "QBR deck" }]
      }
    });
  });

  test("surfaces MCP-GW HOP-1 bearer challenges", async () => {
    const fetchStub = (async () =>
      new Response("Unauthorized", {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer resource_metadata="https://18.210.100.44.nip.io/.well-known/oauth-protected-resource"'
        }
      })) as unknown as typeof fetch;

    await expect(
      listMcpGwTools({
        url: "https://18.210.100.44.nip.io/mcp",
        bearerToken: "bad-assertion",
        fetch: fetchStub
      })
    ).rejects.toMatchObject({
      name: "McpGwUnauthorizedError",
      status: 401,
      wwwAuthenticate:
        'Bearer resource_metadata="https://18.210.100.44.nip.io/.well-known/oauth-protected-resource"',
      protectedResourceMetadataUrl:
        "https://18.210.100.44.nip.io/.well-known/oauth-protected-resource"
    } satisfies Partial<McpGwUnauthorizedError>);
  });

  test("maps MCP-GW reauth_required errors to a Google connect result", async () => {
    const fetchStub = (async (input, init) => {
      const request = new Request(input, init);
      const payload = await request.json();

      if (payload.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: payload.id,
          result: { protocolVersion: "2025-06-18", capabilities: {} }
        });
      }

      if (payload.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }

      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        error: {
          code: -32001,
          message: "Google Workspace reauthorization required",
          data: {
            code: "reauth_required",
            connectUrl: "https://18.210.100.44.nip.io/connect/google"
          }
        }
      });
    }) as typeof fetch;

    await expect(
      callMcpGwTool(
        {
          url: "https://18.210.100.44.nip.io/mcp",
          bearerToken: "burble-user-assertion",
          fetch: fetchStub
        },
        { name: "google_search_drive_files", arguments: { query: "qbr" } }
      )
    ).resolves.toEqual({
      status: "needs_google_connect",
      message: "Google Workspace reauthorization required",
      connectUrl: "https://18.210.100.44.nip.io/connect/google"
    });
  });
});
