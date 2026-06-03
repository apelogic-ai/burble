import { describe, expect, test } from "bun:test";
import { selectRuntimeToolGroups } from "../../src/agent/tool-groups";

describe("selectRuntimeToolGroups", () => {
  test("keeps general chat to the conversation group", () => {
    expect(selectRuntimeToolGroups({ text: "hello again" })).toEqual({
      groups: ["conversation"],
      reasons: ["default:conversation"]
    });
  });

  test("selects provider groups from request text", () => {
    expect(
      selectRuntimeToolGroups({
        text: "create a cron job to check my latest GitHub PRs every hour"
      })
    ).toEqual({
      groups: ["conversation", "github", "scheduler"],
      reasons: [
        "default:conversation",
        "keyword:github:github",
        "keyword:github:pr",
        "keyword:scheduler:cron",
        "keyword:scheduler:every"
      ]
    });
  });

  test("selects Google and Jira without enabling unrelated providers", () => {
    expect(
      selectRuntimeToolGroups({
        text: "summarize this Google Doc and create a Jira ticket"
      })
    ).toEqual({
      groups: ["conversation", "google", "jira"],
      reasons: [
        "default:conversation",
        "keyword:google:google",
        "keyword:google:doc",
        "keyword:jira:jira",
        "keyword:jira:ticket"
      ]
    });
  });

  test("selects HubSpot from CRM language", () => {
    expect(
      selectRuntimeToolGroups({
        text: "find deals and contacts in HubSpot for Acme"
      })
    ).toEqual({
      groups: ["conversation", "hubspot"],
      reasons: [
        "default:conversation",
        "keyword:hubspot:hubspot",
        "keyword:hubspot:contact",
        "keyword:hubspot:contacts",
        "keyword:hubspot:deal",
        "keyword:hubspot:deals"
      ]
    });
  });

  test("selects attachment group when files are present", () => {
    expect(
      selectRuntimeToolGroups({
        text: "summarize this",
        attachmentCount: 1
      })
    ).toEqual({
      groups: ["attachments", "conversation"],
      reasons: ["default:conversation", "metadata:attachments"]
    });
  });

  test("allows workspace policy to remove selected groups", () => {
    expect(
      selectRuntimeToolGroups({
        text: "list my latest GitHub PRs and Jira tickets",
        allowedGroups: ["conversation", "github"]
      })
    ).toEqual({
      groups: ["conversation", "github"],
      reasons: [
        "default:conversation",
        "keyword:github:github",
        "keyword:github:pr"
      ]
    });
  });
});
