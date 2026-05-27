import type { RuntimeConfig } from "./config";
import { createBurbleToolExecutor } from "./burble-tools";
import { info } from "./logger";
import type { RunRequest, ToolResult } from "./types";

export type BurbleConversationRoute = {
  routeId: string;
};

export type BurbleConversationMessage = BurbleConversationRoute & {
  text: string;
};

export type BurbleConversationEvent = BurbleConversationRoute & {
  payload: unknown;
};

export type BurbleConversationDeliveryTarget = {
  channel: "burble";
  routeId: string;
  localMessageUrl: string;
  localEventUrl: string;
};

export type BurbleConversationConnector = {
  describeDeliveryTarget(route: BurbleConversationRoute): BurbleConversationDeliveryTarget;
  sendMessage(message: BurbleConversationMessage): Promise<ToolResult>;
  deliverEvent(event: BurbleConversationEvent): Promise<ToolResult | null>;
};

export function createBurbleConversationConnector(
  config: RuntimeConfig,
  runtimeId: string,
  request?: RunRequest
): BurbleConversationConnector {
  const executor = createBurbleToolExecutor(config, runtimeId, request);
  const sendMessage = async (
    message: BurbleConversationMessage
  ): Promise<ToolResult> => {
    info(
      `Burble conversation connector send routeId=${message.routeId} textChars=${message.text.length}`
    );
    const result = await executor("conversation.sendMessage", {
      input: {
        routeId: message.routeId,
        text: message.text
      }
    });
    info(`Burble conversation connector sent routeId=${message.routeId}`);
    return result;
  };

  return {
    describeDeliveryTarget(route) {
      return buildBurbleConversationDeliveryTarget(config, route.routeId);
    },
    sendMessage,
    async deliverEvent(event) {
      const text = extractBurbleConversationText(event.payload);
      if (!text) {
        info(
          `Burble conversation connector ignored routeId=${event.routeId} reason=no_deliverable_text keys=${formatObjectKeys(event.payload)}`
        );
        return null;
      }

      return sendMessage({
        routeId: event.routeId,
        text
      });
    }
  };
}

export function buildBurbleConversationDeliveryTarget(
  config: RuntimeConfig,
  routeId: string
): BurbleConversationDeliveryTarget {
  const encodedRouteId = encodeURIComponent(routeId);
  return {
    channel: "burble",
    routeId,
    localMessageUrl: `http://127.0.0.1:${config.port}/internal/burble/channel/routes/${encodedRouteId}/messages`,
    localEventUrl: `http://127.0.0.1:${config.port}/internal/burble/channel/routes/${encodedRouteId}/events`
  };
}

export function extractBurbleConversationText(body: unknown): string | null {
  const candidates = [
    readNestedString(body, "summary"),
    readNestedString(body, "text"),
    readNestedString(body, "message"),
    readNestedString(body, "output"),
    readNestedString(body, "reply"),
    readNestedString(body, "result", "summary"),
    readNestedString(body, "result", "text"),
    readNestedString(body, "result", "output"),
    readNestedString(body, "event", "summary"),
    readNestedString(body, "event", "text"),
    readNestedString(body, "payload", "summary"),
    readNestedString(body, "payload", "text"),
    readNestedString(body, "response", "text"),
    readNestedString(body, "response", "summary")
  ];
  for (const candidate of candidates) {
    if (candidate) {
      return candidate.length > 4000 ? `${candidate.slice(0, 3997)}...` : candidate;
    }
  }

  return null;
}

export function formatObjectKeys(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "none";
  }

  return Object.keys(body).slice(0, 12).join(",") || "none";
}

function readNestedString(body: unknown, ...path: string[]): string | null {
  let cursor = body;
  for (const segment of path) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      return null;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }

  return typeof cursor === "string" && cursor.trim().length > 0
    ? cursor.trim()
    : null;
}
