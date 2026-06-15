import type { RuntimeConfig } from "./config";
import { createBurbleToolExecutor } from "./burble-tools";
import { info } from "./logger";
import type { ConversationAttachment, RunRequest, ToolResult } from "./types";

export type BurbleConversationRoute = {
  routeId: string;
  jobId?: string;
};

export type BurbleConversationMessage = BurbleConversationRoute & {
  text: string;
  attachments?: ConversationAttachment[];
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
  const sendMessage = async (
    message: BurbleConversationMessage
  ): Promise<ToolResult> => {
    info(
      `Burble conversation connector send routeId=${message.routeId} textChars=${message.text.length} attachments=${message.attachments?.length ?? 0}`
    );
    const executor = createBurbleToolExecutor(
      config,
      runtimeId,
      message.jobId ? requestWithScheduledDelivery(message) : request
    );
    const result = await executor("conversation.sendMessage", {
      input: {
        routeId: message.routeId,
        text: message.text,
        ...(message.attachments ? { attachments: message.attachments } : {})
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
      const attachments = extractBurbleConversationAttachments(event.payload);
      if (!text && !attachments.attachments?.length) {
        info(
          `Burble conversation connector ignored routeId=${event.routeId} reason=no_deliverable_text keys=${formatObjectKeys(event.payload)}`
        );
        return null;
      }

      return sendMessage({
        routeId: event.routeId,
        ...(event.jobId ? { jobId: event.jobId } : {}),
        text: text ?? "",
        ...attachments
      });
    }
  };
}

function requestWithScheduledDelivery(
  message: BurbleConversationMessage
): RunRequest {
  return {
    input: {
      text: "",
      connections: {
        github: {
          connected: false
        }
      },
      scheduledJob: {
        jobId: message.jobId ?? "",
        capabilityProfile: "scheduled_job",
        allowedTools: ["conversation.sendMessage"],
        routeId: message.routeId,
        stateRefs: [],
        visibilityPolicy: {}
      }
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

function extractBurbleConversationAttachments(
  body: unknown
): { attachments?: ConversationAttachment[] } {
  const candidates = [
    readNestedValue(body, "attachments"),
    readNestedValue(body, "files"),
    readNestedValue(body, "result", "attachments"),
    readNestedValue(body, "result", "files"),
    readNestedValue(body, "payload", "attachments"),
    readNestedValue(body, "payload", "files"),
    readNestedValue(body, "response", "attachments")
  ];

  for (const candidate of candidates) {
    if (isConversationAttachmentArray(candidate)) {
      return { attachments: candidate };
    }
  }

  return {};
}

export function formatObjectKeys(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "none";
  }

  return Object.keys(body).slice(0, 12).join(",") || "none";
}

function readNestedString(body: unknown, ...path: string[]): string | null {
  const cursor = readNestedValue(body, ...path);
  return typeof cursor === "string" && hasVisibleText(cursor)
    ? cursor.trim()
    : null;
}

function hasVisibleText(value: string): boolean {
  return value.replace(/[\s\p{Default_Ignorable_Code_Point}]/gu, "").length > 0;
}

function readNestedValue(body: unknown, ...path: string[]): unknown {
  let cursor = body;
  for (const segment of path) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      return null;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }

  return cursor;
}

function isConversationAttachmentArray(
  value: unknown
): value is ConversationAttachment[] {
  return Array.isArray(value) && value.every(isConversationAttachment);
}

function isConversationAttachment(value: unknown): value is ConversationAttachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.trim().length > 0 &&
    (record.kind === "file" ||
      record.kind === "image" ||
      record.kind === "audio" ||
      record.kind === "video") &&
    typeof record.mimeType === "string" &&
    record.mimeType.trim().length > 0 &&
    (record.source === "slack" ||
      record.source === "burble" ||
      record.source === "agent") &&
    optionalString(record.name) &&
    (record.sizeBytes === undefined ||
      (typeof record.sizeBytes === "number" &&
        Number.isFinite(record.sizeBytes) &&
        record.sizeBytes >= 0)) &&
    optionalString(record.externalId)
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}
