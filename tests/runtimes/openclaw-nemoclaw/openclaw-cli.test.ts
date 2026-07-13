import { describe, expect, test } from "bun:test";
import {
  resolveOpenClawCliArgv,
  resolveOpenClawCliCommand,
  resolveOpenClawProviderCorrelationId,
  runCliCommand,
  runCliCommandStream,
  runOpenClawCliRequest,
  runOpenClawCliRequestStream
} from "../../../runtimes/openclaw-nemoclaw/src/openclaw-cli";
import type { RuntimeConfig } from "../../../runtimes/openclaw-nemoclaw/src/config";
import type { RunEvent } from "../../../runtimes/openclaw-nemoclaw/src/types";
import { providerToolCatalog } from "../../../src/providers/catalog";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

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
  openClawGatewayRetryBaseMs: 1,
  openClawGatewayRetryMaxMs: 2,
  llmModel: "openai:gpt-5.4",
  ollamaBaseUrl: "https://ollama.com"
};

describe("OpenClaw CLI command resolution", () => {
  test("uses explicit node argv inside sandboxed runtime images", () => {
    const existingPaths = new Set([
      "/usr/local/bin/openclaw",
      "/usr/local/lib/node_modules/openclaw/openclaw.mjs"
    ]);
    const commandExists = (path: string) => existingPaths.has(path);

    expect(resolveOpenClawCliArgv("openclaw", ["agent"], commandExists)).toEqual([
      "/usr/local/bin/node",
      "/usr/local/lib/node_modules/openclaw/openclaw.mjs",
      "agent"
    ]);
    expect(resolveOpenClawCliCommand("openclaw", () => true)).toBe(
      "/usr/local/bin/openclaw"
    );
    expect(resolveOpenClawCliCommand("openclaw", () => false)).toBe("openclaw");
    expect(resolveOpenClawCliCommand("/custom/openclaw", () => true)).toBe(
      "/custom/openclaw"
    );
  });
});

describe("OpenClaw provider correlation", () => {
  test("hashes the internal session id used as the downstream prompt cache key", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "burble-openclaw-correlation-"));
    const sessionsDir = join(stateDir, "agents", "main", "sessions");
    const sessionKey = "agent:main:explicit:burble-step-example";
    const internalSessionId = "566217da-d5a3-4afb-a65c-2048d7f6e79c";
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, "sessions.json"),
      JSON.stringify({ [sessionKey]: { sessionId: internalSessionId } })
    );

    expect(
      await resolveOpenClawProviderCorrelationId(
        { ...config, openClawStateDir: stateDir },
        "main",
        sessionKey
      )
    ).toBe(
      createHash("sha256").update(internalSessionId).digest("hex").slice(0, 16)
    );
  });
});

