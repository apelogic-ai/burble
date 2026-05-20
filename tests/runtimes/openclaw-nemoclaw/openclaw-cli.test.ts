import { describe, expect, test } from "bun:test";
import { runOpenClawCliRequest } from "../../../runtimes/openclaw-nemoclaw/src/openclaw-cli";
import type { RuntimeConfig } from "../../../runtimes/openclaw-nemoclaw/src/config";

const config: RuntimeConfig = {
  port: 8080,
  toolGatewayUrl: "http://burble-app:3000/internal/tools",
  internalToken: "secret",
  engine: "openclaw-cli",
  openClawCommand: "openclaw",
  openClawAgent: "main",
  openClawTimeoutMs: 60000
};

describe("runOpenClawCliRequest", () => {
  test("runs OpenClaw CLI with gateway-derived context", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
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
      async (command, args) => {
        commands.push({ command, args });
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            response: {
              text: "OpenClaw says fix billing first."
            }
          }),
          stderr: ""
        };
      }
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
    expect(commands[0].args.join(" ")).toContain("Fix billing export");
    expect(commands[0].args.join(" ")).not.toContain("secret");
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
      }
    );

    expect(called).toBe(false);
    expect(response.response.text).toBe(
      "Connect GitHub first: `@Burble connect github`."
    );
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
        })
      )
    ).rejects.toThrow("OpenClaw CLI exited with code 2");
  });
});
