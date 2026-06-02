import { describe, expect, test } from "bun:test";
import { createAgentRunnerFromRuntimeAdapter } from "../../src/agent/runtime-adapter";
import { collectAgentRun, type AgentInput } from "../../src/agent/types";

const input: AgentInput = {
  principal: {
    workspaceId: "T123",
    slackUserId: "U123"
  },
  text: "hello",
  connections: {
    github: null
  }
};

describe("createAgentRunnerFromRuntimeAdapter", () => {
  test("wraps a runtime adapter as an agent runner", async () => {
    const seenEvents: string[] = [];
    const runner = createAgentRunnerFromRuntimeAdapter({
      name: "test-runtime",
      capabilities: {
        streaming: true,
        toolEvents: true,
        remote: true,
        requiresToolGateway: true
      },
      async *run() {
        yield { type: "status", text: "starting" };
        yield {
          type: "final",
          response: {
            classification: "user_private",
            text: "done"
          }
        };
      }
    });

    const output = await collectAgentRun(runner, input, (event) => {
      seenEvents.push(event.type);
    });

    expect(runner.name).toBe("test-runtime");
    expect(runner.capabilities.remote).toBe(true);
    expect(seenEvents).toEqual(["status"]);
    expect(output.text).toBe("done");
  });
});