describe("OpenClaw CLI process timeouts", () => {
  test("command runner throws promptly even when the child ignores SIGTERM", async () => {
    const startedAt = Date.now();

    await expect(
      runCliCommand("/bin/sh", ["-c", "trap '' TERM; sleep 2"], {
        timeoutMs: 20
      })
    ).rejects.toThrow("OpenClaw CLI timed out");

    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  test("command runner force-kills children that ignore SIGTERM", async () => {
    const dir = await mkdtemp(join(tmpdir(), "burble-openclaw-timeout-"));
    const pidPath = join(dir, "pid");

    await expect(
      runCliCommand(
        "/bin/sh",
        [
          "-c",
          `echo $$ > ${JSON.stringify(pidPath)}; trap '' TERM; while true; do sleep 1; done`
        ],
        { timeoutMs: 20 }
      )
    ).rejects.toThrow("OpenClaw CLI timed out");

    const pid = Number((await readFile(pidPath, "utf8")).trim());
    await waitUntilProcessExits(pid);
    expect(isProcessAlive(pid)).toBe(false);
  });

  test("stream runner throws promptly even when the child ignores SIGTERM", async () => {
    const startedAt = Date.now();

    await expect(
      (async () => {
        for await (const _event of runCliCommandStream(
          "/bin/sh",
          ["-c", "trap '' TERM; sleep 2"],
          { timeoutMs: 20 }
        )) {
          // Drain the stream until it fails.
        }
      })()
    ).rejects.toThrow("OpenClaw CLI timed out");

    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  test("stream runner kills the child when the consumer stops early", async () => {
    const dir = await mkdtemp(join(tmpdir(), "burble-openclaw-stream-return-"));
    const pidPath = join(dir, "pid");
    const iterator = runCliCommandStream(
      "/bin/sh",
      [
        "-c",
        `echo $$ > ${JSON.stringify(pidPath)}; echo ready; trap '' TERM; while true; do sleep 1; done`
      ],
      { timeoutMs: 60_000 }
    )[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ type: "stdout", text: "ready\n" });
    await iterator.return?.();

    const pid = Number((await readFile(pidPath, "utf8")).trim());
    await waitUntilProcessExits(pid);
    expect(isProcessAlive(pid)).toBe(false);
  });
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilProcessExits(pid: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_500) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

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

function openResponsesText(text: string, usage: Record<string, unknown> = {
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

function providerManifest() {
  return {
    version: "1",
    policyHash: "policy-123",
    skills: [],
    memory: {
      userMemoryEnabled: false,
      workspaceMemoryEnabled: false,
      jobMemoryEnabled: false
    },
    tools: providerToolCatalog.map((tool) => ({
      name: tool.name,
      alias: tool.alias,
      provider: tool.provider,
      enabled: true
    }))
  };
}

describe("runOpenClawCliRequest", () => {
  test("builds provider catalog from MCP tools/list metadata", async () => {
    const prompts: string[] = [];

    const response = await runOpenClawCliRequest(
      {
        runtime: {
          id: "rt_test",
          manifest: providerManifest(),
        },
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

  test("maps discovered MCP tools through runtime manifest aliases", async () => {
    const prompts: string[] = [];

    const response = await runOpenClawCliRequest(
      {
        runtime: {
          id: "rt_test",
          manifest: {
            version: "1",
            policyHash: "policy-123",
            skills: [],
            memory: {
              userMemoryEnabled: false,
              workspaceMemoryEnabled: false,
              jobMemoryEnabled: false
            },
            tools: [
              {
                name: "google_future_tool",
                alias: "google.futureTool",
                provider: "google",
                enabled: true
              }
            ]
          }
        },
        input: {
          text: "use a new Google tool",
          toolGroups: {
            groups: ["conversation", "google"],
            reasons: ["test"]
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
      {
        ...config,
        mcpGatewayUrl: "http://agentgateway:3000/mcp",
        runtimeJwt: "runtime-jwt"
      },
      async (toolName) => {
        if (toolName !== "burble.mcp.listTools") {
          throw new Error(`unexpected scheduled baseline tool call: ${toolName}`);
        }
        if (toolName === "burble.mcp.listTools") {
          return {
            classification: "user_private",
            content: [
              {
                name: "google_future_tool",
                description: "MCP-discovered future Google tool",
                inputSchema: { type: "object" }
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
    expect(catalogText).toContain("google.futureTool");
    expect(catalogText).toContain("MCP-discovered future Google tool");
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

  test("keeps scheduled web tools visible and hides disallowed provider tools", async () => {
    const prompts: string[] = [];

    const response = await runOpenClawCliRequest(
      {
        executionMode: "native-runtime",
        runtime: {
          id: "rt_test",
          manifest: providerManifest()
        },
        input: {
          text: "look for latest AI news, summarize in two paragraphs and post result in this channel",
          toolGroups: {
            groups: ["conversation"],
            reasons: ["scheduled-job:text"]
          },
          scheduledJob: {
            jobId: "job-ai-news",
            capabilityProfile: "scheduled_job",
            allowedTools: ["web_search"],
            routeId: "convrt_abc123",
            runtimeType: "openclaw",
            stateRefs: [],
            visibilityPolicy: {
              maxOutputVisibility: "public",
              allowPrivateToolDeclassification: false
            }
          },
          connections: {
            github: {
              connected: true,
              email: "person@example.com",
              providerLogin: "octocat"
            },
            google: { connected: false },
            hubspot: { connected: false },
            jira: { connected: false },
            slack: { connected: false }
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
                name: "web_search",
                description: "Search public web/news sources",
                inputSchema: {}
              },
              {
                name: "github_list_assigned_issues",
                description: "Should be hidden for web-only scheduled jobs",
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
              text: "News summary posted."
            }
          }),
          stderr: ""
        };
      },
      () => undefined
    );

    expect(response.response.text).toBe("News summary posted.");
    const catalogText =
      prompts[0].split("Available Burble tools:\n")[1]?.split("\n\n")[0] ?? "";
    expect(catalogText).toContain("web.search");
    expect(catalogText).not.toContain("github.listAssignedIssues");
    expect(prompts[0]).toContain("allowedTools=web_search");
  });

  test("includes HubSpot tools in discovered and fallback catalogs", async () => {
    const discoveredPrompts: string[] = [];
    const fallbackPrompts: string[] = [];

    const discoveredResponse = await runOpenClawCliRequest(
      {
        runtime: {
          id: "rt_test",
          manifest: providerManifest()
        },
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
            },
            streaming: {
              messageDeltasEnabled: true
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
            streaming: {
              messageDeltasEnabled: true
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
      "OpenClaw model usage diagnostics runId=run-usage step=1 modelStarts=0 fetchStarts=0 streamDone=0 streamDoneElapsedMs=none streamDoneEvents=none providerRequestIds=none compactions=0 exactUsageFields=5 exactUsageAvailable=true rawStreamBytes=0"
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
          "[openai-transport] [responses] start provider=openai api=openai-responses model=gpt-5.4 requestId=req_first123",
          "[provider-transport-fetch] [model-fetch] start provider=openai api=openai-responses model=gpt-5.4",
          "[openai-transport] [responses] stream_done provider=openai api=openai-responses model=gpt-5.4 elapsedMs=3522 events=38",
          "[agent/embedded] [compaction-diag] start runId=session-1",
          "[openai-transport] [responses] start provider=openai api=openai-responses model=gpt-5.4 requestId=req_second456",
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
      "OpenClaw model usage diagnostics runId=run-diagnostics step=1 modelStarts=2 fetchStarts=2 streamDone=2 streamDoneElapsedMs=3522,29406 streamDoneEvents=38,1731 providerRequestIds=req_first123,req_second456 compactions=1 exactUsageFields=0 exactUsageAvailable=false rawStreamBytes=0"
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
            providerRequestIds: ["req_first123", "req_second456"],
            compactions: 1,
            exactUsageFields: 0,
            exactUsageAvailable: false,
            rawStreamBytes: 0
          }
        }
      ]
    });
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
        executionMode: "native-runtime",
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
    expect(prompts[0]).toContain("Native Burble channel delivery");
    expect(prompts[0]).toContain('delivery.mode to "announce"');
    expect(prompts[0]).toContain('delivery.channel to "burble"');
    expect(prompts[0]).toContain('delivery.to to "convrt_abc123"');
    expect(prompts[0]).toContain(
      "do not put the Slack label in delivery.to"
    );
    expect(prompts[0]).toContain(
      "For output that only reads public/open-internet sources, first call scheduledJob.registerCapability with destination set to that label"
    );
    expect(prompts[0]).toContain("omit routeId");
    expect(prompts[0]).toContain("Never send both routeId and destination");
    expect(prompts[0]).toContain(
      'visibilityPolicy {"maxOutputVisibility":"public"}'
    );
    expect(prompts[0]).toContain(
      "If the job reads from authenticated Burble provider sources, do not register the channel destination"
    );
    expect(prompts[0]).toContain(
      "If registration does not return ok with a resolved route, do not update, enable, or trigger the job"
    );
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
        executionMode: "native-runtime",
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

  test("exposes provider bridge during scheduled job execution without active conversation", async () => {
    const prompts: string[] = [];
    await runOpenClawCliRequest(
      {
        executionMode: "native-runtime",
        input: {
          text: "run the scheduled PR monitor",
          toolGroups: {
            groups: ["github", "google"],
            reasons: ["scheduled-job:allowed-tools"]
          },
          scheduledJob: {
            jobId: "job-pr-monitor",
            capabilityProfile: "scheduled_job",
            allowedTools: [
              "github_list_my_pull_requests",
              "google_get_drive_file",
              "google_append_to_drive_text_file"
            ],
            routeId: "convrt_abc123",
            runtimeType: "openclaw",
            stateRefs: [
              {
                provider: "google",
                kind: "drive_file",
                id: "dedupe-file",
                purpose: "dedupe_state"
              }
            ],
            visibilityPolicy: {
              maxOutputVisibility: "user_private",
              allowPrivateToolDeclassification: false
            }
          },
          connections: {
            github: {
              connected: true,
              email: "person@example.com",
              providerLogin: "person"
            },
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
          stdout: "PR monitor run complete.",
          stderr: ""
        };
      },
      () => undefined
    );

    expect(prompts[0]).toContain("Scheduled Burble job context:");
    expect(prompts[0]).toContain("jobId=job-pr-monitor");
    expect(prompts[0]).toContain("Available Burble tools:");
    expect(prompts[0]).toContain("burble_provider_call");
    expect(prompts[0]).toContain(
      "Call one Burble provider tool through the runtime-scoped Burble provider bridge"
    );
    expect(prompts[0]).toContain(
      "For this scheduled job, use only the listed allowedTools"
    );
  });

  test("returns scheduled bridge tool denials as recoverable tool results", async () => {
    const prompts: string[] = [];
    const toolCalls: Array<{ toolName: string; body: unknown }> = [];
    const response = await runOpenClawCliRequest(
      {
        executionMode: "native-runtime",
        runtime: {
          id: "rt_test",
          manifest: providerManifest()
        },
        input: {
          text: "Check for new PRs in the apelogic-ai GitHub org",
          toolGroups: {
            groups: ["github"],
            reasons: ["scheduled-job:allowed-tools"],
          },
          scheduledJob: {
            jobId: "job-pr-monitor",
            capabilityProfile: "scheduled_job",
            allowedTools: ["github_search_issues"],
            routeId: "convrt_abc123",
            runtimeType: "openclaw",
            stateRefs: [],
            visibilityPolicy: {},
          },
          connections: {
            github: {
              connected: true,
              email: "person@example.com",
              providerLogin: "person",
            },
          },
        },
      },
      config,
      async (toolName, body) => {
        toolCalls.push({ toolName, body });
        return {
          classification: "user_private",
          content: {
            items: [
              {
                repo: "apelogic-ai/burble",
                number: 75,
                title: "[codex] Add scheduler task inspection and validation",
              },
            ],
          },
        };
      },
      async (_command, args) => {
        const prompt = args[args.indexOf("--message") + 1];
        prompts.push(prompt);
        if (prompts.length === 1) {
          return openClawToolCall("burble_provider_call", {
            toolName: "github_list_my_pull_requests",
            input: { jobId: "job-pr-monitor" },
          });
        }
        if (prompts.length === 2) {
          return openClawToolCall("burble_provider_call", {
            toolName: "github_search_issues",
            input: {
              jobId: "job-pr-monitor",
              query: "org:apelogic-ai is:pr is:open",
            },
          });
        }
        return {
          exitCode: 0,
          stdout:
            "New PRs in apelogic-ai:\n\n- burble #75 - [codex] Add scheduler task inspection and validation",
          stderr: "",
        };
      },
      () => undefined,
    );

    expect(prompts).toHaveLength(3);
    const catalogText =
      prompts[0].split("Available Burble tools:\n")[1]?.split("\n\n")[0] ??
      "";
    expect(catalogText).toContain("github.searchIssues");
    expect(catalogText).not.toContain("github.listMyPullRequests");
    expect(prompts[1]).toContain("tool_not_allowed_for_task");
    expect(prompts[1]).toContain("github_list_my_pull_requests");
    expect(prompts[1]).toContain("github_search_issues");
    expect(toolCalls).toEqual([
      {
        toolName: "burble_provider_call",
        body: {
          input: {
            toolName: "github_search_issues",
            input: {
              jobId: "job-pr-monitor",
              query: "org:apelogic-ai is:pr is:open",
            },
          },
        },
      },
    ]);
    expect(response.response.text).toContain("burble #75");
  });

  test("repairs an unterminated scheduled provider tool call before executing it", async () => {
    const prompts: string[] = [];
    const toolCalls: Array<{ toolName: string; body: unknown }> = [];
    const logs: string[] = [];
    const validToolCall = JSON.stringify({
      tool_call: {
        name: "burble_provider_call",
        arguments: {
          toolName: "github_search_issues",
          input: {
            jobId: "job-pr-monitor",
            query: "org:apelogic-ai is:pr is:open",
          },
        },
      },
    });
    const responses = [
      validToolCall.slice(0, -1),
      validToolCall,
      "New PRs in apelogic-ai: burble #99",
    ];

    const response = await runOpenClawCliRequest(
      {
        runId: "run-repair-malformed-tool-call",
        executionMode: "native-runtime",
        runtime: {
          id: "rt_test",
          manifest: providerManifest(),
        },
        input: {
          text: "Check for new PRs in the apelogic-ai GitHub org",
          toolGroups: {
            groups: ["github"],
            reasons: ["scheduled-job:allowed-tools"],
          },
          scheduledJob: {
            jobId: "job-pr-monitor",
            capabilityProfile: "scheduled_job",
            allowedTools: ["github_search_issues"],
            routeId: "convrt_abc123",
            runtimeType: "openclaw",
            stateRefs: [],
            visibilityPolicy: {},
          },
          connections: {
            github: {
              connected: true,
              email: "person@example.com",
              providerLogin: "person",
            },
          },
        },
      },
      config,
      async (toolName, body) => {
        toolCalls.push({ toolName, body });
        return {
          classification: "user_private",
          content: { items: [] },
        };
      },
      async (_command, args) => {
        prompts.push(args[args.indexOf("--message") + 1]);
        const stdout = responses.shift();
        if (!stdout) {
          throw new Error("unexpected OpenClaw call");
        }
        return { exitCode: 0, stdout, stderr: "" };
      },
      (message) => logs.push(message),
    );

    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain(
      "Your previous response looked like a Burble tool call but was invalid or incomplete",
    );
    expect(toolCalls).toHaveLength(1);
    expect(response.response.text).toBe("New PRs in apelogic-ai: burble #99");
    expect(logs.join("\n")).toContain(
      "reason=invalid_tool_protocol",
    );
  });

  test("fails closed when OpenClaw repeats an unterminated tool call", async () => {
    const malformed =
      '{"tool_call":{"name":"burble_provider_call","arguments":{"toolName":"github_search_issues","input":{"query":"org:apelogic-ai is:pr is:open"}}}';
    let modelCalls = 0;
    let toolCalls = 0;

    await expect(
      runOpenClawCliRequest(
        {
          runId: "run-repeat-malformed-tool-call",
          executionMode: "native-runtime",
          runtime: {
            id: "rt_test",
            manifest: providerManifest(),
          },
          input: {
            text: "Check for new PRs in the apelogic-ai GitHub org",
            toolGroups: {
              groups: ["github"],
              reasons: ["scheduled-job:allowed-tools"],
            },
            scheduledJob: {
              jobId: "job-pr-monitor",
              capabilityProfile: "scheduled_job",
              allowedTools: ["github_search_issues"],
              routeId: "convrt_abc123",
              runtimeType: "openclaw",
              stateRefs: [],
              visibilityPolicy: {},
            },
            connections: {
              github: {
                connected: true,
                email: "person@example.com",
                providerLogin: "person",
              },
            },
          },
        },
        config,
        async () => {
          toolCalls += 1;
          return { classification: "user_private", content: [] };
        },
        async () => {
          modelCalls += 1;
          return { exitCode: 0, stdout: malformed, stderr: "" };
        },
        () => undefined,
      ),
    ).rejects.toThrow(
      "OpenClaw Gateway repeatedly returned invalid Burble tool-call protocol",
    );

    expect(modelCalls).toBe(2);
    expect(toolCalls).toBe(0);
  });

  test("hides scheduled web provider tools selected by group without a grant", async () => {
    const prompts: string[] = [];
    const toolCalls: Array<{ toolName: string; body: unknown }> = [];
    const response = await runOpenClawCliRequest(
      {
        executionMode: "native-runtime",
        runtime: {
          id: "rt_test",
          manifest: providerManifest()
        },
        input: {
          text: "Search the web for fresh AI news.",
          toolGroups: {
            groups: ["web"],
            reasons: ["scheduled-job:ungrounded-selection"]
          },
          scheduledJob: {
            jobId: "job-ai-news",
            capabilityProfile: "scheduled_job",
            allowedTools: ["github_search_issues"],
            routeId: "convrt_abc123",
            runtimeType: "openclaw",
            stateRefs: [],
            visibilityPolicy: {
              maxOutputVisibility: "public",
              allowPrivateToolDeclassification: false
            }
          },
          connections: {
            github: { connected: false },
            google: { connected: false },
            hubspot: { connected: false },
            jira: { connected: false },
            slack: { connected: false }
          }
        }
      },
      {
        ...config,
        mcpGatewayUrl: "http://agentgateway:3000/mcp",
        runtimeJwt: "runtime-jwt"
      },
      async (toolName, body) => {
        toolCalls.push({ toolName, body });
        if (toolName === "burble.mcp.listTools") {
          return {
            classification: "user_private",
            content: [
              {
                name: "web_search",
                description: "Search public web/news sources",
                inputSchema: {}
              },
              {
                name: "github_search_issues",
                description: "Search GitHub issues and pull requests",
                inputSchema: {}
              }
            ]
          };
        }

        return {
          classification: "public",
          content: { results: [] }
        };
      },
      async (_command, args) => {
        const prompt = args[args.indexOf("--message") + 1];
        prompts.push(prompt);
        return {
          exitCode: 0,
          stdout: "I can only use the granted scheduled task tools.",
          stderr: ""
        };
      },
      () => undefined
    );

    expect(prompts).toHaveLength(1);
    const catalogText =
      prompts[0].split("Available Burble tools:\n")[1]?.split("\n\n")[0] ??
      "";
    expect(catalogText).not.toContain("web.search");
    expect(catalogText).toContain("burble_provider_call");
    expect(toolCalls).toEqual([{ toolName: "burble.mcp.listTools", body: {} }]);
    expect(response.response.text).toContain("granted scheduled task tools");
  });

  test("denies scheduled bridge provider calls when the grant has no allowed tools", async () => {
    const prompts: string[] = [];
    const toolCalls: Array<{ toolName: string; body: unknown }> = [];
    const response = await runOpenClawCliRequest(
      {
        executionMode: "native-runtime",
        runtime: {
          id: "rt_test",
          manifest: providerManifest()
        },
        input: {
          text: "Search GitHub for open PRs.",
          toolGroups: {
            groups: ["github"],
            reasons: ["scheduled-job:empty-grant"]
          },
          scheduledJob: {
            jobId: "job-empty-grant",
            capabilityProfile: "scheduled_job",
            allowedTools: [],
            routeId: "convrt_abc123",
            runtimeType: "openclaw",
            stateRefs: [],
            visibilityPolicy: {}
          },
          connections: {
            github: { connected: true, email: "person@example.com", providerLogin: "person" },
            google: { connected: false },
            hubspot: { connected: false },
            jira: { connected: false },
            slack: { connected: false }
          }
        }
      },
      config,
      async (toolName, body) => {
        toolCalls.push({ toolName, body });
        return {
          classification: "user_private",
          content: { items: [] }
        };
      },
      async (_command, args) => {
        const prompt = args[args.indexOf("--message") + 1];
        prompts.push(prompt);
        if (prompts.length === 1) {
          return openClawToolCall("burble_provider_call", {
            toolName: "github_search_issues",
            input: {
              jobId: "job-empty-grant",
              query: "org:apelogic-ai is:pr is:open"
            }
          });
        }
        return {
          exitCode: 0,
          stdout: "No provider tools are allowed for this scheduled task.",
          stderr: ""
        };
      },
      () => undefined
    );

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("tool_not_allowed_for_task");
    expect(prompts[1]).toContain("github_search_issues");
    expect(toolCalls).toEqual([]);
    expect(response.response.text).toContain("No provider tools are allowed");
  });

  test("lets OpenClaw fetch current request attachments", async () => {
    const prompts: string[] = [];
    const toolCalls: Array<{ toolName: string; body: unknown }> = [];
    const response = await runOpenClawCliRequest(
      {
        executionMode: "native-runtime",
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
            executionMode: "native-runtime",
            input: {
              text: "hey agent",
              connections: {
                github: { connected: false }
              }
            }
          },
          { ...config, engine: "openclaw-gateway" },
          async () => ({
            classification: "user_private",
            content: []
          }),
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

  test("retries streamed OpenClaw gateway baseline echoes before finalizing", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const events: Array<RunEvent> = [];
    const logs: string[] = [];
    const providerTexts = [
      "No Burble tool context is needed for this request.",
      "Hello!"
    ];

    await withMockFetch(
      (async (_input, init) => {
        requests.push(
          JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        );
        const text = providerTexts.shift();
        if (!text) {
          throw new Error("unexpected gateway call");
        }
        return new Response(JSON.stringify(openResponsesText(text)), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }) as typeof fetch,
      async () => {
        for await (const event of runOpenClawCliRequestStream(
          {
            runId: "run-stream-baseline-echo",
            executionMode: "native-runtime",
            input: {
              text: "hello agent",
              connections: {
                github: { connected: false }
              }
            }
          },
          { ...config, engine: "openclaw-gateway" },
          async () => ({
            classification: "user_private",
            content: []
          }),
          async function* () {
            throw new Error("unexpected cli call");
          },
          (message) => logs.push(message)
        )) {
          events.push(event);
        }
      }
    );

    expect(requests).toHaveLength(2);
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "message_delta",
        text: "No Burble tool context is needed for this request."
      })
    );
    expect(events.at(-1)).toMatchObject({
      type: "final",
      response: {
        classification: "user_private",
        text: "Hello!"
      }
    });
    expect(
      logs.some((line) =>
        line.includes(
          "OpenClaw bootstrap retry runId=run-stream-baseline-echo step=1 reason=baseline_echo"
        )
      )
    ).toBe(true);
  });

  test("fails streamed OpenClaw gateway empty responses instead of finalizing with baseline", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const events: Array<RunEvent> = [];

    await expect(
      withMockFetch(
        (async (_input, init) => {
          requests.push(
            JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
          );
          return new Response(JSON.stringify(openResponsesText("")), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }) as typeof fetch,
        async () => {
          for await (const event of runOpenClawCliRequestStream(
            {
              runId: "run-stream-empty-response",
              executionMode: "native-runtime",
              input: {
                text: "hello agent",
                connections: {
                  github: { connected: false }
                }
              }
            },
            { ...config, engine: "openclaw-gateway" },
            async () => ({
              classification: "user_private",
              content: []
            }),
            async function* () {
              throw new Error("unexpected cli call");
            },
            () => undefined
          )) {
            events.push(event);
          }
        }
      )
    ).rejects.toThrow("OpenClaw Gateway returned no assistant text");

    expect(requests).toHaveLength(2);
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "message_delta",
        text: "No Burble tool context is needed for this request."
      })
    );
    expect(events.some((event) => event.type === "final")).toBe(false);
  });

  test("streams OpenClaw gateway HTTP response deltas before the final response", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const events: Array<RunEvent> = [];

    await withMockFetch(
      (async (_input, init) => {
        requests.push(
          JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        );
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            for (const event of [
              {
                type: "response.output_text.delta",
                delta: "Security first."
              },
              {
                type: "response.output_text.delta",
                delta: " Then fix CI."
              },
              {
                type: "response.completed",
                response: openResponsesText("Security first. Then fix CI.", {
                  input_tokens: 1701,
                  output_tokens: 6,
                  total_tokens: 22571,
                  input_tokens_details: {
                    cached_tokens: 20864
                  }
                })
              }
            ]) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
              );
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      }) as typeof fetch,
      async () => {
        for await (const event of runOpenClawCliRequestStream(
          {
            runId: "run-gateway-stream",
            executionMode: "native-runtime",
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
          { ...config, engine: "openclaw-gateway" },
          async () => ({
            classification: "user_private",
            content: []
          }),
          async function* () {
            throw new Error("unexpected cli call");
          },
          () => undefined
        )) {
          events.push(event);
        }
      }
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].stream).toBe(true);
    expect(events).toContainEqual({
      type: "message_delta",
      text: "Security first."
    });
    expect(events).toContainEqual({
      type: "message_delta",
      text: " Then fix CI."
    });
    expect(events.at(-1)).toMatchObject({
      type: "final",
      response: {
        classification: "user_private",
        text: "Security first. Then fix CI.",
        usage: {
          inputTokens: 1701,
          outputTokens: 6,
          totalTokens: 22571,
          cachedInputTokens: 20864
        }
      }
    });
  });

  test("allows a live OpenClaw gateway stream to stay silent within its hard deadline", async () => {
    const events: RunEvent[] = [];

    await withMockFetch(
      (async (_input, _init) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "response.created" })}\n\n`
              )
            );
            setTimeout(() => {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "response.output_text.delta",
                    delta: "Finished after quiet work."
                  })}\n\n`
                )
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            }, 25);
          }
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      }) as typeof fetch,
      async () => {
        for await (const event of runOpenClawCliRequestStream(
          {
            runId: "run-gateway-quiet-stream",
            executionMode: "native-runtime",
            input: {
              text: "say hello after working quietly",
              connections: {
                github: { connected: false }
              }
            }
          },
          {
            ...config,
            engine: "openclaw-gateway",
            openClawTimeoutMs: 250
          },
          async () => ({
            classification: "user_private",
            content: []
          }),
          async function* () {
            throw new Error("unexpected cli call");
          },
          () => undefined
        )) {
          events.push(event);
        }
      }
    );

    expect(events.at(-1)).toMatchObject({
      type: "final",
      response: {
        text: "Finished after quiet work."
      }
    });
  });

  test("keeps OpenClaw gateway HTTP buffered when runtime streaming is disabled", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const events: Array<RunEvent> = [];

    await withMockFetch(
      (async (_input, init) => {
        requests.push(
          JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        );
        return new Response(
          JSON.stringify(openResponsesText("Buffered answer.")),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }) as typeof fetch,
      async () => {
        for await (const event of runOpenClawCliRequestStream(
          {
            runId: "run-gateway-stream-disabled",
            executionMode: "native-runtime",
            runtime: {
              id: "rt_123",
              manifest: {
                version: "1",
                policyHash: "policy",
                skills: [],
                memory: {
                  userMemoryEnabled: false,
                  workspaceMemoryEnabled: false,
                  jobMemoryEnabled: true
                },
                streaming: {
                  messageDeltasEnabled: false
                }
              }
            },
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
          { ...config, engine: "openclaw-gateway" },
          async () => ({
            classification: "user_private",
            content: []
          }),
          async function* () {
            throw new Error("unexpected cli call");
          },
          () => undefined
        )) {
          events.push(event);
        }
      }
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].stream).toBe(false);
    expect(events.filter((event) => event.type === "message_delta")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      type: "final",
      response: {
        classification: "user_private",
        text: "Buffered answer."
      }
    });
  });

  test("treats streamed OpenClaw gateway response failures as errors without leaking protocol JSON", async () => {
    const events: Array<RunEvent> = [];
    const logs: string[] = [];
    let requestCount = 0;

    await expect(
      withMockFetch(
        (async (_input, init) => {
          requestCount += 1;
          const requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<
            string,
            unknown
          >;
          expect(requestBody.stream).toBe(true);
          const stream = new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              for (const event of [
                {
                  type: "response.created",
                  response: {
                    id: "resp_5258f9f7-09c0-40f2-93e0-1cf441df0453",
                    object: "response",
                    created_at: 1782333954,
                    status: "in_progress",
                    model: "openclaw/main",
                    output: [],
                    usage: {
                      input_tokens: 0,
                      output_tokens: 0,
                      total_tokens: 0
                    }
                  }
                },
                {
                  type: "response.output_item.added",
                  output_index: 0,
                  item: {
                    type: "message",
                    id: "msg_76a6820c-9004-4fa0-a0fb-c4152299cc61",
                    role: "assistant",
                    content: [{ type: "output_text", text: "" }],
                    status: "in_progress"
                  }
                },
                {
                  type: "response.failed",
                  response: {
                    id: "resp_5258f9f7-09c0-40f2-93e0-1cf441df0453",
                    object: "response",
                    created_at: 1782333961,
                    status: "failed",
                    model: "openclaw/main",
                    output: [],
                    usage: {
                      input_tokens: 0,
                      output_tokens: 0,
                      total_tokens: 0
                    },
                    error: {
                      code: "api_error",
                      message: "upstream provider timeout"
                    }
                  }
                }
              ]) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
                );
              }
              controller.close();
            }
          });
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          });
        }) as typeof fetch,
        async () => {
          for await (const event of runOpenClawCliRequestStream(
            {
              runId: "run-gateway-response-failed",
              executionMode: "native-runtime",
              runtime: {
                id: "rt_123",
                manifest: {
                  version: "1",
                  policyHash: "policy",
                  skills: [],
                  memory: {
                    userMemoryEnabled: false,
                    workspaceMemoryEnabled: false,
                    jobMemoryEnabled: true
                  },
                  streaming: {
                    messageDeltasEnabled: true
                  }
                }
              },
              input: {
                text: "do we currently have any cron jobs?",
                connections: {
                  github: { connected: false }
                }
              }
            },
            { ...config, engine: "openclaw-gateway" },
            async () => ({
              classification: "user_private",
              content: []
            }),
            async function* () {
              throw new Error("unexpected cli call");
            },
            (line) => logs.push(line)
          )) {
            events.push(event);
          }
        }
      )
    ).rejects.toThrow(
      "OpenClaw Gateway HTTP request failed: api_error: upstream provider timeout"
    );

    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "message_delta",
        text: expect.stringContaining("response.failed")
      })
    );
    expect(events.filter((event) => event.type === "message_delta")).toHaveLength(0);
    expect(requestCount).toBe(1);
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "status",
        text: expect.stringContaining("Retrying")
      })
    );
    expect(logs.join("\n")).toContain(
      "OpenClaw gateway http response_failed runId=run-gateway-response-failed"
    );
  });

  test("repairs and buffers malformed streamed gateway tool-call JSON", async () => {
    const events: Array<RunEvent> = [];
    const requests: Array<Record<string, unknown>> = [];
    const validToolCall = JSON.stringify({
      tool_call: {
        name: "jira.searchIssues",
        arguments: { jql: 'text ~ "blocked"' }
      }
    });
    const providerTexts = [
      validToolCall.slice(0, -1),
      validToolCall,
      "ENG-7 is blocked."
    ];

    await withMockFetch(
      (async (_input, init) => {
        const requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        requests.push(requestBody);
        expect(requestBody.stream).toBe(true);
        const text = providerTexts.shift();
        if (!text) {
          throw new Error("unexpected gateway call");
        }
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "response.output_text.delta",
                  delta: text.slice(0, Math.ceil(text.length / 2))
                })}\n\n`
              )
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "response.output_text.delta",
                  delta: text.slice(Math.ceil(text.length / 2))
                })}\n\n`
              )
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      }) as typeof fetch,
      async () => {
        for await (const event of runOpenClawCliRequestStream(
          {
            runId: "run-gateway-tool-stream",
            executionMode: "native-runtime",
            input: {
              text: "which Jira tickets are blocked?",
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
          { ...config, engine: "openclaw-gateway" },
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
            throw new Error("unexpected cli call");
          },
          () => undefined
        )) {
          events.push(event);
        }
      }
    );

    expect(events.slice(0, 4)).toMatchObject([
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
      }
    ]);
    expect(
      events
        .filter((event): event is Extract<RunEvent, { type: "message_delta" }> =>
          event.type === "message_delta"
        )
        .map((event) => event.text)
        .join("")
    ).toBe("ENG-7 is blocked.");
    expect(events.at(-1)).toMatchObject({
      type: "final",
      response: {
        classification: "user_private",
        text: "ENG-7 is blocked."
      }
    });
    expect(requests).toHaveLength(3);
    expect(String(requests[1].input)).toContain(
      "Your previous response looked like a Burble tool call but was invalid or incomplete"
    );
    expect(
      events.some(
        (event) =>
          event.type === "message_delta" && event.text.includes("tool_call")
      )
    ).toBe(false);
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

  test("executes connectionless web search tool calls without a provider account", async () => {
    const events: RunEvent[] = [];
    const executedCalls: Array<{ toolName: string; payload: unknown }> = [];
    let commandCount = 0;

    for await (const event of runOpenClawCliRequestStream(
      {
        runtime: {
          id: "rt_test",
          manifest: providerManifest()
        },
        input: {
          text: "look for latest AI news, summarize in two paragraphs and post result in this channel",
          toolGroups: {
            groups: ["conversation"],
            reasons: ["scheduled-job:text"]
          },
          scheduledJob: {
            jobId: "job-ai-news",
            capabilityProfile: "scheduled_job",
            allowedTools: ["web_search"],
            routeId: "convrt_abc123",
            runtimeType: "openclaw",
            stateRefs: [],
            visibilityPolicy: {
              maxOutputVisibility: "public",
              allowPrivateToolDeclassification: false
            }
          },
          connections: {
            github: {
              connected: true,
              email: "person@example.com",
              providerLogin: "octocat"
            },
            google: { connected: false },
            hubspot: { connected: false },
            jira: { connected: false },
            slack: { connected: false }
          }
        }
      },
      {
        ...config,
        mcpGatewayUrl: "http://agentgateway:3000/mcp",
        runtimeJwt: "runtime-jwt"
      },
      async (toolName, payload) => {
        executedCalls.push({ toolName, payload });
        if (toolName === "burble.mcp.listTools") {
          return {
            classification: "user_private",
            content: [
              {
                name: "web_search",
                description: "Search public web/news sources",
                inputSchema: {
                  type: "object",
                  required: ["query"],
                  properties: {
                    query: { type: "string" },
                    limit: { type: "number" }
                  }
                }
              }
            ]
          };
        }
        if (toolName === "web.search") {
          return {
            classification: "public",
            content: {
              query: "latest AI news",
              results: [
                {
                  title: "AI news item",
                  url: "https://example.com/ai-news",
                  snippet: "A current AI news story."
                }
              ]
            }
          };
        }
        return {
          classification: "user_private",
          content: []
        };
      },
      async function* () {
        commandCount += 1;
        if (commandCount === 1) {
          yield {
            type: "stdout" as const,
            text:
              JSON.stringify({
                tool_call: {
                  name: "web.search",
                  arguments: { query: "latest AI news", limit: 5 }
                }
              }) + "\n"
          };
        } else {
          yield {
            type: "stdout" as const,
            text: "Here are two paragraphs about current AI news."
          };
        }
        yield { type: "exit" as const, exitCode: 0 };
      },
      () => undefined
    )) {
      events.push(event);
    }

    expect(executedCalls).toContainEqual({
      toolName: "web.search",
      payload: {
        input: { query: "latest AI news", limit: 5 }
      }
    });
    expect(events).toMatchObject([
      { type: "status", text: "Loading Burble context..." },
      { type: "status", text: "Agent is thinking..." },
      {
        type: "tool_call",
        toolName: "web.search",
        callId: expect.any(String)
      },
      {
        type: "tool_result",
        toolName: "web.search",
        callId: expect.any(String),
        classification: "public"
      },
      {
        type: "message_delta",
        text: "Here are two paragraphs about current AI news."
      },
      {
        type: "final",
        response: {
          classification: "user_private",
          text: "Here are two paragraphs about current AI news."
        }
      }
    ]);
  });

  test("strips mixed OpenClaw gateway prose and tool-call JSON from Slack output", async () => {
    const events: Array<RunEvent> = [];
    const mixedText = [
      "Done — I created the deck.",
      "",
      JSON.stringify({
        tool_call: {
          name: "google.slidesCreateSlide",
          arguments: {
            presentationId: "deck-1",
            predefinedLayout: "TITLE_AND_BODY"
          }
        }
      })
    ].join("\n");

    await withMockFetch(
      (async (_input, init) => {
        const requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        expect(requestBody.stream).toBe(true);
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            for (const delta of [
              "Done — I created the deck.",
              "\n\n",
              JSON.stringify({
                tool_call: {
                  name: "google.slidesCreateSlide",
                  arguments: {
                    presentationId: "deck-1",
                    predefinedLayout: "TITLE_AND_BODY"
                  }
                }
              })
            ]) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "response.output_text.delta",
                    delta
                  })}\n\n`
                )
              );
            }
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "response.completed",
                  response: openResponsesText(mixedText)
                })}\n\n`
              )
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      }) as typeof fetch,
      async () => {
        for await (const event of runOpenClawCliRequestStream(
          {
            runId: "run-gateway-mixed-tool-tail",
            executionMode: "native-runtime",
            input: {
              text: "populate the deck",
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
          { ...config, engine: "openclaw-gateway" },
          async () => ({
            classification: "user_private",
            content: []
          }),
          async function* () {
            throw new Error("unexpected cli call");
          },
          () => undefined
        )) {
          events.push(event);
        }
      }
    );

    const streamedText = events
      .filter((event): event is Extract<RunEvent, { type: "message_delta" }> =>
        event.type === "message_delta"
      )
      .map((event) => event.text)
      .join("");
    expect(streamedText).toBe("Done — I created the deck.");
    expect(streamedText).not.toContain("tool_call");
    expect(events.some((event) => event.type === "tool_call")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "final",
      response: {
        classification: "user_private",
        text: "Done — I created the deck."
      }
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
            executionMode: "native-runtime",
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
            executionMode: "native-runtime",
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
    const logs: string[] = [];
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
          (message) => logs.push(message)
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
    expect(requests[0].body.metadata).toBeUndefined();
    expect(
      logs.some((line) =>
        line.includes("llmCorrelationId=unresolved")
      )
    ).toBe(true);
  });

  test("does not replay explicit OpenClaw Gateway provider failures", async () => {
    const requests: Array<{
      url: string;
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    const logs: string[] = [];
    await expect(
      withMockFetch(
        (async (input, init) => {
          requests.push({
            url: String(input),
            headers: new Headers(init?.headers),
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
          });
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
        }) as typeof fetch,
        async () =>
          runOpenClawCliRequest(
            {
              runId: "run-openclaw-provider-failure",
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
      )
    ).rejects.toThrow("upstream provider timeout");

    expect(requests).toHaveLength(1);
    expect(
      logs.some((line) => line.includes("reason=upstream_provider_timeout"))
    ).toBe(false);
  });

  test("routes scheduled runs through the minimal-tool OpenClaw agent", async () => {
    const requests: Array<{
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    const response = await withMockFetch(
      (async (_input, init) => {
        requests.push({
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        });
        return new Response(JSON.stringify(openResponsesText("Scheduled answer.")), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }) as typeof fetch,
      async () =>
        runOpenClawCliRequest(
          {
            runId: "run-openclaw-scheduled-agent",
            input: {
              text: "say hello",
              connections: {
                github: { connected: false }
              },
              scheduledJob: {
                jobId: "job-ai-news",
                capabilityProfile: "scheduled_job",
                allowedTools: [],
                stateRefs: [],
                visibilityPolicy: {}
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
          () => undefined
        )
    );

    expect(response.response.text).toBe("Scheduled answer.");
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get("x-openclaw-agent-id")).toBe(
      "main-scheduled"
    );
    expect(requests[0].headers.get("x-openclaw-session-key")).toStartWith(
      "agent:main-scheduled:explicit:burble-step-"
    );
    expect(requests[0].body.model).toBe("openclaw/main-scheduled");
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

  test("hard-bounds streaming OpenClaw Gateway requests before headers", async () => {
    const requests: Array<{
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    const logs: string[] = [];

    await expect(
      withMockFetch(
        (async (_input, init) => {
          requests.push({
            headers: new Headers(init?.headers),
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
          });
          const signal = init?.signal;
          return await new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted before headers")),
              { once: true }
            );
          });
        }) as typeof fetch,
        async () =>
          runOpenClawCliRequest(
            {
              runId: "run-openclaw-header-timeout",
              input: {
                text: "what can you do?",
                connections: {
                  github: { connected: false }
                }
              }
            },
            {
              ...config,
              engine: "openclaw-gateway",
              openClawTimeoutMs: 5,
              openClawGatewayRetryBaseMs: 1,
              openClawGatewayRetryMaxMs: 1
            },
            async () => {
              throw new Error("unexpected tool call");
            },
            async (_command, args) => {
              throw new Error(`unexpected cli call: ${args.join(" ")}`);
            },
            (line) => logs.push(line)
          )
      )
    ).rejects.toThrow("OpenClaw Gateway HTTP request failed");

    expect(requests).toHaveLength(1);
    expect(
      logs.some((line) =>
        line.includes(
          "OpenClaw Gateway request exceeded the 5ms hard deadline"
        )
      )
    ).toBe(true);
  });

  test("bounds OpenClaw Gateway streams that never finish", async () => {
    const requests: Array<{
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    const logs: string[] = [];
    const encoder = new TextEncoder();

    await expect(
      withMockFetch(
        (async (_input, init) => {
          requests.push({
            headers: new Headers(init?.headers),
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
          });
          const signal = init?.signal;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "response.created" })}\n\n`
                  )
                );
                signal?.addEventListener(
                  "abort",
                  () => controller.error(new Error("The operation timed out")),
                  { once: true }
                );
              }
            }),
            {
              status: 200,
              headers: { "content-type": "text/event-stream" }
            }
          );
        }) as typeof fetch,
        async () =>
          runOpenClawCliRequest(
            {
              runId: "run-openclaw-hung-stream",
              input: {
                text: "what can you do?",
                connections: {
                  github: { connected: false }
                }
              }
            },
            {
              ...config,
              engine: "openclaw-gateway",
              openClawTimeoutMs: 5,
              openClawGatewayRetryBaseMs: 1,
              openClawGatewayRetryMaxMs: 1
            },
            async () => {
              throw new Error("unexpected tool call");
            },
            async (_command, args) => {
              throw new Error(`unexpected cli call: ${args.join(" ")}`);
            },
            (line) => logs.push(line)
          )
      )
    ).rejects.toThrow("OpenClaw Gateway HTTP request failed");

    expect(requests).toHaveLength(1);
    expect(
      logs.some((line) =>
        line.includes(
          "OpenClaw Gateway request exceeded the 5ms hard deadline"
        )
      )
    ).toBe(true);
  });

  test("times out OpenClaw Gateway streams that only send keepalives", async () => {
    const requests: Array<{
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    const logs: string[] = [];
    const encoder = new TextEncoder();

    await expect(
      withMockFetch(
        (async (_input, init) => {
          requests.push({
            headers: new Headers(init?.headers),
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
          });
          let interval: ReturnType<typeof setInterval> | undefined;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "response.created" })}\n\n`
                  )
                );
                interval = setInterval(() => {
                  controller.enqueue(encoder.encode(": keepalive\n\n"));
                }, 1);
              },
              cancel() {
                if (interval) {
                  clearInterval(interval);
                }
              }
            }),
            {
              status: 200,
              headers: { "content-type": "text/event-stream" }
            }
          );
        }) as typeof fetch,
        async () => {
          const events: RunEvent[] = [];
          for await (const event of runOpenClawCliRequestStream(
            {
              runId: "run-openclaw-keepalive-stream",
              executionMode: "native-runtime",
              input: {
                text: "what can you do?",
                connections: {
                  github: { connected: false }
                }
              }
            },
            {
              ...config,
              engine: "openclaw-gateway",
              openClawTimeoutMs: 5
            },
            async () => {
              throw new Error("unexpected tool call");
            },
            async function* () {
              throw new Error("unexpected cli call");
            },
            (line) => logs.push(line)
          )) {
            events.push(event);
          }
        }
      )
    ).rejects.toThrow("OpenClaw Gateway HTTP request failed");

    expect(requests).toHaveLength(1);
    expect(requests[0].body.stream).toBe(true);
  });

  test("bounds OpenClaw Gateway streams with endless progress events", async () => {
    const requests: Array<{
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    const logs: string[] = [];
    const encoder = new TextEncoder();

    await expect(
      withMockFetch(
        (async (_input, init) => {
          requests.push({
            headers: new Headers(init?.headers),
            body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
          });
          let interval: ReturnType<typeof setInterval> | undefined;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                interval = setInterval(() => {
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({ type: "response.in_progress" })}\n\n`
                    )
                  );
                }, 1);
              },
              cancel() {
                if (interval) {
                  clearInterval(interval);
                }
              }
            }),
            {
              status: 200,
              headers: { "content-type": "text/event-stream" }
            }
          );
        }) as typeof fetch,
        async () => {
          const events: RunEvent[] = [];
          for await (const event of runOpenClawCliRequestStream(
            {
              runId: "run-openclaw-progress-stream",
              executionMode: "native-runtime",
              input: {
                text: "what can you do?",
                connections: {
                  github: { connected: false }
                }
              }
            },
            {
              ...config,
              engine: "openclaw-gateway",
              openClawTimeoutMs: 5
            },
            async () => {
              throw new Error("unexpected tool call");
            },
            async function* () {
              throw new Error("unexpected cli call");
            },
            (line) => logs.push(line)
          )) {
            events.push(event);
          }
        }
      )
    ).rejects.toThrow("OpenClaw Gateway HTTP request failed");

    expect(requests).toHaveLength(1);
    expect(requests[0].body.stream).toBe(true);
    expect(
      logs.some((line) =>
        line.includes(
          "OpenClaw Gateway request exceeded the 5ms hard deadline"
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
      executionMode: "native-runtime" as const,
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
            executionMode: "native-runtime",
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
      "pass destination with the channel mention/name/id"
    );
    expect(String(requests[0].body.input)).toContain(
      "A Slack channel label, Slack mention, Slack channel id, or guessed convrt_* value is not a delivery route"
    );
    expect(String(requests[0].body.input)).toContain(
      'Never set native delivery.to to values like "#eng"'
    );
    expect(String(requests[0].body.input)).toContain(
      "use only the returned scheduledJob.routeId / routeId convrt_* value as native delivery.to"
    );
    expect(String(requests[0].body.input)).toContain(
      "Do not use the original destination label in native delivery"
    );
    expect(String(requests[0].body.input)).toContain("omit routeId");
    expect(String(requests[0].body.input)).toContain(
      "Never send both routeId and destination"
    );
    expect(String(requests[0].body.input)).toContain(
      'include visibilityPolicy {"maxOutputVisibility":"public"}'
    );
    expect(String(requests[0].body.input)).toContain(
      "Include conversation.sendMessage plus any write-only provider state tools"
    );
    expect(String(requests[0].body.input)).toContain(
      "If the scheduled job reads from authenticated Burble provider sources"
    );
    expect(String(requests[0].body.input)).toContain("/agent grant here");
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
      "Burble channel delivery"
    );
    expect(String(requests[0].body.input)).toContain(
      "delivery target is not a resolved convrt_* route"
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
            executionMode: "native-runtime",
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
    expect(String(requests[0].body.input)).toContain(
      "use Burble provider tools or post scheduled output through Burble"
    );
  });

  test("executes scheduled job registration as a Burble-internal tool", async () => {
    const toolCalls: Array<{ toolName: string; body: Record<string, unknown> }> =
      [];

    const response = await runOpenClawCliRequest(
      {
        runId: "run-register-scheduled-job",
        executionMode: "native-runtime",
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

  test("accepts the native scheduled job registration alias", async () => {
    const toolCalls: Array<{ toolName: string; body: Record<string, unknown> }> =
      [];

    const response = await runOpenClawCliRequest(
      {
        runId: "run-register-scheduled-job-alias",
        executionMode: "native-runtime",
        input: {
          text: "modify the public cron job to post to #burble-test",
          toolGroups: {
            groups: ["conversation", "scheduler"],
            reasons: ["default:conversation", "keyword:scheduler:cron"]
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
            routeId: "convrt_0123456789abcdef01234567",
            scheduledJob: {
              routeId: "convrt_0123456789abcdef01234567"
            },
            scheduledPromptInstruction:
              "Use routeId convrt_0123456789abcdef01234567."
          }
        };
      },
      async () => {
        if (toolCalls.length === 0) {
          return openClawToolCall("scheduled_job_register_capability", {
            jobId: "job-ai-news-public",
            destination: "#burble-test",
            requiredTools: ["conversation.sendMessage"],
            visibilityPolicy: { maxOutputVisibility: "public" }
          });
        }

        return {
          exitCode: 0,
          stdout: "Registered destination and stopped before manual trigger.",
          stderr: ""
        };
      },
      () => undefined
    );

    expect(response.response.text).toBe(
      "Registered destination and stopped before manual trigger."
    );
    expect(toolCalls).toEqual([
      {
        toolName: "scheduledJob.registerCapability",
        body: {
          input: {
            jobId: "job-ai-news-public",
            destination: "#burble-test",
            requiredTools: ["conversation.sendMessage"],
            visibilityPolicy: { maxOutputVisibility: "public" }
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
        executionMode: "native-runtime",
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
            executionMode: "native-runtime",
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
