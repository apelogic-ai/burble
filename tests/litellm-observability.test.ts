import { describe, expect, test } from "bun:test";

const callbackPath = "deploy/dev/compose/litellm/burble_observability.py";

describe("LiteLLM boundary observability", () => {
  test("hashes the OpenClaw prompt cache key and never emits request content", () => {
    const probe = String.raw`
import asyncio
import contextlib
import datetime
import importlib.util
import io
import json
import sys
import types

litellm = types.ModuleType("litellm")
integrations = types.ModuleType("litellm.integrations")
custom_logger = types.ModuleType("litellm.integrations.custom_logger")

class CustomLogger:
    def __init__(self, *args, **kwargs):
        self.kwargs = kwargs

custom_logger.CustomLogger = CustomLogger
sys.modules["litellm"] = litellm
sys.modules["litellm.integrations"] = integrations
sys.modules["litellm.integrations.custom_logger"] = custom_logger

spec = importlib.util.spec_from_file_location("burble_observability", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

secret_prompt = "enterprise customer prompt must stay private"
secret_argument = "private tool argument"
secret_key = "sk-enterprise-secret"
prompt_cache_key = "agent:main-scheduled:explicit:" + "x" * 80

request = {
    "model": "gpt-5.4",
    "stream": True,
    "prompt_cache_key": prompt_cache_key,
    "input": secret_prompt,
    "tools": [{"name": "search", "arguments": secret_argument}],
    "api_key": secret_key,
    "proxy_server_request": {
        "url": "http://llm-gw:4000/v1/responses?token=" + secret_key,
        "headers": {"authorization": "Bearer " + secret_key},
    },
}
success_kwargs = {
    **request,
    "litellm_call_id": "call-safe-123",
    "custom_llm_provider": "openai",
    "completion_start_time": datetime.datetime.fromtimestamp(102.0),
}
response = types.SimpleNamespace(
    id="resp_safe_123",
    _hidden_params={"additional_headers": {"x-request-id": "req_safe_123"}},
)
failure = types.SimpleNamespace(
    status_code=504,
    code="upstream_timeout",
    message="provider failed while handling " + secret_prompt,
)

async def run():
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        await module.boundary_logger.async_pre_call_hook(None, None, request, "aresponses")
        await module.boundary_logger.async_pre_call_deployment_hook(
            success_kwargs,
            "aresponses",
        )
        await module.boundary_logger.async_log_success_event(
            success_kwargs,
            response,
            datetime.datetime.fromtimestamp(100.0),
            datetime.datetime.fromtimestamp(105.0),
        )
        await module.boundary_logger.async_log_failure_event(
            success_kwargs,
            failure,
            datetime.datetime.fromtimestamp(200.0),
            datetime.datetime.fromtimestamp(203.0),
        )
    return [
        json.loads(line.removeprefix(module.LOG_PREFIX))
        for line in output.getvalue().splitlines()
        if line.strip()
    ]

events = asyncio.run(run())
assert module.boundary_logger.kwargs == {"turn_off_message_logging": True}
assert len(events) == 4
assert events[0]["event"] == "request_received"
assert events[1]["event"] == "provider_start"
assert events[2]["event"] == "provider_success"
assert events[0]["correlationId"] == events[2]["correlationId"]
assert events[2]["callId"] == "call-safe-123"
assert events[2]["providerRequestId"] == "req_safe_123"
assert events[2]["elapsedMs"] == 5000
assert events[2]["firstTokenMs"] == 2000
assert events[3]["event"] == "provider_failure"
assert events[3]["statusCode"] == 504
assert events[3]["errorCode"] == "upstream_timeout"
assert "message" not in events[3]
assert events[0]["route"] == "/v1/responses"
assert events[0]["toolCount"] == 1

serialized = json.dumps(events, sort_keys=True)
for forbidden in [secret_prompt, secret_argument, secret_key, "authorization", "token="]:
    assert forbidden not in serialized
`;
    const result = Bun.spawnSync({
      cmd: ["python3", "-c", probe, callbackPath],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      stdout: "pipe",
      stderr: "pipe"
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });
});
