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
  openClawStreamDebug: false,
  llmModel: "openai:gpt-5.4",
  ollamaBaseUrl: "https://ollama.com"
};

function readSessionIdArg(args: string[]): string {
  const index = args.indexOf("--session-id");
  expect(index).toBeGreaterThan(-1);
  return args[index + 1] ?? "";
}

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
    expect(readSessionIdArg(commands[0].args)).toStartWith("burble-step-");
    expect(readSessionIdArg(commands[0].args).length).toBeLessThanOrEqual(64);
    expect(commands[0].args.join(" ")).toContain("Fix billing export");
    expect(commands[0].args.join(" ")).not.toContain("secret");
    expect(commands[0].env).toEqual({
      OPENCLAW_STATE_DIR: "/data/openclaw/state",
      OPENCLAW_CONFIG_PATH: "/data/openclaw/config/openclaw.json"
    });
    expect(
      logs.some(
        (line) =>
          line.startsWith(
            "OpenClaw agent start runId=unknown agent=main sessionId=burble-run-"
          ) &&
          line.includes(" sessionScope=run textLength=25 classification=user_private")
      )
    ).toBe(true);
    expect(logs).toContain(
      "OpenClaw agent finish runId=unknown classification=user_private textLength=32"
    );
    expect(logs.some((line) => line.startsWith("OpenClaw command start"))).toBe(
      true
    );
    expect(logs.some((line) => line.startsWith("OpenClaw token estimate"))).toBe(
      true
    );
    expect(
      logs.some(
        (line) =>
          line.startsWith("OpenClaw usage") &&
          line.includes("source=estimate-only")
      )
    ).toBe(true);
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

  test("logs provider token usage from OpenClaw diagnostics when present", async () => {
    const logs: string[] = [];

    await runOpenClawCliRequest(
      {
        runId: "run-usage",
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
      async () => ({
        exitCode: 0,
        stdout: [
          '[openai-transport] usage={"input_tokens":1200,"output_tokens":75,"total_tokens":1275,"cached_tokens":300,"reasoning_tokens":20}',
          JSON.stringify({ response: { text: "Done." } })
        ].join("\n"),
        stderr: ""
      }),
      (message) => logs.push(message)
    );

    expect(logs).toContain(
      "OpenClaw usage runId=run-usage step=1 promptApproxTokens=1066 inputTokens=1200 outputTokens=75 totalTokens=1275 cachedInputTokens=300 reasoningTokens=20 source=provider-output"
    );
    expect(logs).toContain(
      "OpenClaw model usage diagnostics runId=run-usage step=1 modelStarts=0 fetchStarts=0 streamDone=0 streamDoneElapsedMs=none streamDoneEvents=none compactions=0 exactUsageFields=5 exactUsageAvailable=true"
    );
  });

  test("logs OpenClaw internal model usage diagnostics when exact tokens are absent", async () => {
    const logs: string[] = [];

    await runOpenClawCliRequest(
      {
        runId: "run-diagnostics",
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
      async () => ({
        exitCode: 0,
        stdout: [
          "[openai-transport] [responses] start provider=openai api=openai-responses model=gpt-5.4",
          "[provider-transport-fetch] [model-fetch] start provider=openai api=openai-responses model=gpt-5.4",
          "[openai-transport] [responses] stream_done provider=openai api=openai-responses model=gpt-5.4 elapsedMs=3522 events=38",
          "[agent/embedded] [compaction-diag] start runId=session-1",
          "[openai-transport] [responses] start provider=openai api=openai-responses model=gpt-5.4",
          "[provider-transport-fetch] [model-fetch] start provider=openai api=openai-responses model=gpt-5.4",
          "[openai-transport] [responses] stream_done provider=openai api=openai-responses model=gpt-5.4 elapsedMs=29406 events=1731",
          JSON.stringify({ response: { text: "Done." } })
        ].join("\n"),
        stderr: ""
      }),
      (message) => logs.push(message)
    );

    expect(logs).toContain(
      "OpenClaw usage runId=run-diagnostics step=1 promptApproxTokens=1066 inputTokens=unknown outputTokens=unknown totalTokens=unknown cachedInputTokens=unknown reasoningTokens=unknown source=estimate-only"
    );
    expect(logs).toContain(
      "OpenClaw model usage diagnostics runId=run-diagnostics step=1 modelStarts=2 fetchStarts=2 streamDone=2 streamDoneElapsedMs=3522,29406 streamDoneEvents=38,1731 compactions=1 exactUsageFields=0 exactUsageAvailable=false"
    );
  });

  test("uses isolated OpenClaw sessions for each planning step", async () => {
    const sessionIds: string[] = [];

    await runOpenClawCliRequest(
      {
        runId: "run-session-scope",
        input: {
          text: "which Jira tickets are blocked?",
          connections: {
            github: {
              connected: true,
              email: "person@example.com",
              providerLogin: "octocat"
            },
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
        content: [{ key: "DM-1", title: "Blocked deploy" }]
      }),
      async (_command, args) => {
        sessionIds.push(readSessionIdArg(args));
        return {
          exitCode: 0,
          stdout:
            sessionIds.length === 1
              ? JSON.stringify({
                  tool_call: {
                    name: "jira.searchIssues",
                    arguments: { jql: "status = Blocked" }
                  }
                })
              : JSON.stringify({ response: { text: "DM-1 is blocked." } }),
          stderr: ""
        };
      },
      () => undefined
    );

    expect(sessionIds).toHaveLength(2);
    expect(sessionIds[0]).toStartWith("burble-step-");
    expect(sessionIds[1]).toStartWith("burble-step-");
    expect(sessionIds[0].length).toBeLessThanOrEqual(64);
    expect(sessionIds[1].length).toBeLessThanOrEqual(64);
    expect(sessionIds[0]).not.toBe(sessionIds[1]);
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
    expect(
      logs.some(
        (line) =>
          line.startsWith(
            "OpenClaw agent start runId=unknown agent=main sessionId=burble-run-"
          ) &&
          line.includes(" sessionScope=run textLength=46 classification=user_private")
      )
    ).toBe(true);
    expect(logs).toContain(
      "OpenClaw agent finish runId=unknown classification=user_private textLength=28"
    );
  });

  test("lets OpenClaw plan a Jira REST tool call and reruns with the result", async () => {
    const toolCalls: Array<{ toolName: string; body: unknown }> = [];
    const prompts: string[] = [];

    const response = await runOpenClawCliRequest(
      {
        input: {
          text: "which Jira tickets are blocked?",
          connections: {
            github: {
              connected: true,
              email: "person@example.com",
              providerLogin: "octocat"
            },
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
        toolCalls.push({ toolName, body });
        if (toolName === "atlassian.listMcpTools") {
          return {
            classification: "user_private",
            content: []
          };
        }
        if (toolName === "jira.searchIssues") {
          return {
            classification: "user_private",
            content: [
              {
                key: "ENG-7",
                title: "Deploy is blocked",
                url: "https://example.atlassian.net/browse/ENG-7"
              }
            ]
          };
        }

        return {
          classification: "user_private",
          content: []
        };
      },
      async (_command, args) => {
        const prompt = args[args.indexOf("--message") + 1];
        prompts.push(prompt);
        return prompts.length === 1
          ? {
              exitCode: 0,
              stdout: JSON.stringify({
                tool_call: {
                  name: "jira.searchIssues",
                  arguments: {
                    jql: 'text ~ "blocked" AND statusCategory != Done'
                  }
                }
              }),
              stderr: ""
            }
          : {
              exitCode: 0,
              stdout: JSON.stringify({
                response: {
                  text: "ENG-7 looks blocked."
                }
              }),
              stderr: ""
            };
      },
      () => undefined
    );

    expect(response.response.text).toBe("ENG-7 looks blocked.");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Available Burble tools:");
    expect(prompts[0]).toContain("jira.searchIssues");
    expect(prompts[0]).not.toContain('"name":"atlassian.callMcpTool"');
    expect(
      toolCalls.some((call) => call.toolName === "atlassian.listMcpTools")
    ).toBe(false);
    expect(prompts[0]).not.toContain("person@example.com");
    expect(prompts[1]).toContain("Burble executed tools:");
    expect(prompts[1]).toContain("Deploy is blocked");
    expect(toolCalls).toContainEqual({
      toolName: "jira.searchIssues",
      body: {
        user: { email: "person@example.com" },
        input: {
          jql: 'text ~ "blocked" AND statusCategory != Done'
        }
      }
    });
  });

  test("lets OpenClaw plan an allowed Atlassian MCP tool call", async () => {
    const toolCalls: Array<{ toolName: string; body: unknown }> = [];
    const prompts: string[] = [];
    const response = await runOpenClawCliRequest(
      {
        input: {
          text: "find Jira issues mentioning onboarding using Atlassian MCP",
          connections: {
            github: {
              connected: true,
              email: "person@example.com",
              providerLogin: "octocat"
            },
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
        toolCalls.push({ toolName, body });
        if (toolName === "atlassian.listMcpTools") {
          return {
            classification: "user_private",
            content: [
              {
                name: "searchJiraIssuesUsingJql",
                description: "Search Jira issues using JQL",
                inputSchema: {
                  type: "object",
                  properties: {
                    jql: { type: "string" }
                  },
                  required: ["jql"]
                }
              }
            ]
          };
        }
        if (toolName === "atlassian.callMcpTool") {
          return {
            classification: "user_private",
            content: {
              toolName: "searchJiraIssuesUsingJql",
              result: {
                content: [
                  {
                    type: "text",
                    text: "ECS-313 onboarding crash loop"
                  }
                ]
              }
            }
          };
        }

        return {
          classification: "user_private",
          content: []
        };
      },
      async (_command, args) => {
        const prompt = args[args.indexOf("--message") + 1];
        prompts.push(prompt);
        return prompt.includes("Burble executed tools:")
          ? {
              exitCode: 0,
              stdout: "ECS-313 is the likely match.",
              stderr: ""
            }
          : {
              exitCode: 0,
              stdout: JSON.stringify({
                tool_call: {
                  name: "atlassian.callMcpTool",
                  arguments: {
                    name: "searchJiraIssuesUsingJql",
                    arguments: {
                      jql: 'text ~ "onboarding"'
                    }
                  }
                }
              }),
              stderr: ""
            };
      },
      () => undefined
    );

    expect(response.response.text).toBe("ECS-313 is the likely match.");
    expect(prompts[0]).toContain("Follow schemas shown in Available Burble tools");
    expect(prompts[0]).toContain("searchJiraIssuesUsingJql");
    expect(prompts[0]).toContain("inputSchema");
    expect(toolCalls).toContainEqual({
      toolName: "atlassian.callMcpTool",
      body: {
        user: { email: "person@example.com" },
        input: {
          name: "searchJiraIssuesUsingJql",
          arguments: {
            jql: 'text ~ "onboarding"'
          }
        }
      }
    });
  });

  test("validates required upstream Atlassian MCP arguments before provider calls", async () => {
    const toolCalls: Array<{ toolName: string; body: unknown }> = [];
    const prompts: string[] = [];
    const response = await runOpenClawCliRequest(
      {
        input: {
          text: "create new Jira ticket in DM workspace using Atlassian MCP, titled 'test ticket from slack'",
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
        toolCalls.push({ toolName, body });
        if (toolName === "atlassian.listMcpTools") {
          return {
            classification: "user_private",
            content: [
              {
                name: "createJiraIssue",
                inputSchema: {
                  type: "object",
                  properties: {
                    cloudId: { type: "string" },
                    projectKey: { type: "string" },
                    issueType: { type: "string" },
                    summary: { type: "string" }
                  },
                  required: ["cloudId", "projectKey", "issueType", "summary"]
                }
              }
            ]
          };
        }
        throw new Error(`Unexpected provider call: ${toolName}`);
      },
      async (_command, args) => {
        const prompt = args[args.indexOf("--message") + 1];
        prompts.push(prompt);
        return prompt.includes("Burble executed tools:") &&
          prompt.includes("mcp_schema_validation_failed")
          ? {
              exitCode: 0,
              stdout:
                "I need the Jira issue type for the DM project before I can create it.",
              stderr: ""
            }
          : openClawToolCall("atlassian.callMcpTool", {
              name: "createJiraIssue",
              arguments: {
                cloudId: "cloud-123",
                projectKey: "DM",
                summary: "test ticket from slack"
              }
            });
      },
      () => undefined
    );

    expect(response.response.text).toBe(
      "I need the Jira issue type for the DM project before I can create it."
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("mcp_schema_validation_failed");
    expect(prompts[1]).toContain("issueType");
    expect(
      toolCalls.some((call) => call.toolName === "atlassian.callMcpTool")
    ).toBe(false);
  });

  test("normalizes bare Atlassian hostnames used as Jira MCP cloudId values", async () => {
    const toolCalls: Array<{ toolName: string; body: unknown }> = [];
    const prompts: string[] = [];
    const response = await runOpenClawCliRequest(
      {
        input: {
          text: "create new Jira ticket in DM workspace using Atlassian MCP, titled 'test ticket from slack'",
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
        toolCalls.push({ toolName, body });
        if (toolName === "atlassian.listMcpTools") {
          return {
            classification: "user_private",
            content: [
              {
                name: "getVisibleJiraProjects",
                inputSchema: {
                  type: "object",
                  properties: {
                    cloudId: { type: "string" },
                    searchString: { type: "string" },
                    action: { type: "string" },
                    expandIssueTypes: { type: "boolean" }
                  },
                  required: ["cloudId"]
                }
              }
            ]
          };
        }
        if (toolName === "atlassian.callMcpTool") {
          return mcpText("getVisibleJiraProjects", '[{"key":"DM"}]');
        }
        return {
          classification: "user_private",
          content: []
        };
      },
      async (_command, args) => {
        const prompt = args[args.indexOf("--message") + 1];
        prompts.push(prompt);
        return prompt.includes("Burble executed tools:")
          ? {
              exitCode: 0,
              stdout: "DM is visible.",
              stderr: ""
            }
          : openClawToolCall("atlassian.callMcpTool", {
              name: "getVisibleJiraProjects",
              arguments: {
                cloudId: "apegpt.atlassian.net",
                searchString: "DM",
                action: "create",
                expandIssueTypes: true
              }
            });
      },
      () => undefined
    );

    expect(response.response.text).toBe("DM is visible.");
    expect(prompts).toHaveLength(2);
    expect(toolCalls).toContainEqual({
      toolName: "atlassian.callMcpTool",
      body: {
        user: { email: "person@example.com" },
        input: {
          name: "getVisibleJiraProjects",
          arguments: {
            cloudId: "https://apegpt.atlassian.net",
            searchString: "DM",
            action: "create",
            expandIssueTypes: true
          }
        }
      }
    });
  });

  test("lets OpenClaw chain multiple Atlassian MCP calls for a Jira action", async () => {
    const toolCalls: Array<{ toolName: string; body: unknown }> = [];
    const prompts: string[] = [];
    const response = await runOpenClawCliRequest(
      {
        input: {
          text: "create new Jira ticket in DM workspace using Atlassian MCP, titled 'test ticket from slack' and assign it to Alex Reviewer (alex.reviewer@example.com)",
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
        toolCalls.push({ toolName, body });
        const input = (body as { input?: { name?: string } }).input;
        if (toolName === "atlassian.listMcpTools") {
          return {
            classification: "user_private",
            content: [
              {
                name: "getAccessibleAtlassianResources",
                inputSchema: { type: "object", properties: {} }
              },
              {
                name: "lookupJiraAccountId",
                inputSchema: {
                  type: "object",
                  properties: {
                    cloudId: { type: "string" },
                    searchString: { type: "string" }
                  }
                }
              },
              {
                name: "createJiraIssue",
                inputSchema: {
                  type: "object",
                  properties: {
                    cloudId: { type: "string" },
                    projectKey: { type: "string" },
                    summary: { type: "string" },
                    assignee_account_id: { type: "string" }
                  }
                }
              }
            ]
          };
        }
        if (input?.name === "getAccessibleAtlassianResources") {
          return mcpText("getAccessibleAtlassianResources", '[{"id":"cloud-123"}]');
        }
        if (input?.name === "lookupJiraAccountId") {
          return mcpText("lookupJiraAccountId", '[{"accountId":"acct-boris"}]');
        }
        if (input?.name === "createJiraIssue") {
          return mcpText("createJiraIssue", "Created DM-100");
        }

        return {
          classification: "user_private",
          content: []
        };
      },
      async (_command, args) => {
        const prompt = args[args.indexOf("--message") + 1];
        prompts.push(prompt);
        if (prompts.length === 1) {
          return openClawToolCall("atlassian.callMcpTool", {
            name: "getAccessibleAtlassianResources",
            arguments: {}
          });
        }
        if (prompts.length === 2) {
          return openClawToolCall("atlassian.callMcpTool", {
            name: "lookupJiraAccountId",
            arguments: {
              cloudId: "cloud-123",
              searchString: "alex.reviewer@example.com"
            }
          });
        }
        if (prompts.length === 3) {
          return openClawToolCall("atlassian.callMcpTool", {
            name: "createJiraIssue",
            arguments: {
              cloudId: "cloud-123",
              projectKey: "DM",
              summary: "test ticket from slack",
              assignee_account_id: "acct-boris"
            }
          });
        }

        return {
          exitCode: 0,
          stdout: "Created DM-100.",
          stderr: ""
        };
      },
      () => undefined
    );

    expect(response.response.text).toBe("Created DM-100.");
    expect(prompts).toHaveLength(4);
    expect(toolCalls).toContainEqual({
      toolName: "atlassian.callMcpTool",
      body: {
        user: { email: "person@example.com" },
        input: {
          name: "lookupJiraAccountId",
          arguments: {
            cloudId: "cloud-123",
            searchString: "alex.reviewer@example.com"
          }
        }
      }
    });
    expect(toolCalls).toContainEqual({
      toolName: "atlassian.callMcpTool",
      body: {
        user: { email: "person@example.com" },
        input: {
          name: "createJiraIssue",
          arguments: {
            cloudId: "cloud-123",
            projectKey: "DM",
            summary: "test ticket from slack",
            assignee_account_id: "acct-boris"
          }
        }
      }
    });
  });

  test("guides OpenClaw to create Jira issues unassigned when assignee lookup misses", async () => {
    const toolCalls: Array<{ toolName: string; body: unknown }> = [];
    const prompts: string[] = [];
    const response = await runOpenClawCliRequest(
      {
        input: {
          text: "create new Jira ticket in DM workspace using Atlassian MCP, titled 'test ticket from slack' and assign it to Alex Reviewer (alex.reviewer@example.com)",
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
        toolCalls.push({ toolName, body });
        const input = (body as { input?: { name?: string } }).input;
        if (toolName === "atlassian.listMcpTools") {
          return {
            classification: "user_private",
            content: [
              {
                name: "getAccessibleAtlassianResources",
                inputSchema: { type: "object", properties: {} }
              },
              {
                name: "lookupJiraAccountId",
                inputSchema: {
                  type: "object",
                  properties: {
                    cloudId: { type: "string" },
                    searchString: { type: "string" }
                  }
                }
              },
              {
                name: "createJiraIssue",
                inputSchema: {
                  type: "object",
                  properties: {
                    cloudId: { type: "string" },
                    projectKey: { type: "string" },
                    summary: { type: "string" },
                    assignee_account_id: { type: "string" }
                  }
                }
              }
            ]
          };
        }
        if (input?.name === "getAccessibleAtlassianResources") {
          return mcpText("getAccessibleAtlassianResources", '[{"id":"cloud-123"}]');
        }
        if (input?.name === "lookupJiraAccountId") {
          return mcpText("lookupJiraAccountId", "[]");
        }
        if (input?.name === "createJiraIssue") {
          return mcpText("createJiraIssue", "Created DM-100");
        }

        return {
          classification: "user_private",
          content: []
        };
      },
      async (_command, args) => {
        const prompt = args[args.indexOf("--message") + 1];
        prompts.push(prompt);
        if (prompts.length === 1) {
          return openClawToolCall("atlassian.callMcpTool", {
            name: "getAccessibleAtlassianResources",
            arguments: {}
          });
        }
        if (prompts.length === 2) {
          return openClawToolCall("atlassian.callMcpTool", {
            name: "lookupJiraAccountId",
            arguments: {
              cloudId: "cloud-123",
              searchString: "alex.reviewer@example.com"
            }
          });
        }
        if (prompts.length === 3) {
          return openClawToolCall("atlassian.callMcpTool", {
            name: "createJiraIssue",
            arguments: {
              cloudId: "cloud-123",
              projectKey: "DM",
              summary: "test ticket from slack"
            }
          });
        }

        return {
          exitCode: 0,
          stdout: "Created DM-100, but I could not assign it because Jira could not resolve Alex Reviewer.",
          stderr: ""
        };
      },
      () => undefined
    );

    expect(response.response.text).toBe(
      "Created DM-100, but I could not assign it because Jira could not resolve Alex Reviewer."
    );
    expect(prompts).toHaveLength(4);
    expect(prompts[0]).toContain("do not block on optional assignee lookup failure");
    expect(toolCalls).toContainEqual({
      toolName: "atlassian.callMcpTool",
      body: {
        user: { email: "person@example.com" },
        input: {
          name: "lookupJiraAccountId",
          arguments: {
            cloudId: "cloud-123",
            searchString: "alex.reviewer@example.com"
          }
        }
      }
    });
    expect(toolCalls).toContainEqual({
      toolName: "atlassian.callMcpTool",
      body: {
        user: { email: "person@example.com" },
        input: {
          name: "createJiraIssue",
          arguments: {
            cloudId: "cloud-123",
            projectKey: "DM",
            summary: "test ticket from slack"
          }
        }
      }
    });
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
          sessionIds.push(readSessionIdArg(args));
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
    expect(sessionIds[0]).toStartWith("burble-step-");
    expect(sessionIds[1]).toStartWith("burble-step-");
    expect(sessionIds[0].length).toBeLessThanOrEqual(64);
    expect(sessionIds[1].length).toBeLessThanOrEqual(64);
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

  test("does not treat diagnostic stdout as a partial answer after CLI failure", async () => {
    await expect(async () => {
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
        config,
        async () => ({
          classification: "user_private",
          content: []
        }),
        async function* () {
          yield {
            type: "stdout" as const,
            text: "[plugins] loading openai\n[openai-transport] [responses] start\n"
          };
          yield {
            type: "stderr" as const,
            text: "code=insufficient_quota message=You exceeded your current quota"
          };
          yield { type: "exit" as const, exitCode: 1 };
        }
      )) {
        // drain stream until failure
      }
    }).toThrow("OpenClaw CLI exited with code 1");
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

  test("streams a planned tool call without showing the JSON protocol to Slack", async () => {
    const events = [];
    let commandCount = 0;

    for await (const event of runOpenClawCliRequestStream(
      {
        input: {
          text: "which Jira tickets are blocked?",
          connections: {
            github: {
              connected: true,
              email: "person@example.com",
              providerLogin: "octocat"
            },
            jira: {
              connected: true,
              email: "person@example.com",
              providerLogin: "person@atlassian.example"
            }
          }
        }
      },
      config,
      async (toolName) =>
        toolName === "jira.searchIssues"
          ? {
              classification: "user_private",
              content: [
                {
                  key: "ENG-7",
                  title: "Deploy is blocked",
                  url: "https://example.atlassian.net/browse/ENG-7"
                }
              ]
            }
          : {
              classification: "user_private",
              content: []
            },
      async function* () {
        commandCount += 1;
        if (commandCount === 1) {
          yield {
            type: "stdout" as const,
            text:
              JSON.stringify({
                tool_call: {
                  name: "jira.searchIssues",
                  arguments: { jql: 'text ~ "blocked"' }
                }
              }) + "\n"
          };
        } else {
          yield { type: "stdout" as const, text: "ENG-7 is blocked." };
        }
        yield { type: "exit" as const, exitCode: 0 };
      },
      () => undefined
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "status", text: "Loading Burble context..." },
      { type: "status", text: "Running OpenClaw/NemoClaw..." },
      {
        type: "tool_call",
        toolName: "jira.searchIssues",
        callId: expect.any(String)
      },
      {
        type: "tool_result",
        toolName: "jira.searchIssues",
        callId: expect.any(String),
        classification: "user_private"
      },
      { type: "message_delta", text: "ENG-7 is blocked." },
      {
        type: "final",
        response: {
          classification: "user_private",
          text: "ENG-7 is blocked."
        }
      }
    ]);
    expect(events[2]).toMatchObject({ type: "tool_call" });
    expect(events[3]).toMatchObject({
      type: "tool_result",
      callId: (events[2] as { callId: string }).callId
    });
  });

  test("yields stdout deltas before the OpenClaw process exits", async () => {
    let resolveExit!: () => void;
    const exitGate = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    const stream = runOpenClawCliRequestStream(
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
      async () => ({
        classification: "user_private",
        content: []
      }),
      async function* () {
        yield { type: "stdout" as const, text: "Early token." };
        await exitGate;
        yield { type: "exit" as const, exitCode: 0 };
      },
      () => undefined
    )[Symbol.asyncIterator]();

    expect(await stream.next()).toEqual({
      done: false,
      value: { type: "status", text: "Loading Burble context..." }
    });
    expect(await stream.next()).toEqual({
      done: false,
      value: { type: "status", text: "Running OpenClaw/NemoClaw..." }
    });
    expect(await stream.next()).toEqual({
      done: false,
      value: { type: "message_delta", text: "Early token." }
    });

    resolveExit();
    expect((await stream.next()).value).toEqual({
      type: "final",
      response: {
        classification: "user_private",
        text: "Early token."
      }
    });
  });

  test("can invoke OpenClaw through Gateway mode without local CLI execution", async () => {
    const commands: Array<{ args: string[] }> = [];
    const response = await runOpenClawCliRequest(
      {
        input: {
          text: "what can you do?",
          connections: {
            github: { connected: false }
          }
        }
      },
      { ...config, engine: "openclaw-gateway" },
      async () => {
        throw new Error("unexpected tool call");
      },
      async (_command, args) => {
        commands.push({ args });
        return {
          exitCode: 0,
          stdout: "Gateway answer.",
          stderr: ""
        };
      },
      () => undefined
    );

    expect(response.response.text).toBe("Gateway answer.");
    expect(commands).toHaveLength(1);
    expect(commands[0].args).toContain("agent");
    expect(commands[0].args).toContain("--session-id");
    expect(commands[0].args).not.toContain("--local");
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
          type: "stderr" as const,
          text: "trace sk-stderrsecretsecret\n"
        };
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
    expect(logs.join("\n")).toContain("event=stderr chunk");
    expect(logs.join("\n")).toContain("event=delta parsed");
    expect(logs.join("\n")).toContain("[redacted-openai-key]");
    expect(logs.join("\n")).not.toContain("sk-secretsecretsecret");
    expect(logs.join("\n")).not.toContain("sk-stderrsecretsecret");
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

function mcpText(toolName: string, text: string) {
  return {
    classification: "user_private" as const,
    content: {
      toolName,
      result: {
        content: [
          {
            type: "text",
            text
          }
        ]
      }
    }
  };
}

function openClawToolCall(
  name: string,
  args: Record<string, unknown>
) {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      tool_call: {
        name,
        arguments: args
      }
    }),
    stderr: ""
  };
}
