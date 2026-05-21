import { describe, expect, test } from "bun:test";
import { collectAgentRun } from "../../src/agent/types";
import type { AgentRunner } from "../../src/agent/types";

const principal = {
  workspaceId: "T123",
  slackUserId: "U123"
};

describe("agent runner contract", () => {
  test("collects the final event from an event-based runner", async () => {
    const events: string[] = [];
    const runner: AgentRunner = {
      name: "stub",
      capabilities: {
        streaming: true,
        toolEvents: true,
        remote: false
      },
      async *run() {
        yield { type: "status", text: "Working..." };
        yield {
          type: "tool_call",
          toolName: "github_list_assigned_issues",
          callId: "call-1"
        };
        yield {
          type: "tool_result",
          toolName: "github_list_assigned_issues",
          callId: "call-1",
          classification: "user_private"
        };
        yield {
          type: "final",
          response: {
            classification: "user_private",
            text: "One issue needs attention."
          }
        };
      }
    };

    await expect(
      collectAgentRun(
        runner,
        {
          principal,
          text: "what needs attention?",
          connections: { github: null }
        },
        (event) => {
          events.push(event.type);
        }
      )
    ).resolves.toEqual({
      classification: "user_private",
      text: "One issue needs attention."
    });
    expect(events).toEqual(["status", "tool_call", "tool_result"]);
  });

  test("fails when a runner exits without a final response", async () => {
    const runner: AgentRunner = {
      name: "broken",
      capabilities: {
        streaming: false,
        toolEvents: false,
        remote: false
      },
      async *run() {
        yield { type: "status", text: "Working..." };
      }
    };

    await expect(
      collectAgentRun(runner, {
        principal,
        text: "hello",
        connections: { github: null }
      })
    ).rejects.toThrow("Agent runner broken finished without a final response");
  });
});
