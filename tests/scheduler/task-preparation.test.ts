import { describe, expect, test } from "bun:test";
import {
  executeScheduledTaskPreparation,
  validateScheduledTaskPlan,
} from "../../src/scheduler/task-preparation";
import type { SchedulerTaskPlan } from "../../src/conversation/types";

describe("scheduled task preparation", () => {
  test("validates recurring and preparation tools against the provider catalog", () => {
    const plan = examplePlan();

    expect(validateScheduledTaskPlan(plan)).toEqual({ ok: true, errors: [] });
    expect(
      validateScheduledTaskPlan({
        ...plan,
        preparation: [
          {
            id: "invent",
            tool: "google_invent_document",
            input: {},
            saveAs: "document",
          },
        ],
      }),
    ).toEqual({
      ok: false,
      errors: [
        "Preparation step invent references unknown provider tool google_invent_document.",
      ],
    });
  });

  test("rejects invalid provider inputs before executing side effects", () => {
    expect(
      validateScheduledTaskPlan({
        steps: [
          { id: "report", instruction: "Return the result.", tools: [] },
        ],
        preparation: [
          {
            id: "create_doc",
            tool: "google_docs_create_document",
            input: {},
            saveAs: "document",
          },
        ],
      }),
    ).toEqual({
      ok: false,
      errors: [
        "Preparation step create_doc has invalid input for google_docs_create_document.",
      ],
    });
  });

  test("executes generic preparation calls and binds outputs into recurring steps", async () => {
    const calls: unknown[] = [];
    const result = await executeScheduledTaskPreparation({
      workspaceId: "T123",
      slackUserId: "U123",
      plan: examplePlan(),
      executeTool: async (input) => {
        calls.push(input);
        return {
          value: {
            id: "doc-123",
            name: "AI news topic history",
            webViewLink: "https://docs.google.com/document/d/doc-123/edit",
          },
          stateRef: {
            provider: "google",
            kind: "document",
            id: "doc-123",
            name: "AI news topic history",
            purpose: "Track previously reported topics",
          },
        };
      },
    });

    expect(calls).toEqual([
      {
        workspaceId: "T123",
        slackUserId: "U123",
        tool: "google_docs_create_document",
        input: { name: "AI news topic history" },
        purpose: "Track previously reported topics",
      },
    ]);
    expect(result).toEqual({
      prompt: [
        "1. Find current AI news and select the top five.",
        "2. Read doc-123, exclude known topics, and record new topics.",
        "3. Return only net-new results.",
      ].join("\n"),
      requiredTools: [
        "google_append_to_drive_text_file",
        "google_get_drive_file",
        "web_search",
      ],
      stateRefs: [
        {
          provider: "google",
          kind: "document",
          id: "doc-123",
          name: "AI news topic history",
          purpose: "Track previously reported topics",
        },
      ],
      resources: {
        dedupe_document: {
          id: "doc-123",
          name: "AI news topic history",
          webViewLink: "https://docs.google.com/document/d/doc-123/edit",
        },
      },
    });
  });

  test("supports unrelated preparation tools without task-specific branching", async () => {
    const plan: SchedulerTaskPlan = {
      preparation: [
        {
          id: "create_folder",
          tool: "google_create_drive_folder",
          input: { name: "Quarterly reports" },
          saveAs: "reports_folder",
          purpose: "Store generated reports",
        },
      ],
      steps: [
        {
          id: "save",
          instruction:
            "Save the generated report in folder {{resources.reports_folder.id}}.",
          tools: ["google_create_drive_text_file"],
        },
      ],
    };

    const result = await executeScheduledTaskPreparation({
      workspaceId: "T123",
      slackUserId: "U123",
      plan,
      executeTool: async () => ({
        value: { id: "folder-9", name: "Quarterly reports" },
        stateRef: {
          provider: "google",
          kind: "folder",
          id: "folder-9",
          name: "Quarterly reports",
          purpose: "Store generated reports",
        },
      }),
    });

    expect(result.prompt).toBe(
      "1. Save the generated report in folder folder-9.",
    );
    expect(result.requiredTools).toEqual(["google_create_drive_text_file"]);
  });

  test("renders camelCase preparation bindings", async () => {
    const result = await executeScheduledTaskPreparation({
      workspaceId: "T123",
      slackUserId: "U123",
      plan: {
        preparation: [
          {
            id: "createDedupState",
            tool: "google_create_drive_text_file",
            input: { name: "Open PR deduplication", text: "" },
            saveAs: "dedupState",
          },
        ],
        steps: [
          {
            id: "deduplicateAndRecord",
            instruction: "Use {{resources.dedupState.fileId}}.",
            tools: ["google_get_drive_file"],
          },
        ],
      },
      executeTool: async () => ({ value: { fileId: "state-123" } }),
    });

    expect(result.prompt).toBe("1. Use state-123.");
    expect(result.resources).toEqual({
      dedupState: { fileId: "state-123" },
    });
  });

  test("does not return a partial task when preparation fails", async () => {
    await expect(
      executeScheduledTaskPreparation({
        workspaceId: "T123",
        slackUserId: "U123",
        plan: examplePlan(),
        executeTool: async () => {
          throw new Error("provider unavailable");
        },
      }),
    ).rejects.toThrow("provider unavailable");
  });
});

function examplePlan(): SchedulerTaskPlan {
  return {
    preparation: [
      {
        id: "create_state",
        tool: "google_docs_create_document",
        input: { name: "AI news topic history" },
        saveAs: "dedupe_document",
        purpose: "Track previously reported topics",
      },
    ],
    steps: [
      {
        id: "collect",
        instruction: "Find current AI news and select the top five.",
        tools: ["web_search"],
      },
      {
        id: "deduplicate",
        instruction:
          "Read {{resources.dedupe_document.id}}, exclude known topics, and record new topics.",
        tools: [
          "google_get_drive_file",
          "google_append_to_drive_text_file",
        ],
      },
      {
        id: "report",
        instruction: "Return only net-new results.",
        tools: [],
      },
    ],
  };
}
