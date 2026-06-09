import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "../config";
import type { ConversationAttachment } from "./types";

const capabilityPrefix = "attcap_";
const defaultTtlMs = 15 * 60 * 1000;

type AttachmentCapabilityPayload = {
  v: 1;
  runtimeId: string;
  runId: string;
  source: "slack";
  externalId: string;
  exp: number;
};

export type ResolvedAttachmentCapability = {
  source: "slack";
  externalId: string;
};

export function sealRuntimeConversationAttachments(
  config: Config,
  input: {
    runtimeId: string;
    runId: string;
    attachments: ConversationAttachment[];
    nowMs?: number;
    ttlMs?: number;
  }
): ConversationAttachment[] {
  const nowMs = input.nowMs ?? Date.now();
  return input.attachments.map((attachment) => {
    const { externalId: _externalId, ...publicAttachment } = attachment;
    if (attachment.source !== "slack" || !attachment.externalId) {
      return publicAttachment;
    }

    return {
      ...publicAttachment,
      id: createConversationAttachmentCapability(config, {
        runtimeId: input.runtimeId,
        runId: input.runId,
        source: "slack",
        externalId: attachment.externalId,
        expiresAtMs: nowMs + (input.ttlMs ?? defaultTtlMs)
      })
    };
  });
}

export function createConversationAttachmentCapability(
  config: Config,
  input: {
    runtimeId: string;
    runId: string;
    source: "slack";
    externalId: string;
    expiresAtMs: number;
  }
): string {
  const payload: AttachmentCapabilityPayload = {
    v: 1,
    runtimeId: input.runtimeId,
    runId: input.runId,
    source: input.source,
    externalId: input.externalId,
    exp: Math.floor(input.expiresAtMs)
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(config, encodedPayload);
  return `${capabilityPrefix}${encodedPayload}.${signature}`;
}

export function resolveConversationAttachmentCapability(
  config: Config,
  input: {
    capabilityId: string;
    runtimeId: string;
    runId: string;
    nowMs?: number;
  }
): ResolvedAttachmentCapability | null {
  if (!input.capabilityId.startsWith(capabilityPrefix)) {
    return null;
  }

  const token = input.capabilityId.slice(capabilityPrefix.length);
  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) {
    return null;
  }

  const encodedPayload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!safeEqual(signature, sign(config, encodedPayload))) {
    return null;
  }

  const payload = parsePayload(encodedPayload);
  if (!payload) {
    return null;
  }

  if (payload.runtimeId !== input.runtimeId) {
    return null;
  }
  if (payload.runId !== input.runId) {
    return null;
  }
  if (payload.exp < (input.nowMs ?? Date.now())) {
    return null;
  }

  return {
    source: payload.source,
    externalId: payload.externalId
  };
}

function parsePayload(encodedPayload: string): AttachmentCapabilityPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  return parsed.v === 1 &&
    parsed.runtimeId &&
    typeof parsed.runtimeId === "string" &&
    typeof parsed.runId === "string" &&
    parsed.runId.trim().length > 0 &&
    parsed.source === "slack" &&
    typeof parsed.externalId === "string" &&
    parsed.externalId.trim().length > 0 &&
    typeof parsed.exp === "number" &&
    Number.isFinite(parsed.exp)
    ? {
        v: 1,
        runtimeId: parsed.runtimeId,
        runId: parsed.runId,
        source: "slack",
        externalId: parsed.externalId,
        exp: parsed.exp
      }
    : null;
}

function sign(config: Config, encodedPayload: string): string {
  return createHmac("sha256", capabilitySecret(config))
    .update(encodedPayload)
    .digest("base64url");
}

function capabilitySecret(config: Config): string {
  return (
    config.internalApiToken ??
    config.agentRuntimeTokenSecret ??
    config.slackBotToken
  );
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
