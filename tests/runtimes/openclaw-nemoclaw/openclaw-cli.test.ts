import { describe, expect, test } from "bun:test";
import {
  runOpenClawCliRequest,
  runOpenClawCliRequestStream
} from "../../../runtimes/openclaw-nemoclaw/src/openclaw-cli";
import type { RuntimeConfig } from "../../../runtimes/openclaw-nemoclaw/src/config";
import type { RunEvent } from "../../../runtimes/openclaw-nemoclaw/src/types";
import { clearGatewayDiagnosticText } from "../../../runtimes/openclaw-nemoclaw/src/gateway-diagnostics";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  openClawCodeMode: false,
  openClawFastMode: false,
  openClawRawStreamDebug: false,
  openClawGatewayPort: 18789,
  openClawGatewayBind: "loopback",
  openClawGatewayToken: "gateway-token",
  llmModel: "openai:gpt-5.4",
  ollamaBaseUrl: "https://ollama.com"
};

function readSessionIdArg(args: string[]): string {
  const index = args.indexOf("--session-id");
  expect(index).toBeGreaterThan(-1);
  return args[index + 1] ?? "";
}

async function withMockFetch<T>(
  mock: typeof fetch,
  run: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function withEnv<T>(
  values: Record<string, string>,
  run: () => Promise<T>
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function openResponsesText(text: string, usage = {
  input_tokens: 100,
  output_tokens: 20,
  total_tokens: 120
}): Record<string, unknown> {
  return {
    id: "resp_test",
    object: "response",
    created_at: 1,
    status: "completed",
    model: "openclaw/main",
    output: [
      {
        type: "message",
        id: "msg_test",
        role: "assistant",
        content: [{ type: "output_text", text }],
        status: "completed"
      }
    ],
    usage
  };
}

describe("runOpenClawCliRequest", () => {
  test("builds provider catalog from MCP tools/list metadata", async () => {
    const prompts: string[] = [];

    const response = await runOpenClawCliRequest(
      {
        input: {
          text: "hello",
          connections: {
            github: {
              connected: true,
              email: "person@example.com",
              providerLogin: "octocat"
            }
          }
        }
      },
      {
        ...config,
        mcpGatewayUrl: "http://agentgateway:3000/mcp",
        runtimeJwt: "runtime-jwt"
      },
      async (toolName) => {
        if (toolName === "burble.mcp.listTools") {
          return {
            classification: "user_private",
            content: [
              {
                name: "github_list_my_pull_requests",
                description: "MCP-discovered PR listing tool",
                inputSchema: {}
              },
              {
                name: "jira_search_issues",
                description: "Should be hidden without a Jira connection",
                inputSchema: {
                  type: "object"
                }
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
        prompts.push(args[args.indexOf("--message") + 1] ?? "");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            response: {
              text: "Hi."
            }
          }),
          stderr: ""
        };
      },
      () => undefined
    );

    expect(response.response.text).toBe("Hi.");
    const catalogText =
      prompts[0].split("Available Burble tools:\n")[1]?.split("\n\n")[0] ?? "";
    expect(catalogText).toContain("github.listMyPullRequests");
    expect(catalogText).toContain("MCP-discovered PR listing tool");
    expect(catalogText).not.toContain('"name":"jira.searchIssues"');
  });

  test("filters MCP-discovered provider catalog by selected tool groups", async () => {
    const prompts: string[] = [];

    const response = await runOpenClawCliRequest(
      {
        input: {
          text: "show my GitHub PRs",
          toolGroups: {
            groups: ["conversation", "github"],
            reasons: ["matched github"]
          },
          connections: {
            github: {
              connected: true,
              email: "person@example.com",
              providerLogin: "octocat"
            },
            google: {
              connected: true,
              email: "person@example.com"
            },
            hubspot: {
              connected: true,
              email: "person@example.com"
            },
            jira: {
              connected: true,
              email: "person@example.com"
            }
          }
        }
      },
      {
        ...config,
        mcpGatewayUrl: "http://agentgateway:3000/mcp",
        runtimeJwt: "runtime-jwt"
      },
      async (toolName) => {
        if (toolName === "burble.mcp.listTools") {
          return {
            classification: "user_private",
            content: [
              {
                name: "github_list_my_pull_requests",
                description: "MCP-discovered PR listing tool",
                inputSchema: {}
              },
              {
                name: "google_search_drive_files",
                description: "Should be hidden for GitHub-only requests",
                inputSchema: {}
              },
              {
                name: "hubspot_search_contacts",
                description: "Should be hidden for GitHub-only requests",
                inputSchema: {}
              },
              {
                name: "jira_search_issues",
                description: "Should be hidden for GitHub-only requests",
                inputSchema: {}
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
        prompts.push(args[args.indexOf("--message") + 1] ?? "");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            response: {
              text: "Hi."
            }
          }),
          stderr: ""
        };
      },
      () => undefined
    );

    expect(response.response.text).toBe("Hi.");
    const catalogText =
      prompts[0].split("Available Burble tools:\n")[1]?.split("\n\n")[0] ?? "";
    expect(catalogText).toContain("github.listMyPullRequests");
    expect(catalogText).not.toContain("google.searchDriveFiles");
    expect(catalogText).not.toContain("hubspot.searchContacts");
    expect(catalogText).not.toContain("jira.searchIssues");
  });

  test("includes HubSpot tools in discovered and fallback catalogs", async () => {
    const discoveredPrompts: string[] = [];
    const fallbackPrompts: string[] = [];

    const discoveredResponse = await runOpenClawCliRequest(
      {
        input: {
          text: "find HubSpot contacts for Acme",
          toolGroups: {
            groups: ["conversation", "hubspot"],
            reasons: ["matched hubspot"]
          },
          connections: {
            github: {
              connected: false
            },
            hubspot: {
              connected: true,
              email: "person@example.com"
            }
          }
        }
      },
      {
        ...config,
        mcpGatewayUrl: "http://agentgateway:3000/mcp",
        runtimeJwt: "runtime-jwt"
      },
      async (toolName) => {
        if (toolName === "burble.mcp.listTools") {
          return {
            classification: "user_private",
            content: [
              {
                name: "hubspot_search_contacts",
                description: "MCP-discovered HubSpot contact search",
                inputSchema: {}
              },
              {
                name: "google_search_drive_files",
                description: "Should be hidden for HubSpot-only requests",
                inputSchema: {}
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
        discoveredPrompts.push(args[args.indexOf("--message") + 1] ?? "");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            response: {
              text: "Hi."
            }
          }),
          stderr: ""
        };
      },
      () => undefined
    );

    expect(discoveredResponse.response.text).toBe("Hi.");
    const discoveredCatalogText =
      discoveredPrompts[0]
        .split("Available Burble tools:\n")[1]
        ?.split("\n\n")[0] ?? "";
    expect(discoveredCatalogText).toContain("hubspot.searchContacts");
    expect(discoveredCatalogText).toContain(
      "MCP-discovered HubSpot contact search"
    );
    expect(discoveredCatalogText).not.toContain("google.searchDriveFiles");

    const fallbackResponse = await runOpenClawCliRequest(
      {
        input: {
          text: "find HubSpot companies for Acme",
          toolGroups: {
            groups: ["conversation", "hubspot"],
            reasons: ["matched hubspot"]
          },
          connections: {
            github: {
              connected: false
            },
            hubspot: {
              connected: true,
              email: "person@example.com"
            },
            google: {
              connected: true,
              email: "person@example.com"
            }
          }
        }
      },
      config,
      async () => {
        throw new Error("unexpected tool call");
      },
      async (_command, args) => {
        fallbackPrompts.push(args[args.indexOf("--message") + 1] ?? "");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            response: {
              text: "Hi."
            }
          }),
          stderr: ""
        };
      },
      () => undefined
    );

    expect(fallbackResponse.response.text).toBe("Hi.");
    const fallbackCatalogText =
      fallbackPrompts[0].split("Available Burble tools:\n")[1]?.split("\n\n")[0] ??
      "";
    expect(fallbackCatalogText).toContain("hubspot.getAuthenticatedUser");
    expect(fallbackCatalogText).toContain("hubspot.searchCompanies");
    expect(fallbackCatalogText).toContain("hubspot.searchDeals");
    expect(fallbackCatalogText).toContain("hubspot.searchCrmObjects");
    expect(fallbackCatalogText).toContain("hubspot.listOwners");
    expect(fallbackCatalogText).toContain("hubspot.listUsers");
    expect(fallbackCatalogText).toContain("hubspot.readApiResource");
    expect(fallbackCatalogText).not.toContain("google.searchDriveFiles");
  });

  test("filters preloaded runtime skills by selected tool groups", async () => {
    const prompts: string[] = [];

    const response = await runOpenClawCliRequest(
      {
        input: {
          text: "hello",
          toolGroups: {
            groups: ["conversation"],
            reasons: ["fallback conversation"]
          },
          connections: {
            github: {
              connected: true,
              email: "person@example.com",
              providerLogin: "octocat"
            },
            jira: {
              connected: true,
              email: "person@example.com"
            }
          }
        },
        runtime: {
          id: "rt_123",
          manifest: {
            version: "1",
            policyHash: "policy-hash-123",
            skills: [
              { id: "core", version: "1", enabled: true },
              { id: "github", version: "1", enabled: true },
              { id: "atlassian-jira", version: "1", enabled: true }
            ],
            memory: {
              userMemoryEnabled: true,
              workspaceMemoryEnabled: true,
              jobMemoryEnabled: true
            }
          }
        }
      },
      config,
      async () => {
        throw new Error("unexpected tool call");
      },
      async (_command, args) => {
        prompts.push(args[args.indexOf("--message") + 1] ?? "");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            response: {
              text: "Hi."
            }
          }),
          stderr: ""
        };
      },
      () => undefined
    );

    expect(response.response.text).toBe("Hi.");
    expect(prompts[0]).toContain("# Burble Runtime Skill");
    expect(prompts[0]).not.toContain("# GitHub Skill");
    expect(prompts[0]).not.toContain("# Atlassian Jira Skill");
    expect(prompts[0]).toContain("- enabled bundled skills: core@1");
  });

  test("honors runtime manifest skills and memory context in the prompt", async () => {
    const prompts: string[] = [];

    const response = await runOpenClawCliRequest(
      {
        input: {
          text: "hello",
          connections: {
            github: { connected: false }
          }
        },
        runtime: {
          id: "rt_123",
          manifest: {
            version: "1",
            policyHash: "policy-hash-123",
            skills: [
              { id: "core", version: "1", enabled: true },
              { id: "github", version: "1", enabled: false }
            ],
            memory: {
              userMemoryEnabled: false,
              workspaceMemoryEnabled: true,
              jobMemoryEnabled: true
            },
            memoryContext: [
              {
                scope: "workspace",
                ownerId: "",
                key: "github.defaultOrg",
                valuePreview: "\"apelogic-ai\"",
                updatedAt: "2026-05-28T00:00:00.000Z"
              }
            ]
          }
        }
      },
      config,
      async () => {
        throw new Error("unexpected tool call");
      },
      async (_command, args) => {
        prompts.push(args[args.indexOf("--message") + 1] ?? "");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            response: {
              text: "Hi."
            }
          }),
          stderr: ""
        };
      },
      () => undefined
    );

    expect(response.response.text).toBe("Hi.");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("# Burble Runtime Skill");
    expect(prompts[0]).not.toContain("# GitHub Skill");
    expect(prompts[0]).toContain("Runtime policy manifest:");
    expect(prompts[0]).toContain("- policyHash: policy-hash-123");
    expect(prompts[0]).toContain("- enabled bundled skills: core@1");
    expect(prompts[0]).toContain("- memory.user: disabled");
    expect(prompts[0]).toContain("- memory.workspace: enabled");
    expect(prompts[0]).toContain("- memory.jobs: enabled");
    expect(prompts[0]).toContain("- memory context:");
    expect(prompts[0]).toContain(
      "  - workspace:workspace:github.defaultOrg = \"apelogic-ai\""
    );
  });

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

    expect(response).toMatchObject({
      response: {
        classification: "user_private",
        text: "OpenClaw says fix billing first.",
        telemetry: {
          steps: [
            {
              step: 1,
              usageSource: "estimate-only"
            }
          ]
        }
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

    const response = await runOpenClawCliRequest(
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

    expect(
      logs.some(
        (line) =>
          line.startsWith("OpenClaw usage runId=run-usage step=1 ") &&
          line.includes("inputTokens=1200 outputTokens=75 totalTokens=1275") &&
          line.includes("cachedInputTokens=300 reasoningTokens=20") &&
          line.includes("source=provider-output")
      )
    ).toBe(true);
    expect(logs).toContain(
      "OpenClaw model usage diagnostics runId=run-usage step=1 modelStarts=0 fetchStarts=0 streamDone=0 streamDoneElapsedMs=none streamDoneEvents=none compactions=0 exactUsageFields=5 exactUsageAvailable=true rawStreamBytes=0"
    );
    expect(response.response.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 75,
      totalTokens: 1275,
      cachedInputTokens: 300,
      reasoningTokens: 20
    });
    expect(response.response.telemetry).toMatchObject({
      steps: [
        {
          step: 1,
          usageSource: "provider-output",
          modelDiagnostics: {
            exactUsageAvailable: true,
            exactUsageFields: 5
          }
        }
      ]
    });
  });

  test("does not infer cached provider tokens from an unspecified total-token remainder", async () => {
    const response = await runOpenClawCliRequest(
      {
        runId: "run-unspecified-remainder",
        input: {
          text: "hey agent",
          connections: {
            github: { connected: false }
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
          '[openai-transport] usage={"input_tokens":1701,"output_tokens":23,"total_tokens":22588}',
          JSON.stringify({ response: { text: "Hey - how can I help?" } })
        ].join("\n"),
        stderr: ""
      }),
      () => undefined
    );

    expect(response.response.usage).toEqual({
      inputTokens: 1701,
      outputTokens: 23,
      totalTokens: 22588
    });
  });

  test("reads cached and reasoning provider token details when OpenClaw preserves them", async () => {
    const response = await runOpenClawCliRequest(
      {
        runId: "run-provider-details",
        input: {
          text: "hey agent",
          connections: {
            github: { connected: false }
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
          '[openai-transport] usage={"input_tokens":1701,"output_tokens":23,"total_tokens":22588,"input_tokens_details":{"cached_tokens":20864},"output_tokens_details":{"reasoning_tokens":0}}',
          JSON.stringify({ response: { text: "Hey - how can I help?" } })
        ].join("\n"),
        stderr: ""
      }),
      () => undefined
    );

    expect(response.response.usage).toEqual({
      inputTokens: 1701,
      outputTokens: 23,
      totalTokens: 22588,
      cachedInputTokens: 20864,
      reasoningTokens: 0
    });
  });

  test("does not mislabel reasoning-token remainder as cached input", async () => {
    const response = await runOpenClawCliRequest(
      {
        runId: "run-reasoning-remainder",
        input: {
          text: "think through this",
          connections: {
            github: { connected: false }
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
          '[openai-transport] usage={"input_tokens":18812,"output_tokens":34,"total_tokens":22686,"output_tokens_details":{"reasoning_tokens":3840}}',
          JSON.stringify({ response: { text: "Done." } })
        ].join("\n"),
        stderr: ""
      }),
      () => undefined
    );

    expect(response.response.usage).toEqual({
      inputTokens: 18812,
      outputTokens: 34,
      totalTokens: 22686,
      reasoningTokens: 3840
    });
  });

  test("captures exact cached usage from a transient raw stream by default", async () => {
    const logs: string[] = [];
    const stateDir = await mkdtemp(join(tmpdir(), "burble-openclaw-raw-"));
    let rawPath: string | undefined;

    const response = await runOpenClawCliRequest(
      {
        runId: "run-transient-raw-usage",
        input: {
          text: "hey agent",
          connections: {
            github: { connected: false }
          }
        }
      },
      {
        ...config,
        openClawStateDir: stateDir,
        openClawRawStreamDebug: false
      },
      async () => ({
        classification: "user_private",
        content: []
      }),
      async (_command, args) => {
        rawPath = args[args.indexOf("--raw-stream-path") + 1];
        expect(args).toContain("--raw-stream");
        expect(rawPath).toBeTruthy();
        await writeFile(
          rawPath,
          `${JSON.stringify({
            type: "response.completed",
            response: {
              usage: {
                input_tokens: 1701,
                output_tokens: 23,
                total_tokens: 22588,
                input_tokens_details: {
                  cached_tokens: 20864
                }
              }
            }
          })}\n`
        );
        return {
          exitCode: 0,
          stdout: JSON.stringify({ response: { text: "Hey - how can I help?" } }),
          stderr: ""
        };
      },
      (message) => logs.push(message)
    );

    expect(response.response.usage).toEqual({
      inputTokens: 1701,
      outputTokens: 23,
      totalTokens: 22588,
      cachedInputTokens: 20864
    });
    expect(
      logs.some(
        (line) =>
          line.startsWith(
            "OpenClaw raw stream captured runId=run-transient-raw-usage step=1"
          ) && line.includes("retained=false")
      )
    ).toBe(true);
    await expect(readFile(rawPath ?? "", "utf8")).rejects.toThrow();
  });

  test("logs OpenClaw internal model usage diagnostics when exact tokens are absent", async () => {
    const logs: string[] = [];

    const response = await runOpenClawCliRequest(
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

    expect(
      logs.some(
        (line) =>
          line.startsWith("OpenClaw usage runId=run-diagnostics step=1 ") &&
          line.includes("inputTokens=unknown outputTokens=unknown totalTokens=unknown") &&
          line.includes("cachedInputTokens=unknown reasoningTokens=unknown") &&
          line.includes("source=estimate-only")
      )
    ).toBe(true);
    expect(logs).toContain(
      "OpenClaw model usage diagnostics runId=run-diagnostics step=1 modelStarts=2 fetchStarts=2 streamDone=2 streamDoneElapsedMs=3522,29406 streamDoneEvents=38,1731 compactions=1 exactUsageFields=0 exactUsageAvailable=false rawStreamBytes=0"
    );
    expect(response.response.usage).toBeUndefined();
    expect(response.response.telemetry).toMatchObject({
      steps: [
        {
          step: 1,
          usageSource: "estimate-only",
          modelDiagnostics: {
            modelStarts: 2,
            fetchStarts: 2,
            streamDone: 2,
            streamDoneElapsedMs: [3522, 29406],
            streamDoneEvents: [38, 1731],
            compactions: 1,
            exactUsageFields: 0,
            exactUsageAvailable: false,
            rawStreamBytes: 0
          }
        }
      ]
    });
  });

  test("logs burble-direct model diagnostics from direct provider response", async () => {
    const logs: string[] = [];
    clearGatewayDiagnosticText();

    await withEnv(
      { OPENAI_API_KEY: "test-openai-key" },
      async () =>
        await withMockFetch(
          (async () =>
            new Response(JSON.stringify(openResponsesText("Done.")), {
              status: 200,
              headers: { "content-type": "application/json" }
            })) as unknown as typeof fetch,
          async () => {
            await runOpenClawCliRequest(
              {
                runId: "run-gateway-diagnostics",
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
              { ...config, engine: "burble-direct" },
              async () => ({
                classification: "user_private",
                content: []
              }),
              async () => {
                throw new Error("unexpected cli call");
              },
              (message) => logs.push(message)
            );
          }
        )
    );

    expect(logs).toContain(
      "OpenClaw model usage diagnostics runId=run-gateway-diagnostics step=1 modelStarts=0 fetchStarts=0 streamDone=0 streamDoneElapsedMs=none streamDoneEvents=none compactions=0 exactUsageFields=3 exactUsageAvailable=true rawStreamBytes=0"
    );
    expect(
      logs.some((line) =>
        line.includes(
          "Burble direct model start runId=run-gateway-diagnostics step=1 provider=openai model=gpt-5.4"
        )
      )
    ).toBe(true);
    expect(
      logs.some((line) =>
        line.includes(
          "Burble direct model finish runId=run-gateway-diagnostics step=1"
        )
      )
    ).toBe(true);
    expect(
      logs.find((line) =>
        line.includes(
          "OpenClaw gateway phase timings runId=run-gateway-diagnostics step=1"
        )
      )
    ).toBeUndefined();
    const usageLog = logs.find((line) =>
      line.includes(
        "OpenClaw usage runId=run-gateway-diagnostics step=1"
      )
    );
    expect(usageLog).toContain("inputTokens=100");
    expect(usageLog).toContain("outputTokens=20");
    expect(usageLog).toContain("totalTokens=120");
    clearGatewayDiagnosticText();
  });

  test("parses provider token usage from raw stream files when enabled", async () => {
    const logs: string[] = [];
    const stateDir = await mkdtemp(join(tmpdir(), "burble-openclaw-raw-"));
    const commands: Array<{ args: string[] }> = [];

    await runOpenClawCliRequest(
      {
        runId: "run-raw-usage",
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
      {
        ...config,
        openClawStateDir: stateDir,
        openClawRawStreamDebug: true
      },
      async () => ({
        classification: "user_private",
        content: []
      }),
      async (_command, args) => {
        commands.push({ args });
        const rawPath = args[args.indexOf("--raw-stream-path") + 1];
        expect(rawPath).toBeTruthy();
        await writeFile(
          rawPath,
          `${JSON.stringify({
            type: "response.completed",
            response: {
              usage: {
                input_tokens: 1400,
                output_tokens: 90,
                total_tokens: 1490,
                input_tokens_details: {
                  cached_tokens: 400
                },
                output_tokens_details: {
                  reasoning_tokens: 30
                }
              }
            }
          })}\n`
        );
        return {
          exitCode: 0,
          stdout: JSON.stringify({ response: { text: "Done." } }),
          stderr: ""
        };
      },
      (message) => logs.push(message)
    );

    expect(commands[0].args).toContain("--raw-stream");
    expect(
      logs.some(
        (line) =>
          line.startsWith("OpenClaw usage runId=run-raw-usage step=1 ") &&
          line.includes("inputTokens=1400 outputTokens=90 totalTokens=1490") &&
          line.includes("cachedInputTokens=400 reasoningTokens=30") &&
          line.includes("source=provider-output")
      )
    ).toBe(true);
    expect(
      logs.some((line) =>
        line.startsWith(
          "OpenClaw model usage diagnostics runId=run-raw-usage step=1"
        ) &&
        line.includes("exactUsageAvailable=true") &&
        !line.includes("rawStreamBytes=0")
      )
    ).toBe(true);
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

  test("uses recent Slack context to resolve Jira user lookup follow-ups", async () => {
    const toolCalls: Array<{ toolName: string; body: unknown }> = [];
    const prompts: string[] = [];

    const response = await runOpenClawCliRequest(
      {
        input: {
          text: "look him up",
          context: {
            currentChannel: {
              id: "C123",
              isDirectMessage: false,
              historyAvailable: true
            },
            recentMessages: [
              {
                author: "user",
                speaker: "<@U456>",
                text: "which Jira tickets did I assign to Alex Reviewer?"
              }
            ]
          },
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
        if (toolName === "jira.searchUsers") {
          return {
            classification: "user_private",
            content: [
              {
                accountId: "acct-example",
                displayName: "Alex Reviewer",
                emailAddress: "alex.reviewer@example.com"
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
          ? openClawToolCall("jira.searchUsers", {
              query: "Alex Reviewer"
            })
          : {
              exitCode: 0,
              stdout:
                "Alex Reviewer resolved to Jira account `acct-example` (`alex.reviewer@example.com`).",
              stderr: ""
            };
      },
      () => undefined
    );

    expect(response.response.text).toBe(
      "Alex Reviewer resolved to Jira account `acct-example` (`alex.reviewer@example.com`)."
    );
    expect(prompts[0]).toContain("Current Slack channel ID: C123");
    expect(prompts[0]).toContain("Slack user <@U456>");
    expect(prompts[0]).toContain("Recent Slack context (oldest to newest):");
    expect(prompts[0]).toContain("Alex Reviewer");
    expect(prompts[0]).toContain(
      "For named-person Jira questions, search users before asking who the person is."
    );
    expect(prompts[0]).not.toContain("atlassian.listMcpTools");
    expect(toolCalls).toContainEqual({
      toolName: "jira.searchUsers",
      body: {
        user: { email: "person@example.com" },
        input: { query: "Alex Reviewer" }
      }
    });
  });

  test("bounds recent Slack context in OpenClaw prompts", async () => {
    const prompts: string[] = [];

    const response = await runOpenClawCliRequest(
      {
        input: {
          text: "summarize current channel",
          context: {
            currentChannel: {
              id: "C123",
              isDirectMessage: false,
              historyAvailable: true
            },
            recentMessages: Array.from({ length: 20 }, (_, index) => ({
              author: "user" as const,
              speaker: "<@U456>",
              text:
                index === 19
                  ? `recent context ${index + 1} ${"x".repeat(500)}`
                  : `${index === 0 ? "old" : "recent"} context ${index + 1}`
            }))
          },
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
      async (_command, args) => {
        prompts.push(args[args.indexOf("--message") + 1] ?? "");
        return {
          exitCode: 0,
          stdout: "Bounded.",
          stderr: ""
        };
      },
      () => undefined
    );

    expect(response.response.text).toBe("Bounded.");
    expect(prompts[0]).toContain(
      "Current Slack channel history: available (12 of 20 recent messages included)"
    );
    expect(prompts[0]).not.toContain("old context 1");
    expect(prompts[0]).toContain("recent context 20");
    expect(prompts[0]).not.toContain("x".repeat(350));
  });

  test("lets OpenClaw search Slack messages through the connected Slack token", async () => {
    const prompts: string[] = [];
    const toolCalls: Array<{ toolName: string; body: unknown }> = [];
    const response = await runOpenClawCliRequest(
      {
        input: {
          text: "what did I say about launch?",
          connections: {
            github: { connected: false },
            slack: {
              connected: true,
              email: "person@example.com",
              providerLogin: "U123"
            }
          }
        }
      },
      config,
      async (toolName, body) => {
        toolCalls.push({ toolName, body });
        if (toolName === "slack.searchMessages") {
          return {
            classification: "user_private",
            content: [
              {
                channelName: "eng",
                userId: "U123",
                text: "launch plan is ready",
                permalink: "https://slack.test/archives/C123/p1"
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
          ? openClawToolCall("slack.searchMessages", {
              query: "launch",
              fromUserId: "U123",
              limit: 10
            })
          : {
              exitCode: 0,
              stdout:
                "I found one matching Slack message: <https://slack.test/archives/C123/p1|launch plan is ready>.",
              stderr: ""
            };
      },
      () => undefined
    );

    expect(response.response.text).toBe(
      "I found one matching Slack message: <https://slack.test/archives/C123/p1|launch plan is ready>."
    );
    expect(prompts[0]).toContain("slack.searchMessages");
    expect(prompts[0]).toContain("requesting Slack user ID is U123");
    expect(toolCalls).toContainEqual({
      toolName: "slack.searchMessages",
      body: {
        user: { email: "person@example.com" },
        input: { query: "launch", fromUserId: "U123", limit: 10 }
      }
    });
  });

  test("lets OpenClaw send a generic active conversation message", async () => {
    const prompts: string[] = [];
    const toolCalls: Array<{ toolName: string; body: unknown }> = [];
    const response = await runOpenClawCliRequest(
      {
        executionMode: "openclaw-native",
        input: {
          text: "send a progress update",
          conversation: {
            routeId: "convrt_abc123",
            source: "slack",
            workspaceId: "T123",
            channelId: "C123",
            rootId: "channel:C123:thread:1779841118.237",
            isDirectMessage: false
          },
          connections: {
            github: { connected: false }
          }
        }
      },
      config,
      async (toolName, body) => {
        toolCalls.push({ toolName, body });
        return {
          classification: "user_private",
          content: {
            ok: true,
            transport: "slack",
            conversationId: "C123",
            messageId: "1779841120.000"
          }
        };
      },
      async (_command, args) => {
        const prompt = args[args.indexOf("--message") + 1];
        prompts.push(prompt);
        return prompts.length === 1
          ? openClawToolCall("conversation.sendMessage", {
              text: "Still working on it."
            })
          : {
              exitCode: 0,
              stdout: "Sent the progress update.",
              stderr: ""
            };
      },
      () => undefined
    );

    expect(response.response.text).toBe("Sent the progress update.");
    expect(prompts[0]).toContain("conversation.sendMessage");
    expect(prompts[0]).toContain(
      "Active Burble conversation channel route: convrt_abc123"
    );
    expect(prompts[0]).toContain("Native OpenClaw Burble channel delivery");
    expect(prompts[0]).toContain('delivery.mode to "announce"');
    expect(prompts[0]).toContain('delivery.channel to "burble"');
    expect(prompts[0]).toContain('delivery.to to "convrt_abc123"');
    expect(prompts[0]).not.toContain(
      'use Burble provider tools with routeId "convrt_abc123"'
    );
    expect(prompts[0]).toContain("scheduledJob.registerCapability");
    expect(prompts[0]).toContain("Scheduled provider tool registration guard:");
    expect(prompts[0]).not.toContain("Scheduled provider tool registration:\n");
    expect(prompts[0]).toContain(
      "do not create a cron job or background job unless the user explicitly asks"
    );
    expect(prompts[0]).toContain(
      "Do not fetch, POST to, or mention local/private/internal Burble URLs"
    );
    expect(prompts[0]).not.toContain("http://127.0.0.1");
    expect(prompts[0]).toContain(
      "Burble's channel connector owns route auth and transport delivery"
    );
    expect(prompts[0]).not.toContain("/internal/burble/channel/routes");
    expect(prompts[0]).toContain("conversation.sendMessage JSON blobs");
    expect(toolCalls).toContainEqual({
      toolName: "conversation.sendMessage",
      body: {
        input: { text: "Still working on it." }
      }
    });
  });

  test("adds scheduled job context to OpenClaw native prompts", async () => {
    const prompts: string[] = [];
    await runOpenClawCliRequest(
      {
        executionMode: "openclaw-native",
        input: {
          text: "run the scheduled provider job",
          conversation: {
            routeId: "convrt_abc123",
            source: "slack",
            workspaceId: "T123",
            channelId: "C123",
            rootId: "channel:C123:thread:1779841118.237",
            isDirectMessage: false
          },
          scheduledJob: {
            jobId: "job-123",
            capabilityProfile: "scheduled_job",
            allowedTools: [
              "google_get_drive_file",
              "google_append_drive_text_file"
            ],
            routeId: "convrt_abc123",
            runtimeType: "openclaw",
            stateRefs: [
              {
                provider: "google",
                kind: "drive_file",
                id: "file-123",
                purpose: "dedupe_state"
              }
            ],
            visibilityPolicy: {
              maxOutputVisibility: "public",
              allowPrivateToolDeclassification: false
            }
          },
          connections: {
            github: { connected: false },
            google: {
              connected: true,
              email: "person@example.com",
              providerLogin: "person@example.com"
            }
          }
        }
      },
      config,
      async () => ({
        classification: "user_private",
        content: {}
      }),
      async (_command, args) => {
        prompts.push(args[args.indexOf("--message") + 1]);
        return {
          exitCode: 0,
          stdout: "Job run complete.",
          stderr: ""
        };
      },
      () => undefined
    );

    expect(prompts[0]).toContain("Scheduled Burble job context:");
    expect(prompts[0]).toContain("jobId=job-123");
    expect(prompts[0]).toContain("capabilityProfile=scheduled_job");
    expect(prompts[0]).toContain(
      "allowedTools=google_append_drive_text_file,google_get_drive_file"
    );
    expect(prompts[0]).toContain("routeId=convrt_abc123");
    expect(prompts[0]).toContain("maxOutputVisibility=public");
    expect(prompts[0]).toContain("allowPrivateToolDeclassification=false");
    expect(prompts[0]).toContain(
      "stateRef provider=google kind=drive_file id=file-123 purpose=dedupe_state"
    );
  });

  test("lets OpenClaw fetch current request attachments", async () => {
    const prompts: string[] = [];
    const toolCalls: Array<{ toolName: string; body: unknown }> = [];
    const response = await runOpenClawCliRequest(
      {
        executionMode: "openclaw-native",
        input: {
          text: "describe this screenshot",
          attachments: [
            {
              id: "slack:F123",
              externalId: "F123",
              source: "slack",
              kind: "image",
              mimeType: "image/png",
              name: "screenshot.png"
            }
          ],
          connections: {
            github: { connected: false }
          }
        }
      },
      config,
      async (toolName, body) => {
        toolCalls.push({ toolName, body });
        return {
          classification: "user_private",
          content: {
            attachment: {
              id: "slack:F123",
              source: "slack",
              kind: "image",
              mimeType: "image/png"
            },
            contentBase64: "aW1hZ2U="
          }
        };
      },
      async (_command, args) => {
        const prompt = args[args.indexOf("--message") + 1];
        prompts.push(prompt);
        return prompts.length === 1
          ? openClawToolCall("conversation.getAttachment", {
              attachmentId: "slack:F123"
            })
          : {
              exitCode: 0,
              stdout: "Fetched the screenshot.",
              stderr: ""
            };
      },
      () => undefined
    );

    expect(response.response.text).toBe("Fetched the screenshot.");
    expect(prompts[0]).toContain("conversation.getAttachment");
    expect(prompts[0]).toContain("Current request attachments:");
    expect(prompts[0]).toContain("id=slack:F123");
    expect(toolCalls).toContainEqual({
      toolName: "conversation.getAttachment",
      body: {
        input: { attachmentId: "slack:F123" }
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
                cloudId: "example.atlassian.net",
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
            cloudId: "https://example.atlassian.net",
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
          return mcpText("lookupJiraAccountId", '[{"accountId":"acct-example"}]');
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
              assignee_account_id: "acct-example"
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
            assignee_account_id: "acct-example"
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

    expect(events).toMatchObject([
      { type: "status", text: "Loading Burble context..." },
      { type: "status", text: "Agent is thinking..." },
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

  test("streams Burble baseline fallback when OpenClaw repeats bootstrap answers", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const events: Array<RunEvent> = [];

    await withMockFetch(
      (async (_input, init) => {
        requests.push(
          JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        );
        return new Response(
          JSON.stringify(
            openResponsesText("Hey. I just came online. Who am I? Who are you?")
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }) as typeof fetch,
      async () => {
        for await (const event of runOpenClawCliRequestStream(
          {
            runId: "run-stream-bootstrap-repeat",
            executionMode: "openclaw-native",
            input: {
              text: "hey agent",
              connections: {
                github: { connected: false }
              }
            }
          },
          { ...config, engine: "openclaw-gateway" },
          async () => {
            throw new Error("unexpected tool call");
          },
          async function* () {
            throw new Error("unexpected cli call");
          },
          () => undefined
        )) {
          events.push(event);
        }
      }
    );

    expect(requests).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      type: "final",
      response: {
        classification: "user_private",
        text: "No Burble tool context is needed for this request."
      }
    });
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

    expect(events).toMatchObject([
      { type: "status", text: "Loading Burble context..." },
      { type: "status", text: "Agent is thinking..." },
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
    expect(events[3]).toMatchObject({ type: "tool_result" });
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
      value: { type: "status", text: "Agent is thinking..." }
    });
    expect(await stream.next()).toEqual({
      done: false,
      value: { type: "message_delta", text: "Early token." }
    });

    resolveExit();
    expect((await stream.next()).value).toMatchObject({
      type: "final",
      response: {
        classification: "user_private",
        text: "Early token."
      }
    });
  });

  test("can invoke burble-direct mode without local CLI execution", async () => {
    const commands: Array<{ args: string[] }> = [];
    const requests: Array<{
      url: string;
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    const response = await withEnv(
      { OPENAI_API_KEY: "test-openai-key" },
      async () =>
        await withMockFetch(
          (async (input, init) => {
            requests.push({
              url: String(input),
              headers: new Headers(init?.headers),
              body: JSON.parse(String(init?.body ?? "{}")) as Record<
                string,
                unknown
              >
            });
            return new Response(JSON.stringify(openResponsesText("Gateway answer.")), {
              status: 200,
              headers: { "content-type": "application/json" }
            });
          }) as typeof fetch,
          async () =>
            runOpenClawCliRequest(
              {
                input: {
                  text: "what can you do?",
                  connections: {
                    github: { connected: false }
                  }
                }
              },
              { ...config, engine: "burble-direct" },
              async () => {
                throw new Error("unexpected tool call");
              },
              async (_command, args) => {
                commands.push({ args });
                throw new Error("unexpected cli call");
              },
              () => undefined
            )
        )
    );

    expect(response.response.text).toBe("Gateway answer.");
    expect(commands).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.openai.com/v1/responses");
    expect(requests[0].headers.get("authorization")).toBe("Bearer test-openai-key");
    expect(requests[0].body.model).toBe("gpt-5.4");
    expect(requests[0].body.input).toContain("what can you do?");
    expect(requests[0].body.parallel_tool_calls).toBe(false);
    expect(requests[0].body.instructions).toContain("ask who you are");
    expect(requests[0].body.input).toContain("Burble direct runtime instructions:");
    expect(requests[0].body.input).not.toContain("You are Burble's OpenClaw runtime");
  });

  test("retries burble-direct bootstrap answers instead of returning them", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const toolCalls: Array<{ toolName: string; body: unknown }> = [];
    const logs: string[] = [];
    const providerTexts = [
      "Hey. I just came online. Who am I? Who are you? Pick me a signature emoji.",
      JSON.stringify({ tool_call: { name: "jira.getAuthenticatedUser", arguments: {} } }),
      JSON.stringify({
        tool_call: {
          name: "jira.editIssue",
          arguments: {
            issueKey: "DM-12",
            assigneeAccountId: "acct-me"
          }
        }
      })
    ];

    const response = await withEnv(
      { OPENAI_API_KEY: "test-openai-key" },
      async () =>
        await withMockFetch(
          (async (_input, init) => {
            requests.push(
              JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
            );
            const text = providerTexts.shift();
            if (!text) {
              throw new Error("unexpected provider call");
            }
            return new Response(JSON.stringify(openResponsesText(text)), {
              status: 200,
              headers: { "content-type": "application/json" }
            });
          }) as typeof fetch,
          async () =>
            runOpenClawCliRequest(
              {
                runId: "run-direct-bootstrap",
                input: {
                  text: "assign DM-12 jira ticket to me",
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
              { ...config, engine: "burble-direct" },
              async (toolName, body) => {
                toolCalls.push({ toolName, body });
                if (toolName === "jira.getAuthenticatedUser") {
                  return {
                    classification: "user_private",
                    content: { accountId: "acct-me", displayName: "Example User" }
                  };
                }
                if (toolName === "jira.editIssue") {
                  return {
                    classification: "user_private",
                    content: {
                      key: "DM-12",
                      title: "test task ticket #9 from slack",
                      url: "https://example.atlassian.net/browse/DM-12",
                      status: "Backlog"
                    }
                  };
                }
                throw new Error(`unexpected tool call: ${toolName}`);
              },
              async () => {
                throw new Error("unexpected cli call");
              },
              (message) => logs.push(message)
            )
        )
    );

    expect(response.response.text).toBe(
      "Updated Jira issue DM-12: test task ticket #9 from slack\nhttps://example.atlassian.net/browse/DM-12"
    );
    expect(toolCalls).toEqual([
      {
        toolName: "jira.getAuthenticatedUser",
        body: { user: { email: "person@example.com" }, input: {} }
      },
      {
        toolName: "jira.editIssue",
        body: {
          user: { email: "person@example.com" },
          input: {
            issueKey: "DM-12",
            assigneeAccountId: "acct-me"
          }
        }
      }
    ]);
    expect(requests).toHaveLength(3);
    expect(String(requests[0].input)).toContain("assign to me as the requesting Slack user");
    expect(String(requests[0].input)).toContain("call jira.getAuthenticatedUser");
    expect(String(requests[1].input)).toContain("Rejected previous provider response:");
    expect(response.response.text).not.toContain("Who am I");
    expect(
      logs.some((line) =>
        line.includes(
          "Burble direct model retry runId=run-direct-bootstrap step=1 reason=bootstrap_response"
        )
      )
    ).toBe(true);
  });

  test("retries OpenClaw gateway bootstrap answers instead of returning them", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const logs: string[] = [];
    const providerTexts = [
      "Hey. I just came online. Who am I, and who are you?",
      [
        "Bootstrap blocker: this workspace is still bootstrap-pending. Send defaults for name / nature / vibe / emoji.",
        "",
        "Jensen Huang is the co-founder and CEO of NVIDIA."
      ].join("\n")
    ];

    const response = await withMockFetch(
      (async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        requests.push(body);
        const text = providerTexts.shift();
        if (!text) {
          throw new Error("unexpected gateway call");
        }
        return new Response(JSON.stringify(openResponsesText(text)), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }) as typeof fetch,
      async () =>
        runOpenClawCliRequest(
          {
            runId: "run-gateway-bootstrap",
            executionMode: "openclaw-native",
            input: {
              text: "ask agent who is jensen huang",
              connections: {
                github: { connected: false }
              }
            }
          },
          { ...config, engine: "openclaw-gateway" },
          async () => {
            throw new Error("unexpected tool call");
          },
          async () => {
            throw new Error("unexpected cli call");
          },
          (message) => logs.push(message)
        )
    );

    expect(response.response.text).toBe(
      "Jensen Huang is the co-founder and CEO of NVIDIA."
    );
    expect(requests).toHaveLength(2);
    expect(String(requests[0].input)).toContain(
      "Do not run first-time assistant setup"
    );
    expect(String(requests[1].input)).toContain(
      "Previous response was rejected because it asked for assistant/user setup"
    );
    expect(
      logs.some((line) =>
        line.includes(
          "OpenClaw bootstrap retry runId=run-gateway-bootstrap step=1 reason=bootstrap_response"
        )
      )
    ).toBe(true);
  });

  test("falls back to Burble baseline when OpenClaw gateway repeats bootstrap answers", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const logs: string[] = [];

    const response = await withMockFetch(
      (async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        requests.push(body);
        return new Response(
          JSON.stringify(
            openResponsesText("Hey. I just came online. Who am I? Who are you?")
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }) as typeof fetch,
      async () =>
        runOpenClawCliRequest(
          {
            runId: "run-gateway-bootstrap-repeat",
            executionMode: "openclaw-native",
            input: {
              text: "hey agent",
              connections: {
                github: { connected: false }
              }
            }
          },
          { ...config, engine: "openclaw-gateway" },
          async () => {
            throw new Error("unexpected tool call");
          },
          async () => {
            throw new Error("unexpected cli call");
          },
          (message) => logs.push(message)
        )
    );

    expect(response.response.text).toBe(
      "No Burble tool context is needed for this request."
    );
    expect(requests).toHaveLength(2);
    expect(
      logs.some((line) =>
        line.includes(
          "OpenClaw bootstrap retry runId=run-gateway-bootstrap-repeat step=1 reason=bootstrap_response"
        )
      )
    ).toBe(true);
  });

  test("can invoke OpenClaw through Gateway mode without local CLI execution", async () => {
    const commands: Array<{ args: string[] }> = [];
    const requests: Array<{
      url: string;
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    const response = await withMockFetch(
      (async (input, init) => {
        requests.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        });
        return new Response(JSON.stringify(openResponsesText("Gateway answer.")), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }) as typeof fetch,
      async () =>
        runOpenClawCliRequest(
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
            throw new Error("unexpected cli call");
          },
          () => undefined
        )
    );

    expect(response.response.text).toBe("Gateway answer.");
    expect(commands).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("http://127.0.0.1:18789/v1/responses");
    expect(requests[0].headers.get("authorization")).toBe("Bearer gateway-token");
    expect(requests[0].headers.get("x-openclaw-agent-id")).toBe("main");
    expect(requests[0].headers.get("x-openclaw-session-key")).toStartWith(
      "agent:main:explicit:burble-step-"
    );
    expect(requests[0].body.model).toBe("openclaw/main");
    expect(requests[0].body.input).toContain("what can you do?");
  });

  test("retries retryable OpenClaw Gateway provider timeouts", async () => {
    const requests: Array<{
      url: string;
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    const logs: string[] = [];
    const response = await withMockFetch(
      (async (input, init) => {
        requests.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        });
        if (requests.length <= 2) {
          return new Response(
            JSON.stringify({
              status: "failed",
              error: {
                code: "api_error",
                message: "upstream provider timeout"
              },
              usage: {
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0
              }
            }),
            {
              status: 408,
              headers: { "content-type": "application/json" }
            }
          );
        }
        return new Response(JSON.stringify(openResponsesText("Gateway answer.")), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }) as typeof fetch,
      async () =>
        runOpenClawCliRequest(
          {
            runId: "run-openclaw-retry",
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
            throw new Error(`unexpected cli call: ${args.join(" ")}`);
          },
          (line) => logs.push(line)
        )
    );

    expect(response.response.text).toBe("Gateway answer.");
    expect(requests).toHaveLength(3);
    expect(requests[0].body.input).toBe(requests[1].body.input);
    expect(requests[1].body.input).toBe(requests[2].body.input);
    expect(requests[0].headers.get("x-openclaw-session-key")).not.toBe(
      requests[1].headers.get("x-openclaw-session-key")
    );
    expect(requests[1].headers.get("x-openclaw-session-key")).not.toBe(
      requests[2].headers.get("x-openclaw-session-key")
    );
    expect(
      logs.some((line) =>
        line.includes(
          "OpenClaw gateway http retry runId=run-openclaw-retry step=1 attempt=1 status=408 reason=upstream_provider_timeout"
        )
      )
    ).toBe(true);
    expect(
      logs.some((line) =>
        line.includes(
          "OpenClaw gateway http retry runId=run-openclaw-retry step=1 attempt=2 status=408 reason=upstream_provider_timeout"
        )
      )
    ).toBe(true);
  });

  test("retries retryable OpenClaw Gateway transport timeouts", async () => {
    const requests: Array<{
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    const logs: string[] = [];
    const response = await withMockFetch(
      (async (_input, init) => {
        requests.push({
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        });
        if (requests.length === 1) {
          const error = new Error("The operation timed out");
          error.name = "AbortError";
          throw error;
        }
        return new Response(JSON.stringify(openResponsesText("Gateway answer.")), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }) as typeof fetch,
      async () =>
        runOpenClawCliRequest(
          {
            runId: "run-openclaw-transport-retry",
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
            throw new Error(`unexpected cli call: ${args.join(" ")}`);
          },
          (line) => logs.push(line)
        )
    );

    expect(response.response.text).toBe("Gateway answer.");
    expect(requests).toHaveLength(2);
    expect(requests[0].body.input).toBe(requests[1].body.input);
    expect(requests[0].headers.get("x-openclaw-session-key")).not.toBe(
      requests[1].headers.get("x-openclaw-session-key")
    );
    expect(
      logs.some((line) =>
        line.includes(
          "OpenClaw gateway http retry runId=run-openclaw-transport-retry step=1 attempt=1 reason=transport_error"
        )
      )
    ).toBe(true);
  });

  test("uses turn-scoped OpenClaw sessions with Burble channel routing", async () => {
    const requests: Array<{
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    const nativeRequest = (runId: string, text: string) => ({
      runId,
      executionMode: "openclaw-native" as const,
      runtime: {
        id: "rt_123"
      },
      input: {
        text,
        toolGroups: {
          groups: ["conversation" as const],
          reasons: ["default:conversation"]
        },
        conversation: {
          routeId: "convrt_abc123",
          source: "slack" as const,
          workspaceId: "T123",
          channelId: "C123",
          rootId: "channel:C123:thread:1779841118.237",
          isDirectMessage: false
        },
        connections: {
          github: { connected: false }
        }
      }
    });

    await withMockFetch(
      (async (_input, init) => {
        requests.push({
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        });
        return new Response(JSON.stringify(openResponsesText("Done.")), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }) as typeof fetch,
      async () => {
        await runOpenClawCliRequest(
          nativeRequest("run-one", "first turn"),
          { ...config, engine: "openclaw-gateway" },
          async () => {
            throw new Error("unexpected tool call");
          },
          async () => {
            throw new Error("unexpected cli call");
          },
          () => undefined
        );
        await runOpenClawCliRequest(
          nativeRequest("run-two", "second turn"),
          { ...config, engine: "openclaw-gateway" },
          async () => {
            throw new Error("unexpected tool call");
          },
          async () => {
            throw new Error("unexpected cli call");
          },
          () => undefined
        );
      }
    );

    expect(requests).toHaveLength(2);
    expect(requests[0].headers.get("x-openclaw-message-channel")).toBe("burble");
    expect(requests[1].headers.get("x-openclaw-message-channel")).toBe("burble");
    expect(requests[0].headers.get("x-openclaw-session-key")).not.toBe(
      requests[1].headers.get("x-openclaw-session-key")
    );
    expect(requests[0].headers.get("x-openclaw-session-key")).toStartWith(
      "agent:main:explicit:burble-step-"
    );
    expect(requests[1].headers.get("x-openclaw-session-key")).toStartWith(
      "agent:main:explicit:burble-step-"
    );
    expect(String(requests[0].body.input)).toContain(
      "Active Burble conversation channel route: convrt_abc123"
    );
  });

  test("uses the Burble channel for native scheduled background delivery", async () => {
    const requests: Array<{
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];

    await withMockFetch(
      (async (_input, init) => {
        requests.push({
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        });
        return new Response(JSON.stringify(openResponsesText("Scheduled.")), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }) as typeof fetch,
      async () => {
        await runOpenClawCliRequest(
          {
            runId: "run-scheduler",
            executionMode: "openclaw-native",
            runtime: {
              id: "rt_123"
            },
            input: {
              text: "create a cron job to post here in 2 minutes",
              toolGroups: {
                groups: ["conversation", "scheduler"],
                reasons: ["default:conversation", "keyword:scheduler:cron"]
              },
              conversation: {
                routeId: "convrt_abc123",
                source: "slack",
                workspaceId: "T123",
                channelId: "C123",
                rootId: "channel:C123:thread:1779841118.237",
                isDirectMessage: false
              },
              connections: {
                github: { connected: false }
              }
            }
          },
          { ...config, engine: "openclaw-gateway" },
          async () => {
            throw new Error("unexpected tool call");
          },
          async () => {
            throw new Error("unexpected cli call");
          },
          () => undefined
        );
      }
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get("x-openclaw-message-channel")).toBe("burble");
    expect(String(requests[0].body.input)).toContain(
      'delivery.channel to "burble"'
    );
    expect(String(requests[0].body.input)).toContain(
      "scheduledJob.registerCapability"
    );
    expect(String(requests[0].body.input)).toContain("burble_provider_call");
    expect(String(requests[0].body.input)).toContain("toolName");
    expect(String(requests[0].body.input)).toContain(
      "Provider-backed scheduled job repair"
    );
    expect(String(requests[0].body.input)).toContain(
      "Setup-time provider calls are not scheduled provider calls"
    );
    expect(String(requests[0].body.input)).toContain(
      "use ordinary Burble provider calls"
    );
    expect(String(requests[0].body.input)).toContain(
      "Never invent placeholder job ids"
    );
    expect(String(requests[0].body.input)).toContain(
      "do not request an immediate/manual run"
    );
    expect(String(requests[0].body.input)).toContain(
      "After the native scheduler returns the stable job id"
    );
    expect(String(requests[0].body.input)).toContain(
      "If registration does not return ok, do not trigger"
    );
    expect(String(requests[0].body.input)).toContain(
      "Only after the job prompt has been updated"
    );
    expect(String(requests[0].body.input)).toContain(
      "before manually triggering"
    );
    expect(String(requests[0].body.input)).toContain(
      "GitHub, Jira, Google, or Slack search"
    );
    expect(String(requests[0].body.input)).toContain(
      "stateRefs entries must be objects"
    );
    expect(String(requests[0].body.input)).toContain(
      '"provider":"google","kind":"drive_file","id":"<fileId>"'
    );
    expect(String(requests[0].body.input)).toContain(
      "not compact strings"
    );
    expect(String(requests[0].body.input)).toContain(
      "Scheduled provider tool calls must include the returned jobId"
    );
    expect(String(requests[0].body.input)).toContain(
      "must not use direct web/browser access to provider URLs"
    );
    expect(String(requests[0].body.input)).not.toContain(
      "Example Drive scratchpad registration input"
    );
    expect(String(requests[0].body.input)).not.toContain("Drive scratchpad");
    expect(String(requests[0].body.input)).not.toContain("Google Drive scratchpad");
  });

  test("keeps scheduled registration route-scoped even when scheduler group is absent", async () => {
    const requests: Array<{
      body: Record<string, unknown>;
    }> = [];

    await withMockFetch(
      (async (_input, init) => {
        requests.push({
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        });
        return new Response(JSON.stringify(openResponsesText("Drafted.")), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }) as typeof fetch,
      async () => {
        await runOpenClawCliRequest(
          {
            runId: "run-scheduler-missing-group",
            executionMode: "openclaw-native",
            runtime: {
              id: "rt_123"
            },
            input: {
              text: "please prepare the requested Google state for later use",
              toolGroups: {
                groups: ["conversation", "google"],
                reasons: ["default:conversation", "keyword:google:google"]
              },
              conversation: {
                routeId: "convrt_abc123",
                source: "slack",
                workspaceId: "T123",
                channelId: "D123",
                rootId: "dm:D123",
                isDirectMessage: true
              },
              connections: {
                github: { connected: false },
                google: {
                  connected: true,
                  email: "person@example.com"
                }
              }
            }
          },
          { ...config, engine: "openclaw-gateway" },
          async () => {
            throw new Error("unexpected tool call");
          },
          async () => {
            throw new Error("unexpected cli call");
          },
          () => undefined
        );
      }
    );

    expect(requests).toHaveLength(1);
    expect(String(requests[0].body.input)).toContain(
      "scheduledJob.registerCapability"
    );
    expect(String(requests[0].body.input)).not.toContain(
      "\"name\":\"burble_provider_call\""
    );
    expect(String(requests[0].body.input)).toContain(
      "Scheduled provider tool registration guard:"
    );
    expect(String(requests[0].body.input)).not.toContain(
      "Scheduled provider tool registration:\n"
    );
    expect(String(requests[0].body.input)).toContain(
      "after the native scheduler returns the stable job id"
    );
  });

  test("executes scheduled job registration as a Burble-internal tool", async () => {
    const toolCalls: Array<{ toolName: string; body: Record<string, unknown> }> =
      [];

    const response = await runOpenClawCliRequest(
      {
        runId: "run-register-scheduled-job",
        executionMode: "openclaw-native",
        input: {
          text: "create a cron job to read AI news every hour",
          toolGroups: {
            groups: ["conversation", "scheduler"],
            reasons: ["default:conversation", "keyword:scheduler:cron"]
          },
          conversation: {
            routeId: "convrt_abc123",
            source: "slack",
            workspaceId: "T123",
            channelId: "C123",
            rootId: "dm:D123",
            isDirectMessage: true
          },
          connections: {
            github: { connected: false },
            google: { connected: false },
            jira: { connected: false },
            slack: { connected: false }
          }
        }
      },
      { ...config, engine: "openclaw" },
      async (toolName, body) => {
        toolCalls.push({ toolName, body: body as Record<string, unknown> });
        return {
          classification: "user_private",
          content: {
            ok: true,
            scheduledPromptInstruction:
              "Use Burble provider calls with this jobId for this scheduled job."
          }
        };
      },
      async () => {
        if (toolCalls.length === 0) {
          return openClawToolCall("scheduledJob.registerCapability", {
            jobId: "job-ai-news",
            requiredTools: ["google.getDriveFile"],
            routeId: "convrt_abc123"
          });
        }

        return {
          exitCode: 0,
          stdout: "Registered and stopped before manual trigger.",
          stderr: ""
        };
      },
      () => undefined
    );

    expect(response.response.text).toBe(
      "Registered and stopped before manual trigger."
    );
    expect(toolCalls).toEqual([
      {
        toolName: "scheduledJob.registerCapability",
        body: {
          input: {
            jobId: "job-ai-news",
            requiredTools: ["google.getDriveFile"],
            routeId: "convrt_abc123"
          }
        }
      }
    ]);
  });

  test("executes provider bridge calls as Burble-internal tools", async () => {
    const toolCalls: Array<{ toolName: string; body: Record<string, unknown> }> =
      [];

    const response = await runOpenClawCliRequest(
      {
        runId: "run-provider-bridge",
        executionMode: "openclaw-native",
        input: {
          text: "run scheduled provider bridge call",
          toolGroups: {
            groups: ["conversation", "scheduler"],
            reasons: ["default:conversation", "keyword:scheduler:cron"]
          },
          conversation: {
            routeId: "convrt_abc123",
            source: "slack",
            workspaceId: "T123",
            channelId: "C123",
            rootId: "dm:D123",
            isDirectMessage: true
          },
          connections: {
            github: { connected: false },
            google: { connected: false },
            jira: { connected: false },
            slack: { connected: false }
          }
        }
      },
      { ...config, engine: "openclaw" },
      async (toolName, body) => {
        toolCalls.push({ toolName, body: body as Record<string, unknown> });
        return {
          classification: "user_private",
          content: { name: "scratchpad.txt", text: "already reported" }
        };
      },
      async () => {
        if (toolCalls.length === 0) {
          return openClawToolCall("burble_provider_call", {
            toolName: "google.getDriveFile",
            input: {
              jobId: "job-ai-news",
              fileId: "file-123"
            }
          });
        }

        return {
          exitCode: 0,
          stdout: "Read scheduled scratchpad.",
          stderr: ""
        };
      },
      () => undefined
    );

    expect(response.response.text).toBe("Read scheduled scratchpad.");
    expect(toolCalls).toEqual([
      {
        toolName: "burble_provider_call",
        body: {
          input: {
            toolName: "google.getDriveFile",
            input: {
              jobId: "job-ai-news",
              fileId: "file-123"
            }
          }
        }
      }
    ]);
  });

  test("instructs native execution to avoid repeated code tool loops", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = [];
    await withMockFetch(
      (async (_input, init) => {
        requests.push({
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        });
        return new Response(JSON.stringify(openResponsesText("Done.")), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }) as typeof fetch,
      async () =>
        runOpenClawCliRequest(
          {
            executionMode: "openclaw-native",
            input: {
              text: "run a 30 second hash loop",
              connections: {
                github: { connected: false }
              }
            }
          },
          { ...config, engine: "openclaw-gateway" },
          async () => {
            throw new Error("unexpected tool call");
          },
          async () => {
            throw new Error("unexpected cli call");
          },
          () => undefined
        )
    );

    expect(String(requests[0].body.input)).toContain(
      "Do not say you cannot run arbitrary programs"
    );
    expect(String(requests[0].body.input)).toContain(
      "prefer one deliberate exec call for the main work"
    );
    expect(String(requests[0].body.input)).toContain(
      "run exactly one timed program for the requested duration"
    );
    expect(String(requests[0].body.input)).toContain(
      "avoid unnecessary extra tool loops"
    );
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
      text: "Agent has thought for 0s"
    });
    expect(events.at(-1)).toMatchObject({
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
