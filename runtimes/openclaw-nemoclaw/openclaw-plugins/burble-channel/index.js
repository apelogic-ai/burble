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
  const body = {
    text: ctx.text,
    source: "openclaw-channel",
    accountId: account.accountId,
    threadId: ctx.threadId == null ? undefined : String(ctx.threadId),
    replyToId: ctx.replyToId ?? undefined
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
