import {
  createRuntimeContractWebSocket,
  type RuntimeContractWebSocket,
  type RuntimeContractWebSocketFactory,
  type RuntimeContractWebSocketOptions
} from "@burble/runtime-sdk/runtime-contract-http-client";
import WebSocket from "ws";
import {
  isOpenShellVirtualEndpoint,
  routeRuntimeEndpointWebSocket,
  type RuntimeEndpointRouteOptions
} from "./runtime-endpoint-routing";

export function createRoutedRuntimeWebSocketFactory(
  routeOptions: RuntimeEndpointRouteOptions
): RuntimeContractWebSocketFactory {
  return (url, options) => {
    const routed = routeRuntimeEndpointWebSocket(url, options, routeOptions);
    return isOpenShellVirtualEndpoint(url)
      ? createWsPackageRuntimeWebSocket(routed.url, routed.options)
      : createRuntimeContractWebSocket(routed.url, routed.options);
  };
}

export function createRoutedRuntimeWebSocket(
  url: string,
  options: RuntimeContractWebSocketOptions | undefined,
  routeOptions: RuntimeEndpointRouteOptions,
  fallbackFactory: RuntimeContractWebSocketFactory
): RuntimeContractWebSocket {
  const routed = routeRuntimeEndpointWebSocket(url, options, routeOptions);
  return isOpenShellVirtualEndpoint(url)
    ? createWsPackageRuntimeWebSocket(routed.url, routed.options)
    : fallbackFactory(routed.url, routed.options);
}

function createWsPackageRuntimeWebSocket(
  url: string,
  options?: RuntimeContractWebSocketOptions
): RuntimeContractWebSocket {
  const socket = new WebSocket(url, {
    headers: toWsHeaders(options?.headers)
  });
  return {
    addEventListener(type, listener) {
      if (type === "message") {
        socket.on("message", (data) => {
          listener({ data: data.toString() });
        });
        return;
      }
      if (type === "error") {
        socket.on("error", () => listener({}));
        return;
      }
      socket.on("close", () => listener({}));
    },
    close() {
      socket.close();
    }
  };
}

function toWsHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const record = toHeaderRecord(headers);
  const host = record.host ?? record.Host;
  delete record.host;
  delete record.Host;
  return host ? { ...record, Host: host } : record;
}

function toHeaderRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}
