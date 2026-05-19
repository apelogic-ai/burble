import { App } from "@slack/bolt";
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

  app.command("/connect-github", async ({ ack, body, logger }) => {
    try {
      logger.info(`Received /connect-github from ${body.user_id}`);
      const userId = body.user_id;
      const state = store.createOAuthState(userId);
      const url = buildGitHubOAuthUrl(config, state);

      await ack({
        response_type: "ephemeral",
        text: formatConnectGitHubMessage(url)
      });
    } catch (error) {
      logger.error(error);
      await ack({
        response_type: "ephemeral",
        text: "I could not start the GitHub connection flow."
      });
    }
  });

  app.command("/issues", async ({ ack, body, respond, logger }) => {
    logger.info(`Received /issues from ${body.user_id}`);
    await ack({
      response_type: "ephemeral",
      text: formatWorkingMessage("/issues")
    });

    try {
      const email = await getSlackEmail(body.user_id);
      const user = store.getConnectedUserByEmail(email);

      if (!user) {
        await respond({
          response_type: "ephemeral",
          text: "Run `/connect-github` first."
        });
        return;
      }

      const issues = await listAssignedIssues(user.githubToken);

      await respond({
        response_type: "ephemeral",
        text: formatIssuesMessage(issues)
      });
    } catch (error) {
      logger.error(error);
      const text =
        error instanceof Error && error.message === "GITHUB_TOKEN_REJECTED"
          ? "GitHub token rejected. Run `/connect-github` to reconnect."
          : "I could not list your GitHub issues.";

      await respond({
        response_type: "ephemeral",
        text
      });
    }
  });

  app.command("/github-me", async ({ ack, body, respond, logger }) => {
    logger.info(`Received /github-me from ${body.user_id}`);
    await ack({
      response_type: "ephemeral",
      text: formatWorkingMessage("/github-me")
    });

    try {
      const email = await getSlackEmail(body.user_id);
      const user = store.getConnectedUserByEmail(email);

      if (!user) {
        await respond({
          response_type: "ephemeral",
          text: "Run `/connect-github` first."
        });
        return;
      }

      const githubUser = await getGitHubUser(user.githubToken);

      await respond({
        response_type: "ephemeral",
        text: formatGitHubIdentityMessage(githubUser.login, email)
      });
    } catch (error) {
      logger.error(error);
      const text =
        error instanceof Error && error.message === "GitHub user lookup failed with 401"
          ? "GitHub token rejected. Run `/connect-github` to reconnect."
          : "I could not verify your GitHub identity.";

      await respond({
        response_type: "ephemeral",
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

export function formatConnectGitHubMessage(url: string): string {
  return `<${url}|Connect your GitHub account>`;
}

export function formatWorkingMessage(command: string): string {
  return `Working on \`${command}\`...`;
}
