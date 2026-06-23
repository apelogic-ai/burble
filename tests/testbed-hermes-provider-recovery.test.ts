import { describe, expect, test } from "bun:test";

function runPythonProbe(source: string): unknown {
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
    .find((line) => line.trim().startsWith("{"));
  if (!jsonLine) {
    throw new Error(`python probe did not print JSON:\n${stdout}\n${stderr}`);
  }
  return JSON.parse(jsonLine);
}

const importHermesEntrypoint = String.raw`
import importlib.util
import json
import sys
import types

sys.path.insert(0, "runtimes/nemo-hermes/runtime")

aiohttp = types.ModuleType("aiohttp")
aiohttp.ClientSession = object
aiohttp.ClientTimeout = object
aiohttp.web = types.SimpleNamespace(json_response=lambda body, **kwargs: body)
sys.modules["aiohttp"] = aiohttp

spec = importlib.util.spec_from_file_location(
    "burble_hermes_entrypoint",
    "runtimes/nemo-hermes/runtime/entrypoint.py",
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
`;

describe("local Hermes provider testbed", () => {
  test("recovers an MCP provider tool call when Hermes never returns a tool result", () => {
    const result = runPythonProbe(`${importHermesEntrypoint}
import asyncio
import os

os.environ["BURBLE_TOOL_GATEWAY_URL"] = "http://burble-app:3000/internal/tools"
os.environ["BURBLE_INTERNAL_TOKEN"] = "token"
os.environ["BURBLE_RUNTIME_ID"] = "rt_testbed"
os.environ["HERMES_PROVIDER_TOOL_CALL_RECOVERY_SECONDS"] = "0"

provider_calls = []

class FakeProviderResponse:
    status = 200

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def json(self):
        return {
            "content": [
                {"properties": {"name": "ROKA STUDIO", "domain": "renski.com"}},
            ]
        }

    async def text(self):
        return json.dumps(await self.json())

class FakeProviderSession:
    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def post(self, url, *, json=None, headers=None):
        provider_calls.append({"url": url, "json": json})
        return FakeProviderResponse()

provider_plugin = mod.load_burble_provider_tool_plugin()
provider_plugin.ClientSession = FakeProviderSession
provider_plugin.ClientTimeout = lambda total=None: None

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
    runtime.runs["run-testbed-tool-call"] = waiter
    runtime.run_messages["run-testbed-tool-call"] = {
        "originalText": "list my last companies in HubSpot",
        "runtime": {"id": "rt_testbed"},
    }

    await runtime.handle_run_message(
        FakeRequest(
            "run-testbed-tool-call",
            {
                "type": "tool_call",
                "toolName": "hubspot_search_crm_objects",
                "callId": "call_testbed_hubspot",
            },
        )
    )
    await asyncio.wait_for(waiter.future, timeout=1)

    events = []
    while not queue.empty():
        events.append(await queue.get())

    print(json.dumps({
        "events": events,
        "result": waiter.future.result(),
        "providerCalls": provider_calls,
    }))

asyncio.run(main())
`);

    expect(result).toEqual({
      events: [
        {
          type: "tool_call",
          toolName: "hubspot_search_crm_objects",
          callId: "call_testbed_hubspot"
        },
        {
          type: "tool_result",
          toolName: "hubspot_search_crm_objects",
          callId: "call_testbed_hubspot",
          classification: "user_private",
          content: [
            { properties: { name: "ROKA STUDIO", domain: "renski.com" } }
          ]
        },
        {
          type: "message_delta",
          text: "Latest HubSpot companies\n- ROKA STUDIO — renski.com"
        }
      ],
      result: {
        classification: "user_private",
        text: "Latest HubSpot companies\n- ROKA STUDIO — renski.com"
      },
      providerCalls: [
        {
          url:
            "http://burble-app:3000/internal/tools/hubspot.searchCrmObjects/execute",
          json: {
            input: {
              objectType: "companies",
              limit: 10,
              properties: ["name", "domain", "createdate", "hs_lastmodifieddate"]
            }
          }
        }
      ]
    });
  });
});
