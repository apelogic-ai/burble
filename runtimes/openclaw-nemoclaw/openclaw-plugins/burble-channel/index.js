import {
  createChatChannelPlugin,
  createChannelPluginBase,
  defineChannelPluginEntry
} from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter
} from "openclaw/plugin-sdk/channel-message";

const CHANNEL_ID = "burble";
const DEFAULT_BASE_URL = "http://127.0.0.1:8080";

function readBurbleChannelConfig(cfg) {
  const channels = cfg && typeof cfg === "object" ? cfg.channels : undefined;
  const section =
    channels && typeof channels === "object" && !Array.isArray(channels)
      ? channels[CHANNEL_ID]
      : undefined;
  return section && typeof section === "object" && !Array.isArray(section)
    ? section
    : {};
}

function normalizeBaseUrl(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().replace(/\/+$/u, "")
    : DEFAULT_BASE_URL;
}

function resolveAccount(cfg, accountId = null) {
  const section = readBurbleChannelConfig(cfg);
  return {
    accountId,
    enabled: section.enabled !== false,
    baseUrl: normalizeBaseUrl(section.baseUrl)
  };
}

function inspectAccount(cfg, accountId = null) {
  const account = resolveAccount(cfg, accountId);
  return {
    enabled: account.enabled,
    configured: account.enabled,
    baseUrl: account.baseUrl
  };
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function classifyAttachmentKind(value, mimeType) {
  if (value === "file" || value === "image" || value === "audio" || value === "video") {
    return value;
  }
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("audio/")) {
    return "audio";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  return "file";
}

function normalizeAttachment(value, index) {
  if (!isObject(value)) {
    return null;
  }

  const mimeType =
    typeof value.mimeType === "string" && value.mimeType.trim()
      ? value.mimeType.trim()
      : typeof value.mimetype === "string" && value.mimetype.trim()
        ? value.mimetype.trim()
        : typeof value.type === "string" && value.type.includes("/")
          ? value.type.trim()
          : "application/octet-stream";
  const id =
    typeof value.id === "string" && value.id.trim()
      ? value.id.trim()
      : typeof value.externalId === "string" && value.externalId.trim()
        ? `agent:${value.externalId.trim()}`
        : `agent:attachment:${index}`;
  const attachment = {
    id,
    source:
      value.source === "slack" || value.source === "burble" || value.source === "agent"
        ? value.source
        : "agent",
    kind: classifyAttachmentKind(value.kind, mimeType),
    mimeType
  };

  if (typeof value.name === "string" && value.name.trim()) {
    attachment.name = value.name.trim();
  } else if (typeof value.filename === "string" && value.filename.trim()) {
    attachment.name = value.filename.trim();
  } else if (typeof value.title === "string" && value.title.trim()) {
    attachment.name = value.title.trim();
  }
  if (typeof value.sizeBytes === "number" && Number.isFinite(value.sizeBytes)) {
    attachment.sizeBytes = value.sizeBytes;
  } else if (typeof value.size === "number" && Number.isFinite(value.size)) {
    attachment.sizeBytes = value.size;
  }
  if (typeof value.externalId === "string" && value.externalId.trim()) {
    attachment.externalId = value.externalId.trim();
  }

  return attachment;
}

function extractBurbleAttachments(ctx) {
  const candidates = [
    ctx.attachments,
    ctx.files,
    ctx.media,
    isObject(ctx.message) ? ctx.message.attachments : undefined,
    isObject(ctx.payload) ? ctx.payload.attachments : undefined
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    const attachments = candidate
      .map((value, index) => normalizeAttachment(value, index))
      .filter(Boolean);
    if (attachments.length > 0) {
      return attachments;
    }
  }

  return [];
}

function extractBurbleJobId(ctx) {
  const candidates = [ctx.jobId, ctx.job_id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

async function sendBurbleMessage(ctx) {
  const account = resolveAccount(ctx.cfg, ctx.accountId ?? null);
  if (!account.enabled) {
    throw new Error("Burble channel is disabled");
  }
  if (!ctx.to || !String(ctx.to).trim()) {
    throw new Error("Burble channel delivery requires delivery.to route id");
  }

  const routeId = String(ctx.to).trim();
  const url = `${account.baseUrl}/internal/burble/channel/routes/${encodeURIComponent(
    routeId
  )}/messages`;
  const attachments = extractBurbleAttachments(ctx);
  const jobId = extractBurbleJobId(ctx);
  const text = typeof ctx.text === "string" ? ctx.text : "";
  if (!text.trim() && attachments.length === 0) {
    throw new Error("Burble channel delivery requires text or attachments");
  }

  const body = {
    text,
    source: "openclaw-channel",
    accountId: account.accountId,
    ...(jobId ? { jobId } : {}),
    threadId: ctx.threadId == null ? undefined : String(ctx.threadId),
    replyToId: ctx.replyToId ?? undefined,
    ...(attachments.length > 0 ? { attachments } : {})
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "openclaw-burble-channel"
    },
    body: JSON.stringify(body),
    signal: ctx.signal ?? undefined
  });
  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    throw new Error(
      `Burble channel delivery failed: ${response.status} ${responseText}`.trim()
    );
  }

  const messageId = `burble:${routeId}:${Date.now()}`;
  return {
    channel: CHANNEL_ID,
    conversationId: routeId,
    messageId
  };
}

const burbleMessageAdapter = defineChannelMessageAdapter({
  id: CHANNEL_ID,
  durableFinal: {
    capabilities: {
      text: true,
      thread: true,
      replyTo: true
    }
  },
  send: {
    text: async (ctx) => {
      const result = await sendBurbleMessage(ctx);
      return {
        messageId: result.messageId,
        receipt: createMessageReceiptFromOutboundResults({
          kind: "text",
          results: [result],
          threadId: ctx.threadId == null ? undefined : String(ctx.threadId),
          replyToId: ctx.replyToId ?? undefined
        })
      };
    }
  }
});

const base = createChannelPluginBase({
  id: CHANNEL_ID,
  meta: {
    label: "Burble",
    markdownCapable: true
  },
  capabilities: {
    chatTypes: ["direct", "channel", "thread"],
    reply: true,
    threads: true
  },
  config: {
    listAccountIds: () => ["default"],
    defaultAccountId: () => "default",
    resolveAccount,
    inspectAccount,
    isEnabled: (account) => account.enabled,
    isConfigured: (account) => account.enabled,
    describeAccount: (account) => ({
      accountId: account.accountId ?? "default",
      enabled: account.enabled,
      configured: account.enabled,
      tokenStatus: "available",
      label: "Burble local runtime"
    }),
    resolveDefaultTo: () => undefined
  },
  setup: {
    applyAccountConfig: ({ cfg, input }) => ({
      ...cfg,
      channels: {
        ...(cfg.channels ?? {}),
        [CHANNEL_ID]: {
          ...readBurbleChannelConfig(cfg),
          ...input,
          enabled: true
        }
      }
    })
  }
});

export const burblePlugin = createChatChannelPlugin({
  base: {
    ...base,
    message: burbleMessageAdapter
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async (ctx) => sendBurbleMessage(ctx)
  },
  threading: {
    topLevelReplyToMode: "thread"
  }
});

export default defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: "Burble",
  description: "Burble conversation route channel plugin",
  plugin: burblePlugin
});
