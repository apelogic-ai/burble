import { describe, expect, test } from "bun:test";
import {
  runOpenClawCliRequest,
  runOpenClawCliRequestStream
} from "../../../runtimes/openclaw-nemoclaw/src/openclaw-cli";
import type { RuntimeConfig } from "../../../runtimes/openclaw-nemoclaw/src/config";

const config: RuntimeConfig = {
  port: 8080,
  toolGatewayUrl: "http://burble-app:3000/internal/tools",
  internalToken: "secret",
  mcpGatewayUrl: null,
  runtimeJwt: null,
  engine: "openclaw",
  openClawCommand: "openclaw",
  openClawAgent: "main",
  openClawTimeoutMs: 60000,
  openClawStateDir: "/data/openclaw/state",
  openClawConfigPath: "/data/openclaw/config/openclaw.json",
  openClawWorkspaceDir: "/data/openclaw/workspace",
  openClawSetupOnStart: true,
  openClawConfigPatchPath: null,
  openClawValidateOnStart: true,
  openClawStreamDebug: false
};

describe("runOpenClawCliRequest", () => {
  test("runs OpenClaw CLI with gateway-derived context", async () => {
    const commands: Array<{
      command: string;
      args: string[];
      env: Record<string, string>;
    }> = [];
    const logs: string[] = [];
    const response = await runOpenClawCliRequest(
      {
        input: {
          text: "prioritize my GitHub work",
          connections: {
            github: {
              connected: true,
              email: "person@example.com",
              providerLogin: "octocat"
            }
          }
        }
      },
      config,
      async (toolName) => {
        if (toolName === "github.listAssignedIssues") {
          return {
            classification: "user_private",
            content: [
              {
                title: "Fix billing export",
                url: "https://github.com/acme/app/issues/1"
              }
            ]
          };
        }

        return {
          classification: "user_private",
          content: []
        };
      },
      async (command, args, options) => {
        commands.push({ command, args, env: options.env ?? {} });
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            response: {
              text: "OpenClaw says fix billing first."
            }
          }),
          stderr: ""
        };
      },
      (message) => logs.push(message)
    );

    expect(response).toEqual({
      response: {
        classification: "user_private",
        text: "OpenClaw says fix billing first."
      }
    });
    expect(commands).toHaveLength(1);
    expect(commands[0].command).toBe("openclaw");
    expect(commands[0].args).toContain("agent");
    expect(commands[0].args).toContain("--agent");
    expect(commands[0].args).toContain("main");
    expect(commands[0].args).toContain("--local");
    expect(commands[0].args).toContain("--message");
    expect(commands[0].args).toContain("--session-id");
    expect(commands[0].args).toContain("burble-person_example.com");
    expect(commands[0].args.join(" ")).toContain("Fix billing export");
    expect(commands[0].args.join(" ")).not.toContain("secret");
    expect(commands[0].env).toEqual({
      OPENCLAW_STATE_DIR: "/data/openclaw/state",
      OPENCLAW_CONFIG_PATH: "/data/openclaw/config/openclaw.json"
    });
    expect(logs).toEqual([
      "OpenClaw agent start runId=unknown agent=main sessionId=burble-person_example.com textLength=25 classification=user_private",
      "OpenClaw agent finish runId=unknown classification=user_private textLength=32"
    ]);
  });

  test("does not invoke OpenClaw when GitHub is not connected", async () => {
    let called = false;
    const response = await runOpenClawCliRequest(
      {
        input: {
          text: "summarize my work",
          connections: {
            github: { connected: false }
          }
        }
      },
      config,
      async () => {
        throw new Error("unexpected tool call");
      },
      async () => {
        called = true;
        throw new Error("unexpected cli call");
      },
      () => undefined
    );

    expect(called).toBe(false);
    expect(response.response.text).toBe(
      "Connect GitHub first: `@Burble connect github`."
    );
  });

  test("invokes OpenClaw for general questions without GitHub tool context", async () => {
    const logs: string[] = [];
    const response = await runOpenClawCliRequest(
      {
        input: {
          text: "what is the weather like in San Francisco now?",
          connections: {
            github: {
              connected: true,
              email: "person@example.com",
              providerLogin: "octocat"
            }
          }
        }
      },
      config,
      async () => {
        throw new Error("unexpected tool call");
      },
      async (_command, args) => {
        expect(args.join(" ")).toContain(
          "No Burble tool context is needed for this request."
        );
        expect(args.join(" ")).toContain("Do not reveal hidden chain-of-thought");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            response: {
              text: "San Francisco is mild today."
            }
          }),
          stderr: ""
        };
      },
      (message) => logs.push(message)
    );

    expect(response.response.text).toBe("San Francisco is mild today.");
    expect(logs).toEqual([
      "OpenClaw agent start runId=unknown agent=main sessionId=burble-person_example.com textLength=46 classification=user_private",
      "OpenClaw agent finish runId=unknown classification=user_private textLength=28"
    ]);
  });

  test("maps distinct Slack conversation roots to distinct OpenClaw sessions", async () => {
    const sessionIds: string[] = [];
    const baseRequest = {
      input: {
        text: "summarize this thread",
        connections: {
          github: {
            connected: true,
            email: "person@example.com",
            providerLogin: "octocat"
          }
        }
      }
    };

    for (const rootId of [
      "channel:C123:thread:1710000000.000100",
      "channel:C123:thread:1710000001.000100"
    ]) {
      await runOpenClawCliRequest(
        {
          ...baseRequest,
          input: {
            ...baseRequest.input,
            conversation: {
              source: "slack",
              workspaceId: "T123",
              channelId: "C123",
              rootId,
              isDirectMessage: false
            }
          }
        },
        config,
        async () => ({
          classification: "user_private",
          content: []
        }),
        async (_command, args) => {
          const sessionIndex = args.indexOf("--session-id") + 1;
          sessionIds.push(args[sessionIndex]);
          return {
            exitCode: 0,
            stdout: "Thread summary.",
            stderr: ""
          };
        },
        () => undefined
      );
    }

    expect(sessionIds).toHaveLength(2);
    expect(sessionIds[0]).toStartWith("burble-slack-");
    expect(sessionIds[1]).toStartWith("burble-slack-");
    expect(sessionIds[0]).not.toBe(sessionIds[1]);
    expect(sessionIds.join(" ")).not.toContain("person@example.com");
  });

  test("invokes OpenClaw for general questions before GitHub is connected", async () => {
    const response = await runOpenClawCliRequest(
      {
        input: {
          text: "what is a good lunch near me?",
          connections: {
            github: { connected: false }
          }
        }
      },
      config,
      async () => {
        throw new Error("unexpected tool call");
      },
      async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          response: {
            text: "I can help with general questions too."
          }
        }),
        stderr: ""
      }),
      () => undefined
    );

    expect(response.response.text).toBe("I can help with general questions too.");
  });

  test("surfaces OpenClaw CLI failures without leaking stderr", async () => {
    await expect(
      runOpenClawCliRequest(
        {
          input: {
            text: "summarize my work",
            connections: {
              github: {
                connected: true,
                email: "person@example.com"
              }
            }
          }
        },
        config,
        async () => ({
          classification: "user_private",
          content: []
        }),
        async () => ({
          exitCode: 2,
          stdout: "",
          stderr: "token leaked in stderr"
        }),
        () => undefined
      )
    ).rejects.toThrow("OpenClaw CLI exited with code 2");
  });

  test("streams OpenClaw stdout deltas before the final response", async () => {
    const events = [];

    for await (const event of runOpenClawCliRequestStream(
      {
        input: {
          text: "prioritize my GitHub work",
          connections: {
            github: {
              connected: true,
              email: "person@example.com",
              providerLogin: "octocat"
            }
          }
        }
      },
      config,
      async (toolName) =>
        toolName === "github.listAssignedIssues"
          ? {
              classification: "user_private",
              content: [
                {
                  title: "Fix billing export",
                  url: "https://github.com/acme/app/issues/1"
                }
              ]
            }
          : {
              classification: "user_private",
              content: []
            },
      async function* () {
        yield { type: "stdout" as const, text: "Security first.\n" };
        yield {
          type: "stdout" as const,
          text: JSON.stringify({ delta: "Then fix CI." }) + "\n"
        };
        yield {
          type: "stdout" as const,
          text: JSON.stringify({ response: { text: "Final ranking." } })
        };
        yield { type: "exit" as const, exitCode: 0 };
      },
      () => undefined
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "status", text: "Loading Burble context..." },
      { type: "status", text: "Running OpenClaw/NemoClaw..." },
      { type: "message_delta", text: "Security first." },
      { type: "message_delta", text: "Then fix CI." },
      {
        type: "final",
        response: {
          classification: "user_private",
          text: "Final ranking."
        }
      }
    ]);
  });

  test("logs stream debug details only when enabled", async () => {
    const logs: string[] = [];

    for await (const _event of runOpenClawCliRequestStream(
      {
        input: {
          text: "prioritize my GitHub work",
          connections: {
            github: {
              connected: true,
              email: "person@example.com",
              providerLogin: "octocat"
            }
          }
        }
      },
      { ...config, openClawStreamDebug: true },
      async () => ({
        classification: "user_private",
        content: []
      }),
      async function* () {
        yield {
          type: "stdout" as const,
          text: "partial sk-secretsecretsecret output\n"
        };
        yield { type: "exit" as const, exitCode: 0 };
      },
      (message) => logs.push(message)
    )) {
      // drain stream
    }

    expect(logs.some((line) => line.includes("OpenClaw stream debug"))).toBe(
      true
    );
    expect(logs.join("\n")).toContain("event=stdout chunk");
    expect(logs.join("\n")).toContain("event=delta parsed");
    expect(logs.join("\n")).toContain("[redacted-openai-key]");
    expect(logs.join("\n")).not.toContain("sk-secretsecretsecret");
  });

  test("emits heartbeat status events while waiting for OpenClaw stdout", async () => {
    const events = [];

    for await (const event of runOpenClawCliRequestStream(
      {
        runId: "run-heartbeat",
        input: {
          text: "prioritize my GitHub work",
          connections: {
            github: {
              connected: true,
              email: "person@example.com",
              providerLogin: "octocat"
            }
          }
        }
      },
      config,
      async () => ({
        classification: "user_private",
        content: []
      }),
      async function* () {
        await Bun.sleep(5);
        yield { type: "stdout" as const, text: "Final after wait." };
        yield { type: "exit" as const, exitCode: 0 };
      },
      () => undefined,
      1
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "status",
      text: "Still running OpenClaw... 0s"
    });
    expect(events.at(-1)).toEqual({
      type: "final",
      response: {
        classification: "user_private",
        text: "Final after wait."
      }
    });
  });
});
