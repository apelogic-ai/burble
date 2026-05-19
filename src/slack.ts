import { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { Config } from "./config";
import { buildGitHubOAuthUrl, getGitHubUser, listAssignedIssues } from "./github";
import type { GitHubIssue } from "./github";
import type { TokenStore } from "./db";

export type SlackRuntime = {
  app: App;
  getSlackEmail: (userId: string) => Promise<string>;
};

export function createSlackRuntime(config: Config, store: TokenStore): SlackRuntime {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true
  });

  async function getSlackEmail(userId: string): Promise<string> {
    const info = await app.client.users.info({ user: userId });
    const email = info.user?.profile?.email;
    if (!email) {
      throw new Error(
        "Slack profile email is unavailable. Add users:read.email and reinstall the Slack app."
      );
    }
    return email;
  }

  app.command("/connect-github", async ({ ack, body, client, logger }) => {
    await ack();

    try {
      const userId = body.user_id;
      const state = store.createOAuthState(userId);
      const url = buildGitHubOAuthUrl(config, state);

      await client.chat.postMessage({
        channel: userId,
        text: `<${url}|Connect your GitHub account>`
      });
    } catch (error) {
      logger.error(error);
      await postEphemeralFailure(client, body.channel_id, body.user_id);
    }
  });

  app.command("/issues", async ({ ack, body, client, logger }) => {
    await ack();

    try {
      const email = await getSlackEmail(body.user_id);
      const user = store.getConnectedUserByEmail(email);

      if (!user) {
        await client.chat.postMessage({
          channel: body.channel_id,
          text: "Run `/connect-github` first."
        });
        return;
      }

      const issues = await listAssignedIssues(user.githubToken);

      await client.chat.postMessage({
        channel: body.channel_id,
        text: formatIssuesMessage(issues)
      });
    } catch (error) {
      logger.error(error);
      const text =
        error instanceof Error && error.message === "GITHUB_TOKEN_REJECTED"
          ? "GitHub token rejected. Run `/connect-github` to reconnect."
          : "I could not list your GitHub issues.";

      await client.chat.postMessage({
        channel: body.channel_id,
        text
      });
    }
  });

  app.command("/github-me", async ({ ack, body, client, logger }) => {
    await ack();

    try {
      const email = await getSlackEmail(body.user_id);
      const user = store.getConnectedUserByEmail(email);

      if (!user) {
        await client.chat.postMessage({
          channel: body.channel_id,
          text: "Run `/connect-github` first."
        });
        return;
      }

      const githubUser = await getGitHubUser(user.githubToken);

      await client.chat.postMessage({
        channel: body.channel_id,
        text: formatGitHubIdentityMessage(githubUser.login, email)
      });
    } catch (error) {
      logger.error(error);
      const text =
        error instanceof Error && error.message === "GitHub user lookup failed with 401"
          ? "GitHub token rejected. Run `/connect-github` to reconnect."
          : "I could not verify your GitHub identity.";

      await client.chat.postMessage({
        channel: body.channel_id,
        text
      });
    }
  });

  return { app, getSlackEmail };
}

export function formatIssuesMessage(issues: GitHubIssue[]): string {
  if (issues.length === 0) {
    return "No open issues assigned to you.";
  }

  return issues
    .map((issue) => `- <${issue.html_url}|${issue.title}>`)
    .join("\n");
}

export function formatGitHubIdentityMessage(
  githubLogin: string,
  slackEmail: string
): string {
  return `Authenticated to GitHub as \`${githubLogin}\` for Slack email ${slackEmail}.`;
}

async function postEphemeralFailure(
  client: WebClient,
  channel: string,
  user: string
): Promise<void> {
  await client.chat.postEphemeral({
    channel,
    user,
    text: "I could not start the GitHub connection flow."
  });
}
