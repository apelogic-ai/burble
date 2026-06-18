import { describe, expect, test } from "bun:test";
import { parseRuntimeCapabilityManifest } from "../../../src/agent/runtime-contract";

function runHermesEntrypointProbe(source: string): unknown {
  const proc = Bun.spawnSync(["python3", "-c", source], {
    stdout: "pipe",
    stderr: "pipe"
  });
  const stdout = new TextDecoder().decode(proc.stdout);
  const stderr = new TextDecoder().decode(proc.stderr);
  if (proc.exitCode !== 0) {
    throw new Error(`python probe failed:\n${stdout}\n${stderr}`);
  }
  const jsonLine = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((line) => line.trim().startsWith("{") || line.trim().startsWith("["));
  if (!jsonLine) {
    throw new Error(`python probe did not print JSON:\n${stdout}\n${stderr}`);
  }
  return JSON.parse(jsonLine);
}

const importEntrypoint = String.raw`
import importlib.util
import json
import sys
import types

sys.path.insert(0, "runtimes/nemo-hermes/runtime")

aiohttp = types.ModuleType("aiohttp")
aiohttp.ClientSession = object
aiohttp.ClientTimeout = object
aiohttp.web = types.SimpleNamespace()
sys.modules["aiohttp"] = aiohttp

spec = importlib.util.spec_from_file_location(
    "burble_hermes_entrypoint",
    "runtimes/nemo-hermes/runtime/entrypoint.py",
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
`;

const importProviderToolPlugin = String.raw`
import importlib.util
import json
import sys
import types

aiohttp = types.ModuleType("aiohttp")
aiohttp.ClientSession = object
aiohttp.ClientTimeout = object
sys.modules["aiohttp"] = aiohttp

spec = importlib.util.spec_from_file_location(
    "burble_provider_tool",
    "runtimes/nemo-hermes/hermes-plugins/burble-provider-tool/__init__.py",
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
`;

const importBurblePlatformAdapter = String.raw`
import importlib.util
import json
import sys
import types

class SendResult:
    def __init__(self, success, message_id=None, error=None, retryable=False, **kwargs):
        self.success = success
        self.message_id = message_id
        self.error = error
        self.retryable = retryable

class BasePlatformAdapter:
    def __init__(self, config=None, platform=None):
        self.config = config
        self.platform = platform
        self.message_len_fn = len
    def _mark_connected(self):
        pass
    def _mark_disconnected(self):
        pass

class MessageEvent:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)

class MessageType:
    TEXT = "text"

class Platform(str):
    pass

posted_payloads = []

class FakeResponse:
    status = 200
    async def __aenter__(self):
        return self
    async def __aexit__(self, exc_type, exc, tb):
        return False
    async def text(self):
        return ""

class FakeSession:
    def __init__(self, *args, **kwargs):
        pass
    async def __aenter__(self):
        return self
    async def __aexit__(self, exc_type, exc, tb):
        return False
    def post(self, url, **kwargs):
        payload = {
            "url": url,
            "json": kwargs.get("json"),
        }
        if kwargs.get("headers") is not None:
            payload["headers"] = kwargs.get("headers")
        posted_payloads.append(payload)
        return FakeResponse()

class FakeTimeout:
    def __init__(self, *args, **kwargs):
        pass

gateway = types.ModuleType("gateway")
gateway_config = types.ModuleType("gateway.config")
gateway_config.Platform = Platform
gateway_platforms = types.ModuleType("gateway.platforms")
gateway_platforms_base = types.ModuleType("gateway.platforms.base")
gateway_platforms_base.BasePlatformAdapter = BasePlatformAdapter
gateway_platforms_base.MessageEvent = MessageEvent
gateway_platforms_base.MessageType = MessageType
gateway_platforms_base.SendResult = SendResult
gateway_session = types.ModuleType("gateway.session")
gateway_session.build_session_key = lambda *args, **kwargs: "session-key"
sys.modules["gateway"] = gateway
sys.modules["gateway.config"] = gateway_config
sys.modules["gateway.platforms"] = gateway_platforms
sys.modules["gateway.platforms.base"] = gateway_platforms_base
sys.modules["gateway.session"] = gateway_session

aiohttp = types.ModuleType("aiohttp")
aiohttp.ClientSession = FakeSession
aiohttp.ClientTimeout = FakeTimeout
aiohttp.web = types.SimpleNamespace(json_response=lambda body, **kwargs: body)
sys.modules["aiohttp"] = aiohttp

spec = importlib.util.spec_from_file_location(
    "burble_platform_adapter",
    "runtimes/nemo-hermes/hermes-plugins/burble-platform/adapter.py",
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
`;

