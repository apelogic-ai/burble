import type { App } from "@slack/bolt";
import type { View } from "@slack/types";
import type { SlackRuntime } from "../slack";

export const testbedWorkspaceId = "T_TESTBED";
export const testbedUserId = "U_TESTBED";
export const testbedUserEmail = "testbed@example.test";
export const testbedDirectChannelId = "D_TESTBED";

type TestbedMessage = {
  channel: string;
  ts: string;
  text: string;
  user?: string;
  threadTs?: string;
  ephemeral?: boolean;
  blocks?: unknown[];
};

type TestbedSlackState = {
  messages: TestbedMessage[];
  homes: Record<string, View>;
  modals: Array<{ triggerId: string; view: unknown }>;
  streamEvents: unknown[];
  sequence: number;
};

export type SlackTestbed = {
  state: TestbedSlackState;
  client: App["client"];
  reset(): void;
  processMessage(input: {
    text: string;
    user?: string;
    channel?: string;
    team?: string;
    ts?: string;
  }): Promise<void>;
  processAppHomeOpened(input?: { user?: string; team?: string }): Promise<void>;
  processBlockAction(input: {
    actionId: string;
    value?: string;
    selectedValue?: string;
    user?: string;
    team?: string;
    triggerId?: string;
  }): Promise<void>;
};

export function installSlackTestbed(slack: SlackRuntime): SlackTestbed {
  const state: TestbedSlackState = {
    messages: [],
    homes: {},
    modals: [],
    streamEvents: [],
    sequence: 0
  };
  const client = createFakeSlackClient(state);

  // Bolt replaces the client with a WebClient when authorization returns a
  // bot token. In testbed mode we keep authorization tokenless so processEvent
  // drives the real listeners with this in-memory Slack client.
  const app = slack.app as unknown as {
    client: App["client"];
    authorize: (source: {
      teamId?: string;
      userId?: string;
      enterpriseId?: string;
    }) => Promise<{ teamId?: string; userId?: string; enterpriseId?: string }>;
  };
  app.client = client;
  app.authorize = async (source) => ({
    teamId: source.teamId ?? testbedWorkspaceId,
    userId: source.userId,
    enterpriseId: source.enterpriseId
  });

  return {
    state,
    client,
    reset() {
      state.messages = [];
      state.homes = {};
      state.modals = [];
      state.streamEvents = [];
      state.sequence = 0;
    },
    async processMessage(input) {
      await processBoltEvent(slack.app, messageEventBody(input));
    },
    async processAppHomeOpened(input = {}) {
      await processBoltEvent(slack.app, appHomeOpenedBody(input));
    },
    async processBlockAction(input) {
      await processBoltEvent(slack.app, blockActionBody(input));
    }
  };
}

export function summarizeSlackTestbed(state: TestbedSlackState): {
  messages: TestbedMessage[];
  homes: Record<string, View>;
  modals: Array<{ triggerId: string; view: unknown }>;
  streamEvents: unknown[];
} {
  return {
    messages: state.messages,
    homes: state.homes,
    modals: state.modals,
    streamEvents: state.streamEvents
  };
}

