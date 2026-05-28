import type { Config } from "../../config";

export type SlackTokenSet = {
  accessToken: string;
  slackUserId: string;
  scope?: string;
};

export type SlackUser = {
  id: string;
  name?: string;
  realName?: string;
  displayName?: string;
  teamId?: string;
  deleted?: boolean;
  isBot?: boolean;
};

export type SlackMessageSearchResult = {
  channelId?: string;
  channelName?: string;
  userId?: string;
  username?: string;
  text: string;
  ts?: string;
  permalink?: string;
};

type SlackOAuthResponse = {
  ok?: boolean;
  error?: string;
  authed_user?: {
    id?: string;
    access_token?: string;
    scope?: string;
  };
};

type SlackUsersListResponse = {
  ok?: boolean;
  error?: string;
  members?: Array<{
    id?: string;
    name?: string;
    real_name?: string;
    deleted?: boolean;
    is_bot?: boolean;
    team_id?: string;
    profile?: {
      display_name?: string;
      real_name?: string;
      email?: string;
    };
  }>;
  response_metadata?: {
    next_cursor?: string;
  };
};

type SlackSearchMessagesResponse = {
  ok?: boolean;
  error?: string;
  messages?: {
    matches?: Array<{
      channel?: {
        id?: string;
        name?: string;
      };
      user?: string;
      username?: string;
      text?: string;
      ts?: string;
      permalink?: string;
    }>;
  };
};

export function buildSlackOAuthUrl(config: Config, state: string): string {
  if (!config.slackClientId || !config.slackClientSecret) {
    throw new Error("Slack OAuth is not configured");
  }

  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", config.slackClientId);
  url.searchParams.set("redirect_uri", config.slackRedirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("user_scope", "search:read users:read");
  return url.toString();
}

export async function exchangeSlackCode(
  config: Config,
  code: string
): Promise<SlackTokenSet> {
  if (!config.slackClientId || !config.slackClientSecret) {
    throw new Error("Slack OAuth is not configured");
  }

  const body = new URLSearchParams({
    client_id: config.slackClientId,
    client_secret: config.slackClientSecret,
    code,
    redirect_uri: config.slackRedirectUri
  });

  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  const payload = (await response.json()) as SlackOAuthResponse;
  const accessToken = payload.authed_user?.access_token;
  const slackUserId = payload.authed_user?.id;

  if (!response.ok || !payload.ok || !accessToken || !slackUserId) {
    throw new Error(payload.error ?? "Slack token exchange failed");
  }

  return {
    accessToken,
    slackUserId,
    ...(payload.authed_user?.scope ? { scope: payload.authed_user.scope } : {})
  };
}

export async function searchSlackUsers(
  token: string,
  query: string
): Promise<SlackUser[]> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  const matches: SlackUser[] = [];
  let cursor = "";

  for (let page = 0; page < 10 && matches.length < 10; page += 1) {
    const url = new URL("https://slack.com/api/users.list");
    url.searchParams.set("limit", "200");
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const response = await fetch(url, { headers: slackHeaders(token) });
    const payload = (await response.json()) as SlackUsersListResponse;
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error ?? `Slack user search failed with ${response.status}`);
    }

    for (const member of payload.members ?? []) {
      const user = slackUserFromMember(member);
      if (!user || !slackUserMatches(user, normalized)) {
        continue;
      }
      matches.push(user);
      if (matches.length >= 10) {
        break;
      }
    }

    cursor = payload.response_metadata?.next_cursor?.trim() ?? "";
    if (!cursor) {
      break;
    }
  }

  return matches;
}

export async function searchSlackMessages(
  token: string,
  input: {
    query: string;
    fromUserId?: string;
    inChannel?: string;
    limit?: number;
  }
): Promise<SlackMessageSearchResult[]> {
  const query = buildSlackSearchQuery(input);
  const url = new URL("https://slack.com/api/search.messages");
  url.searchParams.set("query", query);
  url.searchParams.set("sort", "timestamp");
  url.searchParams.set("sort_dir", "desc");
  url.searchParams.set("count", String(clampLimit(input.limit)));

  const response = await fetch(url, { headers: slackHeaders(token) });
  const payload = (await response.json()) as SlackSearchMessagesResponse;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error ?? `Slack message search failed with ${response.status}`);
  }

  return (payload.messages?.matches ?? []).map((match) => ({
    ...(match.channel?.id ? { channelId: match.channel.id } : {}),
    ...(match.channel?.name ? { channelName: match.channel.name } : {}),
    ...(match.user ? { userId: match.user } : {}),
    ...(match.username ? { username: match.username } : {}),
    text: sanitizeSlackSearchText(match.text),
    ...(match.ts ? { ts: match.ts } : {}),
    ...(match.permalink ? { permalink: match.permalink } : {})
  }));
}

function slackHeaders(token: string): HeadersInit {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`
  };
}

function slackUserFromMember(
  member: NonNullable<SlackUsersListResponse["members"]>[number]
): SlackUser | null {
  if (!member.id) {
    return null;
  }

  return {
    id: member.id,
    ...(member.name ? { name: member.name } : {}),
    ...(member.real_name ?? member.profile?.real_name
      ? { realName: member.real_name ?? member.profile?.real_name }
      : {}),
    ...(member.profile?.display_name
      ? { displayName: member.profile.display_name }
      : {}),
    ...(member.team_id ? { teamId: member.team_id } : {}),
    ...(typeof member.deleted === "boolean" ? { deleted: member.deleted } : {}),
    ...(typeof member.is_bot === "boolean" ? { isBot: member.is_bot } : {})
  };
}

function slackUserMatches(user: SlackUser, query: string): boolean {
  return [user.id, user.name, user.realName, user.displayName]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase().includes(query));
}

function buildSlackSearchQuery(input: {
  query: string;
  fromUserId?: string;
  inChannel?: string;
}): string {
  const parts = [input.query.trim()];
  const fromUserId = input.fromUserId?.trim();
  if (fromUserId) {
    parts.push(`from:<@${fromUserId.replace(/^<@|>$/g, "")}>`);
  }
  const channel = input.inChannel?.trim();
  if (channel) {
    parts.push(`in:${channel.replace(/^#/, "")}`);
  }
  return parts.filter(Boolean).join(" ");
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return 10;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), 20);
}

function sanitizeSlackSearchText(text: string | undefined): string {
  return text?.replace(/\s+/g, " ").trim() ?? "";
}