describe("nemo-hermes entrypoint", () => {
  test("validates Hermes contract payloads with the generated runtime schema", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
valid_manifest = mod.validate_runtime_capability_manifest(mod.build_runtime_capability_manifest())
valid_event = mod.validate_runtime_run_event({"type": "message_delta", "text": "Hello"})
try:
    mod.validate_runtime_run_event({"type": "message_delta", "text": "Hello", "extra": True})
except mod.ContractValidationError as error:
    invalid_event = str(error)
else:
    invalid_event = ""
print(json.dumps({
    "manifestType": valid_manifest["runtimeType"],
    "eventType": valid_event["type"],
    "invalidEvent": invalid_event,
}))
`);

    expect(result).toEqual({
      manifestType: "hermes",
      eventType: "message_delta",
      invalidEvent: expect.stringContaining("additional property extra")
    });
  });

  test("rejects invalid Hermes run requests through the generated schema shim", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
try:
    mod.validate_runtime_run_request({
        "runId": "run-invalid",
        "principal": {"workspaceId": "T123", "slackUserId": "U123"},
        "runtime": {"id": "rt_123", "engine": "hermes"},
        "input": {"text": "hello"}
    })
except mod.ContractValidationError as error:
    invalid_request = str(error)
else:
    invalid_request = ""
print(json.dumps({"invalidRequest": invalid_request}))
`);

    expect(result).toEqual({
      invalidRequest: expect.stringContaining("input.connections")
    });
  });

  test("defaults legacy Hermes request manifests through the generated schema shim", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
request = mod.validate_runtime_run_request({
    "runId": "run-legacy-manifest",
    "principal": {"workspaceId": "T123", "slackUserId": "U123"},
    "runtime": {
        "id": "rt_123",
        "engine": "hermes",
        "manifest": {
            "version": "1",
            "policyHash": "policy-123",
            "skills": [],
            "memory": {
                "userMemoryEnabled": True,
                "workspaceMemoryEnabled": False,
                "jobMemoryEnabled": False,
            },
        },
    },
    "input": {
        "text": "hello",
        "conversation": {
            "source": "slack",
            "workspaceId": "T123",
            "channelId": "D123",
            "rootId": "dm:D123",
            "isDirectMessage": True,
        },
        "connections": {},
    },
})
print(json.dumps(request["runtime"]["manifest"]["streaming"]))
`);

    expect(result).toEqual({ messageDeltasEnabled: true });
  });

  test("builds a runtime capability manifest", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
print(json.dumps(mod.build_runtime_capability_manifest()))
`);

    expect(parseRuntimeCapabilityManifest(result)).toEqual({
      runtimeType: "hermes",
      version: expect.any(String),
      transports: ["http", "websocket"],
      streaming: true,
      cancellation: false,
      nativeScheduler: true,
      scheduledProviderCalls: true,
      toolCalls: true,
      toolBridgeModes: ["tool_gateway"],
      usageReporting: "exact",
      multimodalInput: false,
      multimodalOutput: false,
      memory: false,
      durableWorkflowState: true,
      attachments: true,
      conversationSend: true,
      jobScopedAuth: true
    });
  });

  test("advertises MCP bridge support only when Hermes MCP env is configured", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
import os
default_modes = mod.build_runtime_capability_manifest()["toolBridgeModes"]
os.environ["BURBLE_MCP_GATEWAY_URL"] = "http://burble-mcp"
os.environ["BURBLE_RUNTIME_JWT"] = "runtime-jwt"
print(json.dumps({
  "default": default_modes,
  "configured": mod.build_runtime_capability_manifest()["toolBridgeModes"],
}))
`);

    expect(result).toEqual({
      default: ["tool_gateway"],
      configured: ["tool_gateway", "mcp"]
    });
  });

  test("builds bounded Burble context for Hermes turns", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
payload = {
    "text": "what changed?",
    "toolGroups": {
        "groups": ["conversation", "github"],
        "reasons": ["default:conversation", "keyword:github:github"],
    },
    "context": {
        "recentMessages": [
            {
                "author": "user",
                "speaker": "Leo",
                "text": "old message should not be included",
            },
            *[
                {
                    "author": "assistant",
                    "speaker": "Burble",
                    "text": f"recent message {index} " + ("x" * 500),
                }
                for index in range(2, 21)
            ],
        ],
    },
}
print(json.dumps({"text": mod.build_hermes_turn_text(payload)}))
`);

    const text = (result as { text: string }).text;
    expect(text).toContain("User request:");
    expect(text).toContain("what changed?");
    expect(text).toContain("Selected Burble tool groups: conversation, github");
    expect(text).toContain("Selected Burble provider tools");
    expect(text).toContain("Do not call provider tools that are not listed here");
    expect(text).toContain("github_list_my_pull_requests");
    expect(text).not.toContain("google_search_drive_files");
    expect(text).toContain("scheduled_job_register_capability");
    expect(text).toContain("For setup-time provider calls");
    expect(text).toContain("do not include jobId");
    expect(text).toContain("without an immediate/manual run");
    expect(text).toContain("with the exact returned jobId");
    expect(text).toContain("before enabling or triggering it");
    expect(text).toContain("Recent Burble context");
    expect(text).not.toContain("old message should not be included");
    expect(text).toContain("recent message 20");
    expect(text).not.toContain("x".repeat(350));
  });

  test("builds current attachment guidance for Hermes turns", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
payload = {
    "text": "summarize the file",
    "toolGroups": {
        "groups": ["attachments", "conversation"],
        "reasons": ["metadata:attachments", "default:conversation"],
    },
    "attachments": [
        {
            "id": "attcap_123",
            "kind": "file",
            "source": "slack",
            "name": "notes.md",
            "mimeType": "text/markdown",
            "sizeBytes": 1234,
        }
    ],
}
print(json.dumps({"text": mod.build_hermes_turn_text(payload)}))
`);

    const text = (result as { text: string }).text;
    expect(text).toContain("Current request attachments:");
    expect(text).toContain("notes.md");
    expect(text).toContain("attcap_123");
    expect(text).toContain("conversation_get_attachment");
    expect(text).toContain("conversation.getAttachment");
    expect(text).toContain("attachmentId");
    expect(text).not.toContain("externalId");
  });

  test("accepts Hermes message deltas without completing the run", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
import asyncio

mod.web.json_response = lambda body, **kwargs: body

class FakeRequest:
    def __init__(self, run_id, body):
        self.match_info = {"run_id": run_id}
        self._body = body

    async def json(self):
        return self._body

async def main():
    runtime = mod.BurbleHermesRuntime()
    waiter = mod.RunWaiter()
    queue = asyncio.Queue()
    waiter.queues.append(queue)
    runtime.runs["run-stream"] = waiter

    delta_response = await runtime.handle_run_message(
        FakeRequest("run-stream", {"type": "message_delta", "text": "Hello "})
    )
    delta_event = await asyncio.wait_for(queue.get(), timeout=1)
    completed_after_delta = waiter.future.done()

    final_response = await runtime.handle_run_message(
        FakeRequest("run-stream", {"text": "Hello world", "classification": "user_private"})
    )
    final_body = waiter.future.result()

    print(json.dumps({
        "deltaResponse": delta_response,
        "deltaEvent": delta_event,
        "completedAfterDelta": completed_after_delta,
        "finalResponse": final_response,
        "finalBody": final_body,
    }))

asyncio.run(main())
`);

    expect(result).toEqual({
      deltaResponse: { ok: true },
      deltaEvent: { type: "message_delta", text: "Hello " },
      completedAfterDelta: false,
      finalResponse: { ok: true },
      finalBody: {
        text: "Hello world",
        classification: "user_private"
      }
    });
  });

  test("streams deterministic contract probe events without invoking Hermes gateway", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
import asyncio
import os

os.environ["BURBLE_RUNTIME_CONTRACT_PROBE"] = "1"

async def main():
    waiter = mod.RunWaiter()
    queue = asyncio.Queue()
    waiter.queues.append(queue)
    runtime = mod.BurbleHermesRuntime()

    response = await runtime._execute_run(
        "run-contract-probe",
        waiter,
        {"text": "contract probe"},
    )

    events = []
    while not queue.empty():
        event = await queue.get()
        if event is not None:
            events.append(event)

    print(json.dumps({"response": response, "events": events}))

asyncio.run(main())
`);

    expect(result).toEqual({
      response: {
        classification: "user_private",
        text: "Runtime contract probe response.",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          usageSource: "contract-probe"
        }
      },
      events: [
        { type: "status", text: "Runtime contract probe accepted." },
        { type: "message_delta", text: "Runtime contract probe response." },
        {
          type: "final",
          response: {
            classification: "user_private",
            text: "Runtime contract probe response.",
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              usageSource: "contract-probe"
            }
          }
        }
      ]
    });
  });

  test("streams deterministic capability assertion probe events", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
import asyncio
import os

os.environ["BURBLE_RUNTIME_CONTRACT_PROBE"] = "1"

async def run_probe(message):
    waiter = mod.RunWaiter()
    queue = asyncio.Queue()
    waiter.queues.append(queue)
    runtime = mod.BurbleHermesRuntime()

    await runtime._execute_run("run-contract-probe", waiter, message)

    events = []
    while not queue.empty():
        event = await queue.get()
        if event is not None:
            events.append(event)
    return events

async def main():
    tool_events = await run_probe({
        "text": "runtime contract tool capability probe",
    })
    reachability_events = await run_probe({
        "text": "runtime contract tool reachability probe",
        "runtime": {
            "id": "rt_probe",
            "engine": "hermes",
            "manifest": {
                "version": "1",
                "policyHash": "contract-probe",
                "skills": [],
                "tools": [
                    {
                        "name": "github_get_authenticated_user",
                        "alias": "github.getAuthenticatedUser",
                        "provider": "github",
                        "title": "GitHub authenticated user",
                        "description": "Return the connected GitHub identity.",
                        "enabled": True,
                        "risk": "read",
                        "routeRequired": True,
                        "confirmation": "none",
                        "retrySafe": True,
                        "input": [],
                    },
                    {
                        "name": "github_create_issue",
                        "alias": "github.createIssue",
                        "provider": "github",
                        "title": "GitHub create issue",
                        "description": "Create a GitHub issue.",
                        "enabled": False,
                        "risk": "low_write",
                        "routeRequired": True,
                        "confirmation": "none",
                        "retrySafe": False,
                        "input": [],
                    },
                ],
                "memory": {
                    "userMemoryEnabled": False,
                    "workspaceMemoryEnabled": False,
                    "jobMemoryEnabled": False,
                },
                "streaming": {"messageDeltasEnabled": True},
            },
        },
    })
    scheduled_events = await run_probe({
        "originalText": "runtime contract scheduled provider capability probe",
        "text": "runtime contract scheduled provider capability probe",
        "scheduledJob": {"jobId": "contract-scheduled-job"},
    })
    attachment_events = await run_probe({
        "originalText": "runtime contract attachment capability probe",
        "text": "runtime contract attachment capability probe",
        "attachments": [
            {
                "id": "attcap_contract_probe",
                "kind": "file",
                "mimeType": "text/plain",
                "source": "slack",
                "name": "contract.txt",
            }
        ],
    })
    print(json.dumps({
        "toolEvents": tool_events,
        "reachabilityEvents": reachability_events,
        "scheduledEvents": scheduled_events,
        "attachmentEvents": attachment_events,
    }))

asyncio.run(main())
`);

    const typed = result as {
      toolEvents: unknown[];
      reachabilityEvents: unknown[];
      scheduledEvents: unknown[];
      attachmentEvents: unknown[];
    };
    expect(typed.toolEvents).toContainEqual({
      type: "tool_call",
      toolName: "runtime.conformance.echo",
      callId: "contract-tool-probe"
    });
    expect(typed.toolEvents).toContainEqual({
      type: "tool_result",
      toolName: "runtime.conformance.echo",
      callId: "contract-tool-probe",
      classification: "user_private"
    });
    expect(typed.reachabilityEvents).toContainEqual({
      type: "tool_call",
      toolName: "github.getAuthenticatedUser",
      callId: "contract-tool-reachability-0",
      input: {}
    });
    expect(typed.reachabilityEvents).toContainEqual({
      type: "tool_result",
      toolName: "github.getAuthenticatedUser",
      callId: "contract-tool-reachability-0",
      classification: "user_private",
      content: {
        ok: true,
        toolName: "github.getAuthenticatedUser",
        input: {}
      }
    });
    expect(JSON.stringify(typed.reachabilityEvents)).not.toContain(
      "github.createIssue"
    );
    expect(typed.scheduledEvents).toContainEqual({
      type: "tool_call",
      toolName: "scheduledJob.registerCapability",
      callId: "contract-scheduled-provider-probe"
    });
    expect(typed.scheduledEvents).toContainEqual({
      type: "tool_result",
      toolName: "scheduledJob.registerCapability",
      callId: "contract-scheduled-provider-probe",
      classification: "user_private"
    });
    expect(typed.scheduledEvents).toContainEqual({
      type: "tool_call",
      toolName: "burble_provider_call",
      callId: "contract-scheduled-provider-bridge-probe",
      input: {
        toolName: "runtime.conformance.echo",
        input: {
          jobId: "contract-scheduled-job",
          message: "scheduled provider bridge probe"
        }
      }
    });
    expect(typed.scheduledEvents).toContainEqual({
      type: "tool_result",
      toolName: "burble_provider_call",
      callId: "contract-scheduled-provider-bridge-probe",
      classification: "user_private",
      content: {
        ok: true,
        toolName: "runtime.conformance.echo",
        input: {
          jobId: "contract-scheduled-job",
          message: "scheduled provider bridge probe"
        }
      }
    });
    expect(typed.attachmentEvents).toContainEqual({
      type: "tool_call",
      toolName: "conversation.getAttachment",
      callId: "contract-attachment-probe",
      input: { attachmentId: "attcap_contract_probe" }
    });
    expect(typed.attachmentEvents).toContainEqual({
      type: "tool_result",
      toolName: "conversation.getAttachment",
      callId: "contract-attachment-probe",
      classification: "user_private",
      content: { text: "contract attachment content" }
    });
  });

  test("replays completed contract probe events to late subscribers", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
import asyncio
import os

os.environ["BURBLE_RUNTIME_CONTRACT_PROBE"] = "1"

async def main():
    waiter = mod.RunWaiter()
    runtime = mod.BurbleHermesRuntime()
    await runtime._execute_run("run-contract-probe", waiter, {
        "text": "runtime contract tool capability probe",
    })

    queue = asyncio.Queue()
    await waiter.replay_to(queue)

    events = []
    while True:
        event = await queue.get()
        if event is None:
            break
        events.append(event)
    print(json.dumps(events))

asyncio.run(main())
`);

    const events = result as unknown[];
    expect(events).toContainEqual({
      type: "tool_call",
      toolName: "runtime.conformance.echo",
      callId: "contract-tool-probe"
    });
    expect(events).toContainEqual({
      type: "tool_result",
      toolName: "runtime.conformance.echo",
      callId: "contract-tool-probe",
      classification: "user_private"
    });
    expect(events.at(-1)).toMatchObject({
      type: "final",
      response: {
        text: "Runtime contract tool capability response."
      }
    });
  });

  test("adds HubSpot provider tool hints to Hermes turns", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
payload = {
    "text": "find HubSpot contacts for Acme",
    "toolGroups": {
        "groups": ["conversation", "hubspot"],
        "reasons": ["default:conversation", "keyword:hubspot:hubspot"],
    },
}
print(json.dumps({"text": mod.build_hermes_turn_text(payload)}))
`);

    const text = (result as { text: string }).text;
    expect(text).toContain("Selected Burble tool groups: conversation, hubspot");
    expect(text).toContain("hubspot_get_authenticated_user");
    expect(text).toContain("hubspot_search_contacts");
    expect(text).toContain("hubspot_search_companies");
    expect(text).toContain("hubspot_search_deals");
    expect(text).toContain("hubspot_search_crm_objects");
    expect(text).toContain("hubspot_list_owners");
    expect(text).toContain("hubspot_list_users");
    expect(text).toContain("hubspot_read_api_resource");
    expect(text).not.toContain("google_search_drive_files");
  });

  test("adds Analytics and Slides provider tool hints to Hermes Google turns", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
payload = {
    "text": "list my Google Analytics properties and inspect this Slides template",
    "toolGroups": {
        "groups": ["conversation", "google"],
        "reasons": ["default:conversation", "keyword:google:analytics"],
    },
}
print(json.dumps({"text": mod.build_hermes_turn_text(payload)}))
`);

    const text = (result as { text: string }).text;
    expect(text).toContain("Selected Burble tool groups: conversation, google");
    expect(text).toContain("google_search_drive_files");
    expect(text).toContain("google_search_calendar_events");
    expect(text).toContain("google_search_mail_messages");
    expect(text).toContain("google_slides_search_presentations");
    expect(text).toContain("google_slides_get_presentation");
    expect(text).toContain("google_slides_probe_template");
    expect(text).toContain("google_slides_copy_presentation");
    expect(text).toContain("google_slides_create_slide");
    expect(text).toContain("google_slides_fill_placeholders");
    expect(text).toContain("input schema");
    expect(text).toContain('"replacements":{"optional":true');
    expect(text).toContain(
      '"placeholderType":{"description":"Google Slides placeholder type such as TITLE, SUBTITLE, BODY, CENTERED_TITLE, or SLIDE_NUMBER."'
    );
    expect(text).toContain("google_analytics_list_properties");
    expect(text).toContain("google_analytics_get_metadata");
    expect(text).toContain("google_analytics_run_report");
    expect(text).not.toContain("hubspot_search_contacts");
  });


  test("adds scheduled job context to Hermes turns", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
payload = {
    "text": "run the scheduled provider job",
    "scheduledJob": {
        "jobId": "job-123",
        "capabilityProfile": "scheduled_job",
        "allowedTools": [
            "google_get_drive_file",
            "google_append_drive_text_file",
        ],
        "routeId": "convrt_abc123",
        "runtimeType": "hermes",
        "stateRefs": [
            {
                "provider": "google",
                "kind": "drive_file",
                "id": "file-123",
                "purpose": "dedupe_state",
            }
        ],
        "visibilityPolicy": {
            "maxOutputVisibility": "public",
            "allowPrivateToolDeclassification": False,
        },
    },
}
print(json.dumps({"text": mod.build_hermes_turn_text(payload)}))
`);

    const text = (result as { text: string }).text;
    expect(text).toContain("Scheduled Burble job context:");
    expect(text).toContain("jobId=job-123");
    expect(text).toMatch(/currentUtc=\d{4}-\d{2}-\d{2}T/);
    expect(text).toContain("capabilityProfile=scheduled_job");
    expect(text).toContain(
      "allowedTools=google_append_drive_text_file,google_get_drive_file"
    );
    expect(text).toContain("routeId=convrt_abc123");
    expect(text).toContain("runtimeType=hermes");
    expect(text).toContain("maxOutputVisibility=public");
    expect(text).toContain("allowPrivateToolDeclassification=false");
    expect(text).toContain(
      "stateRef provider=google kind=drive_file id=file-123 purpose=dedupe_state"
    );
    expect(text).toContain(
      "burble_provider_call is runtime-pinned into native toolsets"
    );
    expect(text).toContain("Use currentUtc for scheduled time-window calculations");
    expect(text).toContain("Do not call shell, terminal, or time tools");
    expect(text).not.toContain("Do not run provider-backed scheduled jobs with only web enabled");
  });

  test("formats deterministic scheduled run time context", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
payload = {
    "scheduledJob": {
        "jobId": "job-123",
        "allowedTools": ["github_search_issues"],
    },
}
print(json.dumps({"text": mod.format_scheduled_job_context(payload, now_utc="2026-06-17T19:00:00Z")}))
`);

    const text = (result as { text: string }).text;
    expect(text).toContain("currentUtc=2026-06-17T19:00:00Z");
    expect(text).toContain("allowedTools=github_search_issues");
    expect(text).toContain("Use currentUtc for scheduled time-window calculations");
  });

  test("detects scheduled provider bridge missing final responses", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
message = {
    "scheduledJob": {
        "jobId": "job-123",
        "allowedTools": ["github_search_issues"],
    },
}
print(json.dumps({
    "missing": mod.scheduled_provider_bridge_missing_error(
        message,
        "Blocked: this runtime session does not expose the required burble_provider_call tool."
    ),
    "normal": mod.scheduled_provider_bridge_missing_error(
        message,
        "No new pull requests were found."
    ),
    "interactive": mod.scheduled_provider_bridge_missing_error(
        {},
        "burble_provider_call is not exposed here."
    ),
}))
`);

    expect(result).toEqual({
      missing:
        "scheduled_provider_bridge_missing: scheduled job job-123 requires provider tools but Hermes reported burble_provider_call/runtime tools unavailable",
      normal: null,
      interactive: null
    });
  });

  test("adds provider-backed scheduled job repair guidance to scheduler-only Hermes turns", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
payload = {
    "text": "manually run our existing cron job",
    "toolGroups": {
        "groups": ["conversation", "scheduler"],
        "reasons": ["default:conversation", "keyword:scheduler:cron"],
    },
}
print(json.dumps({"text": mod.build_hermes_turn_text(payload)}))
`);

    const text = (result as { text: string }).text;
    expect(text).toContain("Provider-backed scheduled job repair:");
    expect(text).toContain("Before manually triggering");
    expect(text).toContain("Setup-time provider calls are not scheduled provider calls");
    expect(text).toContain("use ordinary Burble provider calls");
    expect(text).toContain("Never invent placeholder job ids");
    expect(text).toContain("do not request an immediate/manual run");
    expect(text).toContain("After the native scheduler returns the stable job id");
    expect(text).toContain("If registration does not return ok, do not trigger");
    expect(text).toContain(
      'visibilityPolicy {"maxOutputVisibility":"public"}'
    );
    expect(text).toContain("Slack channel labels are not route ids");
    expect(text).toContain("use the Burble platform delivery target");
    expect(text).toContain("burble:<returned routeId>");
    expect(text).toContain("Never use slack:<channelId>");
    expect(text).toContain(
      "do not register a Slack channel destination"
    );
    expect(text).toContain("explicit declassification approval flow");
    expect(text).toContain("Only after the job prompt has been updated");
    expect(text).toContain("scheduled_job_register_capability");
    expect(text).toContain(
      "Scheduled provider tool calls must include the returned jobId"
    );
    expect(text).toContain("must not use direct web/browser access to provider URLs");
    expect(text).not.toContain("Example Drive scratchpad registration input");
    expect(text).not.toContain("Drive scratchpad");
    expect(text).not.toContain("Google Drive scratchpad");
  });

  test("uses per-run Hermes thread ids by default", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
print(json.dumps({
    "run": mod.build_hermes_thread_id(
        "run-123",
        {"rootId": "dm:D123"},
        scope="run",
    ),
    "conversation": mod.build_hermes_thread_id(
        "run-123",
        {"rootId": "dm:D123"},
        scope="conversation",
    ),
}))
`);

    expect(result).toEqual({
      run: "run-123",
      conversation: "dm:D123"
    });
  });

  test("writes Hermes config with compact Burble provider tool instead of full MCP catalog", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
import os
import tempfile

home = tempfile.mkdtemp()
os.environ["HERMES_HOME"] = home
os.environ["BURBLE_MCP_GATEWAY_URL"] = "http://agentgateway:3000/mcp"
os.environ["BURBLE_RUNTIME_JWT"] = "jwt"

runtime = mod.BurbleHermesRuntime()
runtime._ensure_gateway_config()
print(json.dumps({
    "config": (runtime.home / "config.yaml").read_text(),
}))
`);

    const config = (result as { config: string }).config;
    expect(config).toContain("burble-platform");
    expect(config).toContain("burble-provider-tool");
    expect(config).toContain(
      [
        "streaming:",
        "  enabled: true",
        "  transport: edit",
        '  cursor: "[[BURBLE_STREAM_CURSOR]]"'
      ].join("\n")
    );
    expect(config).not.toContain("\u2063");
    expect(config).not.toContain("▉");
    expect(config).not.toContain("mcp_servers:");
  });

  test("streams Hermes platform edits as Burble runtime message deltas", () => {
    const result = runHermesEntrypointProbe(`${importBurblePlatformAdapter}
import asyncio
import os

os.environ["BURBLE_TOOL_GATEWAY_URL"] = "http://burble-app:3000/internal/tools"
os.environ["BURBLE_INTERNAL_TOKEN"] = "token"
os.environ["BURBLE_RUNTIME_ID"] = "rt_123"

async def main():
    cursor = "[[BURBLE_STREAM_CURSOR]]"
    adapter = mod.BurbleAdapter(
        types.SimpleNamespace(
            extra={
                "runtime_callback_url": "http://runtime/internal/hermes/runs",
            }
        )
    )
    adapter._pending_runs["route-1"] = "run-1"

    sent = await adapter.send("route-1", f"Hello{cursor}")
    await adapter.edit_message("route-1", sent.message_id, f"Hello world{cursor}")
    await adapter.edit_message("route-1", sent.message_id, "Hello world", finalize=True)

    print(json.dumps({
        "messageId": sent.message_id,
        "payloads": posted_payloads,
    }))

asyncio.run(main())
`);

    expect(result).toEqual({
      messageId: "burble-stream:run-1:1",
      payloads: [
        {
          url: "http://runtime/internal/hermes/runs/run-1/messages",
          json: {
            type: "message_delta",
            routeId: "route-1",
            text: "Hello",
            classification: "user_private"
          }
        },
        {
          url: "http://runtime/internal/hermes/runs/run-1/messages",
          json: {
            type: "message_delta",
            routeId: "route-1",
            text: " world",
            classification: "user_private"
          }
        },
        {
          url: "http://runtime/internal/hermes/runs/run-1/messages",
          json: {
            routeId: "route-1",
            text: "Hello world",
            classification: "user_private"
          }
        }
      ]
    });
  });

  test("accepts Hermes typing metadata without posting progress", () => {
    const result = runHermesEntrypointProbe(`${importBurblePlatformAdapter}
import asyncio
import os

os.environ["BURBLE_TOOL_GATEWAY_URL"] = "http://burble-app:3000/internal/tools"
os.environ["BURBLE_INTERNAL_TOKEN"] = "token"
os.environ["BURBLE_RUNTIME_ID"] = "rt_123"

async def main():
    adapter = mod.BurbleAdapter(types.SimpleNamespace(extra={}))
    ok = await adapter.send_typing("route-1", metadata={"phase": "tool"})
    print(json.dumps({"ok": ok, "payloads": posted_payloads}))

asyncio.run(main())
`);

    expect(result).toEqual({
      ok: true,
      payloads: []
    });
  });

  test("forwards Hermes route-send job metadata to the conversation gateway", () => {
    const result = runHermesEntrypointProbe(`${importBurblePlatformAdapter}
import asyncio
import os

os.environ["BURBLE_TOOL_GATEWAY_URL"] = "http://burble-app:3000/internal/tools"
os.environ["BURBLE_INTERNAL_TOKEN"] = "token"
os.environ["BURBLE_RUNTIME_ID"] = "rt_123"

async def main():
    adapter = mod.BurbleAdapter(types.SimpleNamespace(extra={}))
    sent = await adapter.send(
        "convrt_abc123",
        "Scheduled report",
        metadata={"jobId": "job-123"},
    )
    print(json.dumps({"success": sent.success, "payloads": posted_payloads}))

asyncio.run(main())
`);

    expect(result).toEqual({
      success: true,
      payloads: [
        {
          url: "http://burble-app:3000/internal/tools/conversation.sendMessage/execute",
          headers: {
            authorization: "Bearer token",
            "content-type": "application/json",
            "x-burble-runtime-id": "rt_123"
          },
          json: {
            scheduledJob: {
              jobId: "job-123"
            },
            input: {
              routeId: "convrt_abc123",
              text: "Scheduled report",
              jobId: "job-123"
            }
          }
        }
      ]
    });
  });

  test("refuses Hermes tool protocol from scheduled route sends", () => {
    const result = runHermesEntrypointProbe(`${importBurblePlatformAdapter}
import asyncio
import os

os.environ["BURBLE_TOOL_GATEWAY_URL"] = "http://burble-app:3000/internal/tools"
os.environ["BURBLE_INTERNAL_TOKEN"] = "token"
os.environ["BURBLE_RUNTIME_ID"] = "rt_123"

async def main():
    adapter = mod.BurbleAdapter(types.SimpleNamespace(extra={}))
    content = """Checking the last 24h window.
to=terminal_exec code
{"command":"date -u","timeout_ms":120000}
{"stdout":"2026-06-17T13:03:48Z\\n","stderr":"","exit_code":0}
to=burble_provider_call code
{"toolName":"github_search_issues","input":{"jobId":"job-123","query":"org:apelogic-ai is:pr"}}
{"tool":"github_search_issues","ok":true,"data":{"issues":[{"number":602}]}}

New open apelogic-ai PRs in the last 24h
- apelogic-ai/ape-leads #602 - notion - PR link
"""
    sent = await adapter.send(
        "convrt_abc123",
        content,
        metadata={"jobId": "job-123"},
    )
    print(json.dumps({"success": sent.success, "error": sent.error, "payloads": posted_payloads}))

asyncio.run(main())
`);

    expect(result).toEqual({
      success: false,
      error: "Hermes produced tool-call protocol text instead of structured tool calls; refusing to publish untrusted assistant content",
      payloads: []
    });
  });

  test("refuses scheduled route sends that report a missing provider bridge", () => {
    const result = runHermesEntrypointProbe(`${importBurblePlatformAdapter}
import asyncio
import os

os.environ["BURBLE_TOOL_GATEWAY_URL"] = "http://burble-app:3000/internal/tools"
os.environ["BURBLE_INTERNAL_TOKEN"] = "token"
os.environ["BURBLE_RUNTIME_ID"] = "rt_123"

async def main():
    adapter = mod.BurbleAdapter(types.SimpleNamespace(extra={}))
    content = """
Cronjob Response: apelogic-ai-open-prs-last-24h-drive-dedupe
(job_id: job-123)
-------------

Unable to complete this run as requested because the runtime session does not expose the required Burble provider bridge tool burble_provider_call or any equivalent GitHub/Google Drive provider tools.
"""
    sent = await adapter.send(
        "convrt_abc123",
        content,
        metadata={"jobId": "job-123"},
    )
    print(json.dumps({"success": sent.success, "error": sent.error, "payloads": posted_payloads}))

asyncio.run(main())
`);

    expect(result).toEqual({
      success: false,
      error:
        "scheduled_provider_bridge_missing: Hermes scheduled output reported burble_provider_call/runtime provider tools unavailable",
      payloads: []
    });
  });

  test("strips Hermes stream cursors even when embedded in cumulative text", () => {
    const result = runHermesEntrypointProbe(`${importBurblePlatformAdapter}
import asyncio
import os

os.environ["BURBLE_TOOL_GATEWAY_URL"] = "http://burble-app:3000/internal/tools"
os.environ["BURBLE_INTERNAL_TOKEN"] = "token"
os.environ["BURBLE_RUNTIME_ID"] = "rt_123"

async def main():
    adapter = mod.BurbleAdapter(
        types.SimpleNamespace(
            extra={
                "runtime_callback_url": "http://runtime/internal/hermes/runs",
            }
        )
    )
    adapter._pending_runs["route-1"] = "run-1"

    sent = await adapter.send("route-1", "I could ▉")
    await adapter.edit_message(
        "route-1",
        sent.message_id,
        "I couldn’t list your ▉\\n\\nGoogle Analytics properties right now. ■",
    )
    await adapter.edit_message(
        "route-1",
        sent.message_id,
        "I couldn’t list your ▉\\n\\nGoogle Analytics properties right now.",
        finalize=True,
    )

    print(json.dumps({
        "payloads": posted_payloads,
    }))

asyncio.run(main())
`);

    expect(result).toEqual({
      payloads: [
        {
          url: "http://runtime/internal/hermes/runs/run-1/messages",
          json: {
            type: "message_delta",
            routeId: "route-1",
            text: "I could",
            classification: "user_private"
          }
        },
        {
          url: "http://runtime/internal/hermes/runs/run-1/messages",
          json: {
            type: "message_delta",
            routeId: "route-1",
            text: "n’t list your \n\nGoogle Analytics properties right now.",
            classification: "user_private"
          }
        },
        {
          url: "http://runtime/internal/hermes/runs/run-1/messages",
          json: {
            routeId: "route-1",
            text: "I couldn’t list your \n\nGoogle Analytics properties right now.",
            classification: "user_private"
          }
        }
      ]
    });
  });

  test("uses replacement events when Hermes rewrites cumulative stream text", () => {
    const result = runHermesEntrypointProbe(`${importBurblePlatformAdapter}
import asyncio
import os

os.environ["BURBLE_TOOL_GATEWAY_URL"] = "http://burble-app:3000/internal/tools"
os.environ["BURBLE_INTERNAL_TOKEN"] = "token"
os.environ["BURBLE_RUNTIME_ID"] = "rt_123"

async def main():
    adapter = mod.BurbleAdapter(
        types.SimpleNamespace(
            extra={
                "runtime_callback_url": "http://runtime/internal/hermes/runs",
            }
        )
    )
    adapter._pending_runs["route-1"] = "run-1"

    sent = await adapter.send("route-1", "Hello wrld ▉")
    await adapter.edit_message("route-1", sent.message_id, "Hello world ▉")
    await adapter.edit_message("route-1", sent.message_id, "Hello world", finalize=True)

    print(json.dumps({
        "payloads": posted_payloads,
    }))

asyncio.run(main())
`);

    expect(result).toEqual({
      payloads: [
        {
          url: "http://runtime/internal/hermes/runs/run-1/messages",
          json: {
            type: "message_delta",
            routeId: "route-1",
            text: "Hello wrld",
            classification: "user_private"
          }
        },
        {
          url: "http://runtime/internal/hermes/runs/run-1/messages",
          json: {
            type: "message_replace",
            routeId: "route-1",
            text: "Hello world",
            classification: "user_private"
          }
        },
        {
          url: "http://runtime/internal/hermes/runs/run-1/messages",
          json: {
            routeId: "route-1",
            text: "Hello world",
            classification: "user_private"
          }
        }
      ]
    });
  });

  test("normalizes nested OpenAI token detail usage in Hermes runtime callbacks", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
print(json.dumps(mod.normalize_usage({
    "input_tokens": 1701,
    "output_tokens": 23,
    "total_tokens": 22588,
    "input_tokens_details": {"cached_tokens": 20864},
    "output_tokens_details": {"reasoning_tokens": 85},
})))
`);

    expect(result).toEqual({
      inputTokens: 1701,
      outputTokens: 23,
      totalTokens: 22588,
      cachedInputTokens: 20864,
      reasoningTokens: 85
    });
  });

  test("normalizes nested OpenAI token detail usage in Hermes platform callbacks", () => {
    const result = runHermesEntrypointProbe(`${importBurblePlatformAdapter}
print(json.dumps(mod._normalize_usage({
    "input_tokens": 1701,
    "output_tokens": 23,
    "total_tokens": 22588,
    "input_tokens_details": {"cached_tokens": 20864},
    "output_tokens_details": {"reasoning_tokens": 85},
})))
`);

    expect(result).toEqual({
      inputTokens: 1701,
      outputTokens: 23,
      totalTokens: 22588,
      cachedInputTokens: 20864,
      reasoningTokens: 85
    });
  });

  test("restricts Hermes Burble platform to the minimal native tool surface", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
import os
import tempfile

home = tempfile.mkdtemp()
os.environ["HERMES_HOME"] = home

runtime = mod.BurbleHermesRuntime()
runtime._ensure_gateway_config()
print(json.dumps({
    "config": (runtime.home / "config.yaml").read_text(),
}))
`);

    const config = (result as { config: string }).config;
    expect(config).toContain("memory:\n  memory_enabled: false\n  user_profile_enabled: false");
    expect(config).toContain("platform_toolsets:\n  burble:\n    - burble\n    - cronjob\n    - web");
    expect(config).toContain("  disabled_toolsets:");
    expect(config).toContain("    - skills");
    expect(config).toContain("    - memory");
    expect(config).toContain("    - file");
    expect(config).toContain("    - terminal");
  });

  test("keeps scheduled provider bridge toolsets when Hermes platform toolsets are overridden", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
import os
import tempfile

home = tempfile.mkdtemp()
os.environ["HERMES_HOME"] = home
os.environ["BURBLE_HERMES_PLATFORM_TOOLSETS"] = "burble"

runtime = mod.BurbleHermesRuntime()
runtime._ensure_gateway_config()
print(json.dumps({
    "config": (runtime.home / "config.yaml").read_text(),
}))
`);

    const config = (result as { config: string }).config;
    expect(config).toContain("platform_toolsets:\n  burble:\n    - burble\n    - cronjob\n    - web");
  });

  test("repairs persisted Hermes provider cron jobs with native toolsets", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
import os
import pathlib
import tempfile

home = tempfile.mkdtemp()
os.environ["HERMES_HOME"] = home
cron_dir = pathlib.Path(home) / "cron"
cron_dir.mkdir(parents=True, exist_ok=True)
jobs_path = cron_dir / "jobs.json"
jobs_path.write_text(json.dumps({
    "jobs": [
        {
            "id": "9f32de992914",
            "name": "apelogic-ai-open-prs-last-24h-drive-dedupe",
            "prompt": "Use Burble provider calls with this jobId for this scheduled job.\\njobId=9f32de992914\\nallowedTools=github_search_issues,google_get_drive_file\\nUse the runtime's Burble provider bridge tool burble_provider_call for these tools.",
            "enabled_toolsets": None,
        },
        {
            "id": "custom",
            "name": "custom-provider-job",
            "prompt": "Use Burble provider calls with this jobId for this scheduled job.\\njobId=custom\\nallowedTools=google_get_drive_file\\nUse the runtime's Burble provider bridge tool burble_provider_call for these tools.",
            "enabled_toolsets": ["safe"],
        },
        {
            "id": "plain",
            "name": "plain-job",
            "prompt": "Say hello.",
            "enabled_toolsets": None,
        },
    ],
    "updated_at": "old",
}), encoding="utf-8")

runtime = mod.BurbleHermesRuntime()
runtime._repair_scheduled_provider_cron_jobs()
print(json.dumps(json.loads(jobs_path.read_text())))
`);

    const jobs = (result as { jobs: Array<{ id: string; enabled_toolsets: string[] | null }> }).jobs;
    expect(jobs.find((job) => job.id === "9f32de992914")?.enabled_toolsets).toEqual([
      "cronjob",
      "web"
    ]);
    expect(jobs.find((job) => job.id === "custom")?.enabled_toolsets).toEqual([
      "safe",
      "cronjob",
      "web"
    ]);
    expect(jobs.find((job) => job.id === "plain")?.enabled_toolsets).toBeNull();
  });

  test("can opt Hermes back into full MCP catalog for debugging", () => {
    const result = runHermesEntrypointProbe(`${importEntrypoint}
import os
import tempfile

home = tempfile.mkdtemp()
os.environ["HERMES_HOME"] = home
os.environ["BURBLE_MCP_GATEWAY_URL"] = "http://agentgateway:3000/mcp"
os.environ["BURBLE_RUNTIME_JWT"] = "jwt"
os.environ["BURBLE_HERMES_ENABLE_MCP_CATALOG"] = "true"

runtime = mod.BurbleHermesRuntime()
runtime._ensure_gateway_config()
print(json.dumps({
    "config": (runtime.home / "config.yaml").read_text(),
}))
`);

    const config = (result as { config: string }).config;
    expect(config).toContain("burble-provider-tool");
    expect(config).toContain("mcp_servers:");
    expect(config).toContain("url: ${BURBLE_MCP_GATEWAY_URL}");
  });

  test("normalizes selected Burble provider tool names", () => {
    const result = runHermesEntrypointProbe(`${importProviderToolPlugin}
print(json.dumps({
    "github": mod.normalize_burble_tool_name("github_list_my_pull_requests"),
    "google": mod.normalize_burble_tool_name("google_append_to_drive_text_file"),
    "analytics": mod.normalize_burble_tool_name("google_analytics_run_report"),
    "slides": mod.normalize_burble_tool_name("google_slides_probe_template"),
    "slides_copy": mod.normalize_burble_tool_name("google_slides_copy_presentation"),
    "slides_create": mod.normalize_burble_tool_name("google_slides_create_slide"),
    "slides_fill": mod.normalize_burble_tool_name("google_slides_fill_placeholders"),
    "hubspot": mod.normalize_burble_tool_name("hubspot_read_api_resource"),
    "jira": mod.normalize_burble_tool_name("jira_list_assigned_issues"),
    "job": mod.normalize_burble_tool_name("scheduled_job_register_capability"),
    "attachment": mod.normalize_burble_tool_name("conversation_get_attachment"),
    "dotted": mod.normalize_burble_tool_name("google.searchDriveFiles"),
}))
`);

    expect(result).toEqual({
      github: "github.listMyPullRequests",
      google: "google.appendDriveTextFile",
      analytics: "google.analyticsRunReport",
      slides: "google.slidesProbeTemplate",
      slides_copy: "google.slidesCopyPresentation",
      slides_create: "google.slidesCreateSlide",
      slides_fill: "google.slidesFillPlaceholders",
      hubspot: "hubspot.readApiResource",
      jira: "jira.listAssignedIssues",
      job: "scheduledJob.registerCapability",
      attachment: "conversation.getAttachment",
      dotted: "google.searchDriveFiles"
    });
  });

  test("registers Burble provider bridge tools in a cron-visible toolset", () => {
    const result = runHermesEntrypointProbe(`${importProviderToolPlugin}
class Ctx:
    def __init__(self):
        self.tools_by_name = {}

    def register_tool(self, **kwargs):
        self.tools_by_name[kwargs.get("name")] = {
            "name": kwargs.get("name"),
            "toolset": kwargs.get("toolset"),
            "is_async": kwargs.get("is_async"),
            "description": kwargs.get("description"),
            "schema": kwargs.get("schema"),
        }

ctx = Ctx()
mod.register(ctx)
print(json.dumps(list(ctx.tools_by_name.values())))
`) as Array<{
      name?: string;
      toolset?: string;
      is_async?: boolean;
      schema?: {
        parameters?: {
          properties?: {
            destination?: { description?: string };
            visibilityPolicy?: {
              description?: string;
              properties?: {
                maxOutputVisibility?: { enum?: string[] };
                allowPrivateToolDeclassification?: { type?: string };
              };
              additionalProperties?: boolean;
            };
          };
        };
      };
    }>;

    expect(result).toContainEqual(
      expect.objectContaining({
        name: "burble_provider_call",
        toolset: "cronjob",
        is_async: true
      })
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        name: "google_get_drive_file",
        toolset: "cronjob",
        is_async: true
      })
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        name: "google_append_to_drive_text_file",
        toolset: "cronjob",
        is_async: true
      })
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        name: "hubspot_search_contacts",
        toolset: "cronjob",
        is_async: true
      })
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        name: "scheduled_job_register_capability",
        toolset: "cronjob",
        is_async: true
      })
    );
    const scheduledJobTool = result.find(
      (tool: { name?: string }) =>
        tool.name === "scheduled_job_register_capability"
    );
    expect(
      scheduledJobTool?.schema?.parameters?.properties?.destination?.description
    ).toContain("/agent grant here");
    expect(
      scheduledJobTool?.schema?.parameters?.properties?.destination?.description
    ).toContain("instead of using them as route ids");
    expect(
      scheduledJobTool?.schema?.parameters?.properties?.visibilityPolicy?.description
    ).toContain('"maxOutputVisibility":"public"');
    expect(
      scheduledJobTool?.schema?.parameters?.properties?.visibilityPolicy?.description
    ).toContain("Do not set allowPrivateToolDeclassification automatically");
    expect(
      scheduledJobTool?.schema?.parameters?.properties?.visibilityPolicy
        ?.properties?.maxOutputVisibility?.enum
    ).toEqual(["public", "user_private", "restricted"]);
    expect(
      scheduledJobTool?.schema?.parameters?.properties?.visibilityPolicy
        ?.properties?.allowPrivateToolDeclassification?.type
    ).toBe("boolean");
    expect(
      scheduledJobTool?.schema?.parameters?.properties?.visibilityPolicy
        ?.additionalProperties
    ).toBe(false);
    expect(result).toContainEqual(
      expect.objectContaining({
        name: "conversation_get_attachment",
        toolset: "cronjob",
        is_async: true
      })
    );
    expect(result).not.toContainEqual(
      expect.objectContaining({
        name: "google_get_drive_file",
        toolset: "web"
      })
    );
    expect(result).not.toContainEqual(
      expect.objectContaining({
        name: "atlassian_list_mcp_tools",
        toolset: "web"
      })
    );
    const tools = result as Array<{
      name?: string;
      schema?: {
        parameters?: {
          required?: string[];
          anyOf?: Array<{ required?: string[] }>;
          properties?: Record<string, { items?: unknown }>;
        };
      };
    }>;
    const registrationTool = tools.find(
      (tool: { name?: string }) => tool.name === "scheduled_job_register_capability"
    );
    expect(registrationTool?.schema?.parameters?.required).toEqual([
      "jobId"
    ]);
    expect(registrationTool?.schema?.parameters?.anyOf).toEqual([
      { required: ["requiredTools"] },
      { required: ["allowedTools"] },
      { required: ["required_tools"] },
      { required: ["allowed_tools"] },
      { required: ["tools"] }
    ]);
    expect(
      registrationTool?.schema?.parameters?.properties?.requiredTools?.items
    ).toEqual({ type: "string" });
    expect(
      registrationTool?.schema?.parameters?.properties?.allowedTools?.items
    ).toEqual({ type: "string" });
    expect(
      registrationTool?.schema?.parameters?.properties?.tools?.items
    ).toEqual({ type: "string" });
  });

  test("forwards the canonical provider bridge envelope with scheduled job identity", () => {
    const result = runHermesEntrypointProbe(`${importProviderToolPlugin}
import asyncio
import os

os.environ["BURBLE_TOOL_GATEWAY_URL"] = "http://burble-app:3000/internal/tools"
os.environ["BURBLE_INTERNAL_TOKEN"] = "runtime-secret"
os.environ["BURBLE_RUNTIME_ID"] = "rt_u123"

calls = []

class FakeResponse:
    status = 200

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def json(self):
        return {
            "classification": "user_private",
            "content": {"name": "Scratchpad"},
        }

class FakeSession:
    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    def post(self, url, json=None, headers=None):
        calls.append({"url": url, "json": json, "headers": headers})
        return FakeResponse()

mod.ClientSession = FakeSession
mod.ClientTimeout = lambda **_kwargs: None

async def main():
    result = await mod._burble_provider_call({
        "toolName": "google.getDriveFile",
        "input": {"fileId": "file-123", "jobId": "job-123"},
    })
    print(json.dumps({"result": json.loads(result), "calls": calls}))

asyncio.run(main())
`);

    expect(result).toEqual({
      result: { name: "Scratchpad" },
      calls: [
        {
          url: "http://burble-app:3000/internal/tools/google.getDriveFile/execute",
          json: {
            input: {
              fileId: "file-123",
              jobId: "job-123"
            },
            scheduledJob: {
              jobId: "job-123"
            }
          },
          headers: {
            authorization: "Bearer runtime-secret",
            "content-type": "application/json",
            "x-burble-runtime-id": "rt_u123"
          }
        }
      ]
    });
  });

  test("unwraps nested Hermes provider bridge envelopes", () => {
    const result = runHermesEntrypointProbe(`${importProviderToolPlugin}
import asyncio
import os

os.environ["BURBLE_TOOL_GATEWAY_URL"] = "http://burble-app:3000/internal/tools"
os.environ["BURBLE_INTERNAL_TOKEN"] = "runtime-secret"
os.environ["BURBLE_RUNTIME_ID"] = "rt_u123"

calls = []

class FakeResponse:
    status = 200
    async def __aenter__(self):
        return self
    async def __aexit__(self, *_args):
        return None
    async def json(self):
        return {
            "classification": "user_private",
            "content": {"name": "Scratchpad"},
        }

class FakeSession:
    def __init__(self, *args, **kwargs):
        pass
    async def __aenter__(self):
        return self
    async def __aexit__(self, *_args):
        return None
    def post(self, url, json=None, headers=None):
        calls.append({"url": url, "json": json, "headers": headers})
        return FakeResponse()

mod.ClientSession = FakeSession
mod.ClientTimeout = lambda **_kwargs: None

async def main():
    result = await mod._burble_provider_call({
        "name": "burble_provider_call",
        "arguments": {
            "toolName": "google_get_drive_file",
            "input": {"fileId": "file-123", "jobId": "job-123"},
        },
    })
    print(json.dumps({"result": json.loads(result), "calls": calls}))

asyncio.run(main())
`);

    expect(result).toEqual({
      result: { name: "Scratchpad" },
      calls: [
        {
          url: "http://burble-app:3000/internal/tools/google.getDriveFile/execute",
          json: {
            input: {
              fileId: "file-123",
              jobId: "job-123"
            },
            scheduledJob: {
              jobId: "job-123"
            }
          },
          headers: {
            authorization: "Bearer runtime-secret",
            "content-type": "application/json",
            "x-burble-runtime-id": "rt_u123"
          }
        }
      ]
    });
  });

  test("rejects recursive Hermes provider bridge calls locally", () => {
    const result = runHermesEntrypointProbe(`${importProviderToolPlugin}
import asyncio
import os

os.environ["BURBLE_TOOL_GATEWAY_URL"] = "http://burble-app:3000/internal/tools"
os.environ["BURBLE_INTERNAL_TOKEN"] = "runtime-secret"
os.environ["BURBLE_RUNTIME_ID"] = "rt_u123"

class FakeSession:
    def __init__(self, *args, **kwargs):
        raise AssertionError("gateway should not be called")

mod.ClientSession = FakeSession

async def main():
    result = await mod._burble_provider_call({"name": "burble_provider_call"})
    print(json.dumps(json.loads(result)))

asyncio.run(main())
`);

    expect(result).toEqual({
      error: true,
      message: "burble_provider_call requires toolName"
    });
  });

  test("pins Burble provider bridge tool into Hermes toolsets for cron jobs", () => {
    const result = runHermesEntrypointProbe(`${importProviderToolPlugin}
toolsets = types.ModuleType("toolsets")
toolsets.TOOLSETS = {
    "web": {
        "description": "Web research and content extraction tools",
        "tools": ["web_search", "web_extract"],
        "includes": [],
    },
    "pr_monitor": {
        "description": "Existing saved PR monitor toolset",
        "tools": ["cron_run"],
        "includes": [],
    }
}
sys.modules["toolsets"] = toolsets

class Ctx:
    def __init__(self):
        self.registered = []

    def register_tool(self, **kwargs):
        self.registered.append({"name": kwargs.get("name"), "toolset": kwargs.get("toolset")})

ctx = Ctx()
mod.register(ctx)
print(json.dumps({
    "web": toolsets.TOOLSETS["web"]["tools"],
    "pr_monitor": toolsets.TOOLSETS["pr_monitor"]["tools"],
    "registered": ctx.registered,
}))
`) as {
      web: string[];
      pr_monitor: string[];
      registered: Array<{ name?: string; toolset?: string }>;
    };

    expect(result.web).toContain("web_search");
    expect(result.web).toContain("web_extract");
    expect(result.web).toContain("burble_provider_call");
    expect(result.web).not.toContain("google_get_drive_file");
    expect(result.web).not.toContain("google_append_to_drive_text_file");
    expect(result.web).not.toContain("scheduled_job_register_capability");
    expect(result.pr_monitor).toContain("cron_run");
    expect(result.pr_monitor).toContain("burble_provider_call");
    expect(result.registered).toContainEqual({
      name: "burble_provider_call",
      toolset: "cronjob"
    });
  });

  test("Hermes web extract falls back locally when upstream safety helper is unavailable", () => {
    const result = runHermesEntrypointProbe(String.raw`
import importlib.util
import json
import os
import sys
import types
import asyncio

for key in ("FIRECRAWL_API_KEY", "FIRECRAWL_API_URL", "TAVILY_API_KEY", "EXA_API_KEY", "PARALLEL_API_KEY"):
    os.environ.pop(key, None)

tools = types.ModuleType("tools")
web_tools = types.ModuleType("tools.web_tools")
web_tools.WEB_EXTRACT_SCHEMA = {"description": "extract"}
sys.modules["tools"] = tools
sys.modules["tools.web_tools"] = web_tools

class FakeResponse:
    status = 200
    url = "https://example.com/news"
    async def __aenter__(self):
        return self
    async def __aexit__(self, *_args):
        return None
    async def text(self, errors=None):
        return "<html><title>AI News</title><body><article><h1>Hello</h1><p>Public update</p></article></body></html>"

class FakeSession:
    def __init__(self, *args, **kwargs):
        pass
    async def __aenter__(self):
        return self
    async def __aexit__(self, *_args):
        return None
    def get(self, url, **kwargs):
        return FakeResponse()

aiohttp = types.ModuleType("aiohttp")
aiohttp.ClientSession = FakeSession
aiohttp.ClientTimeout = lambda **_kwargs: None
sys.modules["aiohttp"] = aiohttp

spec = importlib.util.spec_from_file_location(
    "burble_web_extract",
    "runtimes/nemo-hermes/hermes-plugins/burble-web-extract/__init__.py",
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
async def fake_resolve_host_addresses(host, port):
    return ["93.184.216.34"]
mod._resolve_host_addresses = fake_resolve_host_addresses

async def main():
    value = await mod._local_web_extract({"urls": ["https://example.com/news"]})
    print(json.dumps(json.loads(value)))

asyncio.run(main())
`);

    expect(result).toEqual({
      results: [
        expect.objectContaining({
          url: "https://example.com/news",
          title: "AI News",
          content: expect.stringContaining("Public update"),
          error: null
        })
      ]
    });
  });

  test("Hermes web extract blocks hostnames resolving to private addresses", () => {
    const result = runHermesEntrypointProbe(String.raw`
import importlib.util
import json
import os
import sys
import types
import asyncio

for key in ("FIRECRAWL_API_KEY", "FIRECRAWL_API_URL", "TAVILY_API_KEY", "EXA_API_KEY", "PARALLEL_API_KEY"):
    os.environ.pop(key, None)

tools = types.ModuleType("tools")
web_tools = types.ModuleType("tools.web_tools")
web_tools.WEB_EXTRACT_SCHEMA = {"description": "extract"}
sys.modules["tools"] = tools
sys.modules["tools.web_tools"] = web_tools

class FakeSession:
    def __init__(self, *args, **kwargs):
        pass
    async def __aenter__(self):
        return self
    async def __aexit__(self, *_args):
        return None
    def get(self, url, **kwargs):
        raise AssertionError("private-resolving host must not be fetched")

aiohttp = types.ModuleType("aiohttp")
aiohttp.ClientSession = FakeSession
aiohttp.ClientTimeout = lambda **_kwargs: None
sys.modules["aiohttp"] = aiohttp

spec = importlib.util.spec_from_file_location(
    "burble_web_extract",
    "runtimes/nemo-hermes/hermes-plugins/burble-web-extract/__init__.py",
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
async def fake_resolve_host_addresses(host, port):
    return ["169.254.169.254"]
mod._resolve_host_addresses = fake_resolve_host_addresses

async def main():
    value = await mod._local_web_extract({"urls": ["http://metadata.attacker.test/latest"]})
    print(json.dumps(json.loads(value)))

asyncio.run(main())
`);

    expect(result).toEqual({
      results: [
        expect.objectContaining({
          url: "http://metadata.attacker.test/latest",
          content: "",
          error: "Blocked: URL targets a private or internal network address"
        })
      ]
    });
  });

  test("Hermes web extract does not fall back locally after configured backend failure", () => {
    const result = runHermesEntrypointProbe(String.raw`
import importlib.util
import json
import os
import sys
import types
import asyncio

os.environ["FIRECRAWL_API_KEY"] = "configured"

tools = types.ModuleType("tools")
web_tools = types.ModuleType("tools.web_tools")
web_tools.WEB_EXTRACT_SCHEMA = {"description": "extract"}
async def web_extract_tool(**_kwargs):
    raise RuntimeError("backend policy rejected URL")
web_tools.web_extract_tool = web_extract_tool
sys.modules["tools"] = tools
sys.modules["tools.web_tools"] = web_tools

aiohttp = types.ModuleType("aiohttp")
aiohttp.ClientSession = lambda *args, **kwargs: (_ for _ in ()).throw(
    AssertionError("local fallback must not run after backend failure")
)
aiohttp.ClientTimeout = lambda **_kwargs: None
sys.modules["aiohttp"] = aiohttp

spec = importlib.util.spec_from_file_location(
    "burble_web_extract",
    "runtimes/nemo-hermes/hermes-plugins/burble-web-extract/__init__.py",
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

async def main():
    try:
        await mod._local_web_extract({"urls": ["https://example.com/news"]})
    except Exception as error:
        print(json.dumps({"error": str(error)}))

asyncio.run(main())
`);

    expect(result).toEqual({
      error: "configured web_extract backend failed: backend policy rejected URL"
    });
  });
});
