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
        text: "find HubSpot deals and HubSpot contacts for Acme"
      })
    ).toEqual({
      groups: ["conversation", "hubspot"],
      reasons: [
        "default:conversation",
        "keyword:hubspot:hubspot",
        "keyword:hubspot:hubspot contact",
        "keyword:hubspot:hubspot contacts",
        "keyword:hubspot:hubspot deal",
        "keyword:hubspot:hubspot deals"
      ]
    });
  });

  test("selects HubSpot for HubSpot user and owner language", () => {
    expect(
      selectRuntimeToolGroups({
        text: "list all HubSpot users and HubSpot owners"
      })
    ).toEqual({
      groups: ["conversation", "hubspot"],
      reasons: [
        "default:conversation",
        "keyword:hubspot:hubspot",
        "keyword:hubspot:hubspot user",
        "keyword:hubspot:hubspot users",
        "keyword:hubspot:hubspot owner",
        "keyword:hubspot:hubspot owners"
      ]
    });
  });

  test("does not select HubSpot for generic contact, company, or deal language", () => {
    expect(
      selectRuntimeToolGroups({
        text: "contact Leo about the company plan and deal with the deploy note"
      })
    ).toEqual({
      groups: ["conversation"],
      reasons: ["default:conversation"]
    });
  });

  test("selects HubSpot for CRM follow-up language when recent context names HubSpot", () => {
    expect(
      selectRuntimeToolGroups({
        text: "ok let's start with the 3 most recent companies",
        contextTexts: [
          "Do you mean the 3 most recent companies, contacts, or deals in HubSpot?"
        ]
      })
    ).toEqual({
      groups: ["conversation", "hubspot"],
      reasons: [
        "default:conversation",
        "context:hubspot:hubspot:companies"
      ]
    });
  });

  test("selects Google for file follow-up language when recent context names Drive", () => {
    expect(
      selectRuntimeToolGroups({
        text: "open the newest file",
        contextTexts: ["I found three matching Google Drive files."]
      })
    ).toEqual({
      groups: ["conversation", "google"],
      reasons: ["default:conversation", "context:google:google:file"]
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
