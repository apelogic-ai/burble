import { describe, expect, test } from "bun:test";
import { runBurbleRequest } from "../../../runtimes/openclaw-nemoclaw/src/runner";
import type { RuntimeConfig } from "../../../runtimes/openclaw-nemoclaw/src/config";

const config: RuntimeConfig = {
  port: 8080,
  toolGatewayUrl: "http://burble-app:3000/internal/tools",
  internalToken: "secret",
  mcpGatewayUrl: null,
  runtimeJwt: null,
  engine: "deterministic",
  openClawCommand: "openclaw",
  openClawAgent: "main",
  openClawTimeoutMs: 60000,
  openClawStateDir: "/data/openclaw/state",
  openClawConfigPath: "/data/openclaw/config/openclaw.json",
  openClawWorkspaceDir: "/data/openclaw/workspace",
  openClawSetupOnStart: true,
  openClawConfigPatchPath: null,
  openClawValidateOnStart: true,
  openClawStreamDebug: false,
  openClawCodeMode: false,
  openClawRawStreamDebug: false,
  openClawGatewayPort: 18789,
  openClawGatewayBind: "loopback",
  openClawGatewayToken: "gateway-token",
  llmModel: "openai:gpt-5.4",
  ollamaBaseUrl: "https://ollama.com"
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

  test("returns generic context for non-GitHub questions", async () => {
    let called = false;
    const response = await runBurbleRequest(
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
        called = true;
        throw new Error("unexpected tool call");
      }
    );

    expect(called).toBe(false);
    expect(response).toEqual({
      response: {
        classification: "user_private",
        text: "No Burble tool context is needed for this request."
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

  test("passes GitHub pull request filters through deterministic provider requests", async () => {
    const calls: Array<{ toolName: string; body: unknown }> = [];
    await runBurbleRequest(
      {
        input: {
          text: "what is my latest open PR in example-org org?",
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
        toolName: "github.listMyPullRequests",
        body: {
          user: { email: "person@example.com" },
          input: {
            limit: 1,
            state: "open",
            sort: "updated",
            order: "desc",
            owner: "example-org"
          }
        }
      }
    ]);
  });

  test("asks the user to connect Jira when Jira context is requested without auth", async () => {
    const response = await runBurbleRequest(
      {
        input: {
          text: "what Jira tickets are assigned to me?",
          connections: {
            github: { connected: false },
            jira: { connected: false }
          }
        }
      },
      config,
      async () => {
        throw new Error("unexpected tool call");
      }
    );

    expect(response.response.text).toBe("Connect Jira first.");
  });

  test("summarizes Jira issues through gateway tools", async () => {
    const calls: Array<{ toolName: string; body: unknown }> = [];
    const response = await runBurbleRequest(
      {
        input: {
          text: "what Jira tickets are assigned to me?",
          connections: {
            github: { connected: false },
            jira: {
              connected: true,
              email: "person@example.com",
              providerLogin: "person@atlassian.example"
            }
          }
        }
      },
      config,
      async (toolName, body) => {
        calls.push({ toolName, body });
        return {
          classification: "user_private",
          content: [
            {
              key: "ENG-123",
              title: "Fix deploy dashboard",
              url: "https://example.atlassian.net/browse/ENG-123"
            }
          ]
        };
      }
    );

    expect(calls).toEqual([
      {
        toolName: "jira.listAssignedIssues",
        body: { user: { email: "person@example.com" } }
      }
    ]);
    expect(response.response.text).toContain("Assigned Jira issues");
    expect(response.response.text).toContain("Fix deploy dashboard");
  });

  test("lists Atlassian MCP tools through the Jira connection", async () => {
    const calls: Array<{ toolName: string; body: unknown }> = [];
    const response = await runBurbleRequest(
      {
        input: {
          text: "list Atlassian MCP tools",
          connections: {
            github: { connected: false },
            jira: {
              connected: true,
              email: "person@example.com",
              providerLogin: "person@atlassian.example"
            }
          }
        }
      },
      config,
      async (toolName, body) => {
        calls.push({ toolName, body });
        return {
          classification: "user_private",
          content: [
            {
              name: "searchJiraIssuesUsingJql",
              title: "Search Jira issues using JQL",
              description: "Search Jira issues visible to the user"
            }
          ]
        };
      }
    );

    expect(calls).toEqual([
      {
        toolName: "atlassian.listMcpTools",
        body: { user: { email: "person@example.com" } }
      }
    ]);
    expect(response.response.text).toContain("Atlassian MCP tools");
    expect(response.response.text).toContain("searchJiraIssuesUsingJql");
  });

  test("calls an explicit Atlassian MCP tool through the Jira connection", async () => {
    const calls: Array<{ toolName: string; body: unknown }> = [];
    const response = await runBurbleRequest(
      {
        input: {
          text: 'call Atlassian MCP tool searchJiraIssuesUsingJql with {"jql":"assignee = currentUser()"}',
          connections: {
            github: { connected: false },
            jira: {
              connected: true,
              email: "person@example.com",
              providerLogin: "person@atlassian.example"
            }
          }
        }
      },
      config,
      async (toolName, body) => {
        calls.push({ toolName, body });
        return {
          classification: "user_private",
          content: {
            toolName: "searchJiraIssuesUsingJql",
            result: {
              content: [
                {
                  type: "text",
                  text: "ECS-123 Fix dashboard"
                }
              ]
            }
          }
        };
      }
    );

    expect(calls).toEqual([
      {
        toolName: "atlassian.callMcpTool",
        body: {
          user: { email: "person@example.com" },
          input: {
            name: "searchJiraIssuesUsingJql",
            arguments: { jql: "assignee = currentUser()" }
          }
        }
      }
    ]);
    expect(response.response.text).toContain(
      "Atlassian MCP searchJiraIssuesUsingJql"
    );
    expect(response.response.text).toContain("ECS-123 Fix dashboard");
  });

  test("leaves natural language Jira actions for the agent to plan with MCP tools", async () => {
    const calls: Array<{ toolName: string; body: unknown }> = [];
    const response = await runBurbleRequest(
      {
        input: {
          text: "create new Jira ticket in DM workspace, titled 'test ticket from slack' and assign it to Alex Reviewer (alex.reviewer@example.com)",
          connections: {
            github: { connected: false },
            jira: {
              connected: true,
              email: "person@example.com",
              providerLogin: "person@atlassian.example"
            }
          }
        }
      },
      config,
      async (toolName, body) => {
        calls.push({ toolName, body });
        throw new Error("unexpected deterministic tool call");
      }
    );

    expect(calls).toEqual([]);
    expect(response.response.text).toContain("Use the available Atlassian MCP tools");
  });

  test("preserves plain text Jira tool output", async () => {
    const response = await runBurbleRequest(
      {
        input: {
          text: "what Jira tickets are assigned to me?",
          connections: {
            github: { connected: false },
            jira: {
              connected: true,
              email: "person@example.com",
              providerLogin: "person@atlassian.example"
            }
          }
        }
      },
      config,
      async () => ({
        classification: "user_private",
        content: "Jira assigned issues: none found."
      })
    );

    expect(response.response).toEqual({
      classification: "user_private",
      text: "Jira assigned issues: none found."
    });
  });

  test("searches Jira issues when the prompt asks for Jira search", async () => {
    const calls: Array<{ toolName: string; body: unknown }> = [];
    await runBurbleRequest(
      {
        input: {
          text: "search Jira tickets for deploy dashboard",
          connections: {
            github: { connected: false },
            jira: {
              connected: true,
              email: "person@example.com",
              providerLogin: "person@atlassian.example"
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
        toolName: "jira.searchIssues",
        body: {
          user: { email: "person@example.com" },
          input: { jql: 'text ~ "deploy dashboard"' }
        }
      }
    ]);
  });
});
