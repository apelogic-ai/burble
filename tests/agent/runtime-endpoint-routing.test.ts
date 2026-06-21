import { describe, expect, test } from "bun:test";
import {
  isOpenShellVirtualEndpoint,
  routeRuntimeEndpointFetch,
  routeRuntimeEndpointWebSocket
} from "../../src/agent/runtime-endpoint-routing";

describe("runtime endpoint routing", () => {
  test("routes OpenShell virtual hosts through the configured dial host", async () => {
    const calls: Array<{ url: string; host: string | null }> = [];
    const routedFetch = routeRuntimeEndpointFetch(
      async (url, init) => {
        calls.push({
          url,
          host: new Headers(init?.headers).get("host")
        });
        return new Response("ok");
      },
      { openShellDialHost: "openshell" }
    );

    await routedFetch(
      "http://b-123--runtime.openshell.localhost:8080/healthz",
      {
        headers: {
          authorization: "Bearer runtime-token"
        }
      }
    );

    expect(calls).toEqual([
      {
        url: "http://openshell:8080/healthz",
        host: "b-123--runtime.openshell.localhost:8080"
      }
    ]);
  });

  test("throws clearly when an OpenShell virtual host is missing a dial host", async () => {
    const routedFetch = routeRuntimeEndpointFetch(
      async () => new Response("ok"),
      {}
    );

    expect(() =>
      routedFetch("http://b-123--runtime.openshell.localhost:8080/healthz")
    ).toThrow("AGENT_RUNTIME_OPENSHELL_DIAL_HOST is required");
  });

  test("leaves non-OpenShell endpoints untouched", async () => {
    const calls: Array<{ url: string; host: string | null }> = [];
    const routedFetch = routeRuntimeEndpointFetch(
      async (url, init) => {
        calls.push({
          url,
          host: new Headers(init?.headers).get("host")
        });
        return new Response("ok");
      },
      { openShellDialHost: "openshell" }
    );

    await routedFetch("http://burble-rt-123:8080/healthz");

    expect(calls).toEqual([
      {
        url: "http://burble-rt-123:8080/healthz",
        host: null
      }
    ]);
  });

  test("routes OpenShell websocket endpoints with the original host header", () => {
    const routed = routeRuntimeEndpointWebSocket(
      "ws://b-123--runtime.openshell.localhost:8080/runs/run-1/events",
      {
        headers: {
          authorization: "Bearer runtime-token"
        }
      },
      { openShellDialHost: "openshell" }
    );

    expect(routed.url).toBe("ws://openshell:8080/runs/run-1/events");
    expect(new Headers(routed.options?.headers).get("host")).toBe(
      "b-123--runtime.openshell.localhost:8080"
    );
    expect(new Headers(routed.options?.headers).get("authorization")).toBe(
      "Bearer runtime-token"
    );
  });

  test("detects OpenShell virtual endpoints", () => {
    expect(
      isOpenShellVirtualEndpoint(
        "http://b-123--runtime.openshell.localhost:8080/runs/run-1"
      )
    ).toBe(true);
    expect(isOpenShellVirtualEndpoint("http://burble-rt-123:8080/runs/run-1"))
      .toBe(false);
  });

  test("leaves non-OpenShell websocket endpoints untouched", () => {
    const routed = routeRuntimeEndpointWebSocket(
      "ws://burble-rt-123:8080/runs/run-1/events",
      {
        headers: {
          authorization: "Bearer runtime-token"
        }
      },
      {}
    );

    expect(routed.url).toBe("ws://burble-rt-123:8080/runs/run-1/events");
    expect(new Headers(routed.options?.headers).get("authorization")).toBe(
      "Bearer runtime-token"
    );
  });
});
