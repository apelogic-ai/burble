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
    def post(self, url, json):
        posted_payloads.append({"url": url, "json": json})
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
      attachments: false,
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
      "Ensure this native scheduled job has the provider bridge toolset enabled"
    );
    expect(text).toContain("cronjob");
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
      'streaming:\n  enabled: true\n  transport: edit\n  cursor: " ▉"'
    );
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
    adapter = mod.BurbleAdapter(
        types.SimpleNamespace(
            extra={
                "runtime_callback_url": "http://runtime/internal/hermes/runs",
            }
        )
    )
    adapter._pending_runs["route-1"] = "run-1"

    sent = await adapter.send("route-1", "Hello ▉")
    await adapter.edit_message("route-1", sent.message_id, "Hello world ▉")
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
    "hubspot": mod.normalize_burble_tool_name("hubspot_read_api_resource"),
    "jira": mod.normalize_burble_tool_name("jira_list_assigned_issues"),
    "job": mod.normalize_burble_tool_name("scheduled_job_register_capability"),
    "dotted": mod.normalize_burble_tool_name("google.searchDriveFiles"),
}))
`);

    expect(result).toEqual({
      github: "github.listMyPullRequests",
      google: "google.appendToDriveTextFile",
      hubspot: "hubspot.readApiResource",
      jira: "jira.listAssignedIssues",
      job: "scheduledJob.registerCapability",
      dotted: "google.searchDriveFiles"
    });
  });

  test("registers Burble provider bridge tools in a cron-visible toolset", () => {
    const result = runHermesEntrypointProbe(`${importProviderToolPlugin}
class Ctx:
    def __init__(self):
        self.tools = []

    def register_tool(self, **kwargs):
        self.tools.append({
            "name": kwargs.get("name"),
            "toolset": kwargs.get("toolset"),
            "is_async": kwargs.get("is_async"),
            "description": kwargs.get("description"),
            "schema": kwargs.get("schema"),
        })

ctx = Ctx()
mod.register(ctx)
print(json.dumps(ctx.tools))
`);

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
    expect(result).toContainEqual(
      expect.objectContaining({
        name: "burble_provider_call",
        toolset: "web",
        is_async: true
      })
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        name: "google_get_drive_file",
        toolset: "web",
        is_async: true
      })
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        name: "google_append_to_drive_text_file",
        toolset: "web",
        is_async: true
      })
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        name: "hubspot_search_contacts",
        toolset: "web",
        is_async: true
      })
    );
    const tools = result as Array<{
      name?: string;
      schema?: {
        parameters?: {
          required?: string[];
          properties?: Record<string, { items?: unknown }>;
        };
      };
    }>;
    const registrationTool = tools.find(
      (tool: { name?: string }) => tool.name === "scheduled_job_register_capability"
    );
    expect(registrationTool?.schema?.parameters?.required).toEqual([
      "jobId",
      "requiredTools"
    ]);
    expect(
      registrationTool?.schema?.parameters?.properties?.requiredTools?.items
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

  test("pins Burble provider bridge tools into the Hermes web toolset for cron jobs", () => {
    const result = runHermesEntrypointProbe(`${importProviderToolPlugin}
toolsets = types.ModuleType("toolsets")
toolsets.TOOLSETS = {
    "web": {
        "description": "Web research and content extraction tools",
        "tools": ["web_search", "web_extract"],
        "includes": [],
    }
}
sys.modules["toolsets"] = toolsets

class Ctx:
    def register_tool(self, **kwargs):
        pass

mod.register(Ctx())
print(json.dumps(toolsets.TOOLSETS["web"]["tools"]))
`);

    expect(result).toContain("web_search");
    expect(result).toContain("web_extract");
    expect(result).toContain("burble_provider_call");
    expect(result).toContain("google_get_drive_file");
    expect(result).toContain("google_append_to_drive_text_file");
    expect(result).toContain("scheduled_job_register_capability");
  });
});