function createFakeSlackClient(state: TestbedSlackState): App["client"] {
  const nextTs = () => {
    state.sequence += 1;
    return `1700000000.${state.sequence.toString().padStart(6, "0")}`;
  };
  const findMessage = (channel: string, ts: string) =>
    state.messages.find((message) => message.channel === channel && message.ts === ts);

  return {
    users: {
      info: async ({ user }: { user: string }) => ({
        ok: true,
        user: {
          id: user,
          profile: {
            email: user === testbedUserId ? testbedUserEmail : `${user}@example.test`
          }
        }
      })
    },
    conversations: {
      history: async ({ channel }: { channel: string }) => ({
        ok: true,
        messages: state.messages
          .filter((message) => message.channel === channel && !message.ephemeral)
          .map((message) => ({
            text: message.text,
            ts: message.ts,
            user: message.user,
            bot_id: message.user ? undefined : "B_TESTBED"
          }))
          .reverse()
      })
    },
    chat: {
      postMessage: async (input: {
        channel: string;
        text?: string;
        thread_ts?: string;
        blocks?: unknown[];
      }) => {
        const ts = nextTs();
        state.messages.push({
          channel: input.channel,
          ts,
          text: input.text ?? "",
          threadTs: input.thread_ts,
          blocks: input.blocks
        });
        return { ok: true, ts, channel: input.channel };
      },
      update: async (input: {
        channel: string;
        ts: string;
        text?: string;
        blocks?: unknown[];
      }) => {
        const message = findMessage(input.channel, input.ts);
        if (message) {
          message.text = input.text ?? message.text;
          message.blocks = input.blocks ?? message.blocks;
        }
        return { ok: true, ts: input.ts, channel: input.channel };
      },
      postEphemeral: async (input: {
        channel: string;
        user: string;
        text?: string;
        thread_ts?: string;
        blocks?: unknown[];
      }) => {
        const ts = nextTs();
        state.messages.push({
          channel: input.channel,
          user: input.user,
          ts,
          text: input.text ?? "",
          threadTs: input.thread_ts,
          blocks: input.blocks,
          ephemeral: true
        });
        return { ok: true, message_ts: ts };
      },
      startStream: async (input: unknown) => {
        const ts = nextTs();
        state.streamEvents.push({ type: "start", ts, input });
        return { ok: true, ts };
      },
      appendStream: async (input: unknown) => {
        state.streamEvents.push({ type: "append", input });
        return { ok: true };
      },
      stopStream: async (input: unknown) => {
        state.streamEvents.push({ type: "stop", input });
        return { ok: true };
      }
    },
    views: {
      publish: async (input: { user_id: string; view: View }) => {
        state.homes[input.user_id] = input.view;
        return { ok: true };
      },
      open: async (input: { trigger_id: string; view: unknown }) => {
        state.modals.push({ triggerId: input.trigger_id, view: input.view });
        return { ok: true };
      }
    }
  } as unknown as App["client"];
}

async function processBoltEvent(app: App, body: Record<string, unknown>): Promise<void> {
  await app.processEvent({
    body,
    ack: async () => undefined
  });
}

function messageEventBody(input: {
  text: string;
  user?: string;
  channel?: string;
  team?: string;
  ts?: string;
}): Record<string, unknown> {
  const user = input.user ?? testbedUserId;
  const channel = input.channel ?? testbedDirectChannelId;
  const ts = input.ts ?? Date.now().toString();
  return {
    token: "testbed-token",
    team_id: input.team ?? testbedWorkspaceId,
    api_app_id: "A_TESTBED",
    type: "event_callback",
    event_id: `Ev${ts}`,
    event_time: Math.floor(Date.now() / 1000),
    event: {
      type: "message",
      channel_type: "im",
      channel,
      user,
      text: input.text,
      ts
    }
  };
}

function appHomeOpenedBody(input: {
  user?: string;
  team?: string;
}): Record<string, unknown> {
  const user = input.user ?? testbedUserId;
  return {
    token: "testbed-token",
    team_id: input.team ?? testbedWorkspaceId,
    api_app_id: "A_TESTBED",
    type: "event_callback",
    event_id: `EvHome${Date.now()}`,
    event_time: Math.floor(Date.now() / 1000),
    event: {
      type: "app_home_opened",
      user,
      channel: user,
      tab: "home",
      event_ts: Date.now().toString()
    }
  };
}

function blockActionBody(input: {
  actionId: string;
  value?: string;
  selectedValue?: string;
  user?: string;
  team?: string;
  triggerId?: string;
}): Record<string, unknown> {
  const action: Record<string, unknown> = {
    type: input.selectedValue ? "static_select" : "button",
    action_id: input.actionId,
    block_id: `${input.actionId}_block`
  };
  if (input.value) {
    action.value = input.value;
  }
  if (input.selectedValue) {
    action.selected_option = {
      text: { type: "plain_text", text: input.selectedValue },
      value: input.selectedValue
    };
  }

  return {
    type: "block_actions",
    team: { id: input.team ?? testbedWorkspaceId, domain: "testbed" },
    user: { id: input.user ?? testbedUserId, username: "testbed" },
    api_app_id: "A_TESTBED",
    token: "testbed-token",
    trigger_id: input.triggerId ?? "testbed-trigger",
    container: {
      type: "view",
      view_id: "V_TESTBED"
    },
    actions: [action]
  };
}
