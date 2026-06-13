import { atlassianProviderToolSpecs } from "./atlassian/tool-specs";
import { githubProviderToolSpecs } from "./github/tool-specs";
import { googleProviderToolSpecs } from "./google/tool-specs";
import { hubspotProviderToolSpecs } from "./hubspot/tool-specs";
import { jiraProviderToolSpecs } from "./jira/tool-specs";
import { slackProviderToolSpecs } from "./slack/tool-specs";

export const providerDescriptors = [
  {
    id: "github",
    title: "GitHub",
    connectionTitle: "GitHub",
    connectable: true,
    connectionProvider: "github",
    authCommand: "github",
    authUrlInputKey: "githubUrl",
    missingConnectionText: "Connect GitHub first.",
    oauthNotConfiguredText: "GitHub OAuth is not configured.",
    usage:
      "Issues, pull requests, repository metadata and approved write actions",
    toolAliasPrefixes: ["github."],
    tools: githubProviderToolSpecs
  },
  {
    id: "google",
    title: "Google",
    connectionTitle: "Google Workspace",
    connectable: true,
    connectionProvider: "google",
    authCommand: "google",
    authUrlInputKey: "googleUrl",
    missingConnectionText: "Connect Google first: `/auth google`.",
    oauthNotConfiguredText: "Google OAuth is not configured.",
    usage: "Drive files, Calendar events, Gmail search and drafts",
    toolAliasPrefixes: ["google.", "gmail."],
    tools: googleProviderToolSpecs
  },
  {
    id: "hubspot",
    title: "HubSpot",
    connectionTitle: "HubSpot",
    connectable: true,
    connectionProvider: "hubspot",
    authCommand: "hubspot",
    authUrlInputKey: "hubspotUrl",
    missingConnectionText: "Connect HubSpot first: `/auth hubspot`.",
    oauthNotConfiguredText: "HubSpot OAuth is not configured.",
    usage: "CRM users, owners, contacts, companies, deals and scoped CRM records",
    toolAliasPrefixes: ["hubspot."],
    tools: hubspotProviderToolSpecs
  },
  {
    id: "jira",
    title: "Jira",
    connectionTitle: "Atlassian Jira",
    connectable: true,
    connectionProvider: "jira",
    authCommand: "jira",
    authUrlInputKey: "jiraUrl",
    missingConnectionText: "Connect Jira first.",
    oauthNotConfiguredText: "Jira OAuth is not configured.",
    usage: "Jira issues, projects, users, comments and approved workflow actions",
    toolAliasPrefixes: ["jira."],
    tools: jiraProviderToolSpecs
  },
  {
    id: "slack",
    title: "Slack",
    connectionTitle: "Slack search",
    connectable: true,
    connectionProvider: "slack",
    authCommand: "slack",
    authUrlInputKey: "slackUrl",
    missingConnectionText: "Connect Slack search first: `/auth slack`.",
    oauthNotConfiguredText: "Slack OAuth is not configured.",
    usage: "User search and message search through your Slack identity",
    toolAliasPrefixes: ["slack."],
    tools: slackProviderToolSpecs
  },
  {
    id: "atlassian",
    title: "Atlassian",
    connectable: false,
    connectionProvider: "jira",
    missingConnectionText: "Connect Jira first.",
    toolAliasPrefixes: ["atlassian."],
    tools: atlassianProviderToolSpecs
  }
] as const;

export type ProviderDescriptor = (typeof providerDescriptors)[number];
export type ProviderDescriptorId = ProviderDescriptor["id"];
export type ConnectedProviderId = Extract<
  ProviderDescriptor,
  { connectable: true }
>["id"];

export const providerDescriptorIds = providerDescriptors.map(
  (descriptor) => descriptor.id
) as ProviderDescriptorId[];

export const connectedProviderDescriptors = providerDescriptors.filter(
  (descriptor): descriptor is Extract<ProviderDescriptor, { connectable: true }> =>
    descriptor.connectable
);

export const connectedProviderIds = connectedProviderDescriptors.map(
  (descriptor) => descriptor.id
) as ConnectedProviderId[];

export function providerDescriptor(
  id: ProviderDescriptorId
): ProviderDescriptor;
export function providerDescriptor(id: string): ProviderDescriptor | null;
export function providerDescriptor(id: string): ProviderDescriptor | null {
  return (
    providerDescriptors.find((descriptor) => descriptor.id === id) ?? null
  );
}

export function isProviderDescriptorId(value: string): value is ProviderDescriptorId {
  return providerDescriptor(value) !== null;
}

export function isConnectedProviderId(value: string): value is ConnectedProviderId {
  return connectedProviderIds.includes(value as ConnectedProviderId);
}

export function connectionProviderForToolName(
  toolName: string
): ConnectedProviderId | null {
  const descriptor = providerDescriptors.find((candidate) =>
    candidate.toolAliasPrefixes.some((prefix) => toolName.startsWith(prefix))
  );
  return descriptor?.connectionProvider ?? null;
}
