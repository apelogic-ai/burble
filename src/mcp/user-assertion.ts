import type { McpIdentityIssuer } from "../mcp-identity";

export type McpUserAssertionInput = {
  workspaceId: string;
  slackUserId: string;
  audience: string;
  issuer: McpIdentityIssuer;
  ttlSeconds?: number;
  getSlackEmail: (slackUserId: string) => Promise<string>;
};

export type McpUserAssertion = {
  token: string;
  subject: string;
  email: string;
};

const missingSlackEmailMessage =
  "Slack profile email is unavailable. Add users:read.email and reinstall the Slack app.";

export async function resolveMcpUserAssertion(
  input: McpUserAssertionInput
): Promise<McpUserAssertion> {
  const email = (await input.getSlackEmail(input.slackUserId)).trim();
  if (!email) {
    throw new Error(missingSlackEmailMessage);
  }

  const subject = `${input.workspaceId}:${input.slackUserId}`;
  return {
    subject,
    email,
    token: input.issuer.issueUserAssertion({
      audience: input.audience,
      subject,
      workspaceId: input.workspaceId,
      email,
      ttlSeconds: input.ttlSeconds
    })
  };
}
