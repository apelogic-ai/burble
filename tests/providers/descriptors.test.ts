import { describe, expect, test } from "bun:test";
import { providerToolCatalog } from "../../src/providers/catalog";
import {
  connectedProviderIds,
  connectionProviderForToolName,
  isConnectedProviderId,
  isProviderDescriptorId,
  providerDescriptor,
  providerDescriptorIds,
  providerDescriptors
} from "../../src/providers/descriptors";

describe("provider descriptors", () => {
  test("centralize provider ids and connection-backed providers", () => {
    expect(providerDescriptorIds).toEqual([
      "github",
      "google",
      "hubspot",
      "jira",
      "slack",
      "atlassian"
    ]);
    expect(connectedProviderIds).toEqual([
      "github",
      "google",
      "hubspot",
      "jira",
      "slack"
    ]);
    expect(isProviderDescriptorId("atlassian")).toBe(true);
    expect(isConnectedProviderId("atlassian")).toBe(false);
    expect(isConnectedProviderId("google")).toBe(true);
  });

  test("derives the provider tool catalog from descriptor tools", () => {
    expect(providerToolCatalog).toEqual(
      providerDescriptors.flatMap((descriptor) => descriptor.tools)
    );
    expect(providerToolCatalog.map((tool) => tool.provider)).toEqual(
      providerDescriptors.flatMap((descriptor) =>
        descriptor.tools.map(() => descriptor.id)
      )
    );
  });

  test("looks up descriptors and provider-backed tool prefixes", () => {
    expect(providerDescriptor("google")?.title).toBe("Google");
    expect(providerDescriptor("unknown")).toBeNull();

    expect(connectionProviderForToolName("github.searchIssues")).toBe("github");
    expect(connectionProviderForToolName("gmail.createDraft")).toBe("google");
    expect(connectionProviderForToolName("google.slidesGetPresentation")).toBe(
      "google"
    );
    expect(connectionProviderForToolName("hubspot.searchContacts")).toBe(
      "hubspot"
    );
    expect(connectionProviderForToolName("jira.searchIssues")).toBe("jira");
    expect(connectionProviderForToolName("atlassian.callMcpTool")).toBe("jira");
    expect(connectionProviderForToolName("conversation.sendMessage")).toBeNull();
  });
});
