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
    connectable: true,
    connectionProvider: "github",
    authCommand: "github",
    missingConnectionText: "Connect GitHub first.",
    toolAliasPrefixes: ["github."],
    tools: githubProviderToolSpecs
  },
  {
    id: "google",
    title: "Google",
    connectable: true,
    connectionProvider: "google",
    authCommand: "google",
    missingConnectionText: "Connect Google first: `/auth google`.",
    toolAliasPrefixes: ["google.", "gmail."],
    tools: googleProviderToolSpecs
  },
  {
    id: "hubspot",
    title: "HubSpot",
    connectable: true,
    connectionProvider: "hubspot",
    authCommand: "hubspot",
    missingConnectionText: "Connect HubSpot first: `/auth hubspot`.",
    toolAliasPrefixes: ["hubspot."],
    tools: hubspotProviderToolSpecs
  },
  {
    id: "jira",
    title: "Jira",
    connectable: true,
    connectionProvider: "jira",
    authCommand: "jira",
    missingConnectionText: "Connect Jira first.",
    toolAliasPrefixes: ["jira."],
    tools: jiraProviderToolSpecs
  },
  {
    id: "slack",
    title: "Slack",
    connectable: true,
    connectionProvider: "slack",
    authCommand: "slack",
    missingConnectionText: "Connect Slack search first: `/auth slack`.",
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

export const connectedProviderIds = providerDescriptors
  .filter((descriptor): descriptor is Extract<ProviderDescriptor, { connectable: true }> =>
    descriptor.connectable
  )
  .map((descriptor) => descriptor.id) as ConnectedProviderId[];

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
