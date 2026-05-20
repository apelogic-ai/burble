import { describe, expect, test } from "bun:test";
import { runBurbleRequest } from "../../../runtimes/openclaw-nemoclaw/src/runner";
import type { RuntimeConfig } from "../../../runtimes/openclaw-nemoclaw/src/config";

const config: RuntimeConfig = {
  port: 8080,
  toolGatewayUrl: "http://burble-app:3000/internal/tools",
  internalToken: "secret",
  engine: "deterministic",
  openClawCommand: "openclaw",
  openClawAgent: "main",
  openClawTimeoutMs: 60000
};

describe("runBurbleRequest", () => {
  test("asks the user to connect GitHub when no connection summary is present", async () => {
    const calls: string[] = [];
    const response = await runBurbleRequest(
      {
        input: {
          text: "summarize my GitHub work",
          connections: {
            github: { connected: false }
          }
        }
      },
      config,
      async (toolName) => {
        calls.push(toolName);
        throw new Error("unexpected");
      }
    );

    expect(calls).toEqual([]);
    expect(response).toEqual({
      response: {
        classification: "user_private",
        text: "Connect GitHub first: `@Burble connect github`."
      }
    });
  });

  test("answers identity requests through the Burble tool gateway", async () => {
    const calls: Array<{ toolName: string; body: unknown }> = [];
    const response = await runBurbleRequest(
      {
        input: {
          text: "who am I on GitHub?",
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
      async (toolName, body) => {
        calls.push({ toolName, body });
        return {
          classification: "user_private",
          content: { login: "octocat" }
        };
      }
    );

    expect(calls).toEqual([
      {
        toolName: "github.getAuthenticatedUser",
        body: { user: { email: "person@example.com" } }
      }
    ]);
    expect(response.response.text).toBe("Authenticated to GitHub as `octocat`.");
    expect(response.response.classification).toBe("user_private");
  });

  test("summarizes issues and pull requests through gateway tools", async () => {
    const toolNames: string[] = [];
    const response = await runBurbleRequest(
      {
        input: {
          text: "summarize my GitHub work",
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
        toolNames.push(toolName);
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
          content: [
            {
              title: "Add workspace auth",
              url: "https://github.com/acme/app/pull/2"
            }
          ]
        };
      }
    );

    expect(toolNames).toEqual([
      "github.listAssignedIssues",
      "github.listMyPullRequests"
    ]);
    expect(response.response.text).toContain("GitHub work that needs attention");
    expect(response.response.text).toContain("Fix billing export");
    expect(response.response.text).toContain("Add workspace auth");
  });

  test("searches GitHub issues when the prompt asks for search", async () => {
    const calls: Array<{ toolName: string; body: unknown }> = [];
    await runBurbleRequest(
      {
        input: {
          text: "search github issues for billing regressions",
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
      async (toolName, body) => {
        calls.push({ toolName, body });
        return {
          classification: "user_private",
          content: []
        };
      }
    );

    expect(calls).toEqual([
      {
        toolName: "github.searchIssues",
        body: {
          user: { email: "person@example.com" },
          input: { query: "is:issue billing regressions" }
        }
      }
    ]);
  });
});
