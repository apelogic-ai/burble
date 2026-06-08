from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shutil
import shlex
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from aiohttp import ClientSession, ClientTimeout, web

from burble_runtime_contract import (
    ContractValidationError,
    validate_runtime_capability_manifest,
    validate_runtime_run_event,
    validate_runtime_run_request,
)


HERMES_PLUGIN_SOURCE = Path("/runtime/hermes-plugins")
MAX_HERMES_CONTEXT_MESSAGES = 12
MAX_HERMES_CONTEXT_MESSAGE_CHARS = 300
HERMES_PROVIDER_TOOL_HINTS: dict[str, list[dict[str, str]]] = {
    "github": [
        {
            "name": "github_list_my_pull_requests",
            "alias": "github.listMyPullRequests",
            "args": "limit?, state?, sort?, order?, owner?, repo?, query?",
        },
        {
            "name": "github_search_issues",
            "alias": "github.searchIssues",
            "args": "query, limit?",
        },
        {
            "name": "github_get_pr",
            "alias": "github.getPullRequest",
            "args": "repo, number",
        },
        {
            "name": "github_create_issue",
            "alias": "github.createIssue",
            "args": "repo, title, body?, labels?, assignees?",
        },
        {
            "name": "github_comment_on_issue_or_pr",
            "alias": "github.commentOnIssueOrPullRequest",
            "args": "repo, number, body",
        },
        {
            "name": "github_request_review",
            "alias": "github.requestReview",
            "args": "repo, number, reviewers?, team_reviewers?",
        },
    ],
    "google": [
        {
            "name": "google_search_drive_files",
            "alias": "google.searchDriveFiles",
            "args": "query?, limit?, orderBy?",
        },
        {
            "name": "google_get_drive_file",
            "alias": "google.getDriveFile",
            "args": "fileId",
        },
        {
            "name": "google_create_drive_text_file",
            "alias": "google.createDriveTextFile",
            "args": "name, text?, mimeType?",
        },
        {
            "name": "google_append_to_drive_text_file",
            "alias": "google.appendToDriveTextFile",
            "args": "fileId, text",
        },
        {
            "name": "google_search_calendar_events",
            "alias": "google.searchCalendarEvents",
            "args": "query?, timeMin?, timeMax?, limit?",
        },
        {
            "name": "google_search_mail_messages",
            "alias": "google.searchMailMessages",
            "args": "query, limit?",
        },
    ],
    "hubspot": [
        {
            "name": "hubspot_get_authenticated_user",
            "alias": "hubspot.getAuthenticatedUser",
            "args": "",
        },
        {
            "name": "hubspot_search_contacts",
            "alias": "hubspot.searchContacts",
            "args": "query?, limit?",
        },
        {
            "name": "hubspot_search_companies",
            "alias": "hubspot.searchCompanies",
            "args": "query?, limit?",
        },
        {
            "name": "hubspot_search_deals",
            "alias": "hubspot.searchDeals",
            "args": "query?, limit?",
        },
        {
            "name": "hubspot_search_crm_objects",
            "alias": "hubspot.searchCrmObjects",
            "args": "objectType, query?, limit?, properties?",
        },
        {
            "name": "hubspot_list_owners",
            "alias": "hubspot.listOwners",
            "args": "limit?, after?",
        },
        {
            "name": "hubspot_list_users",
            "alias": "hubspot.listUsers",
            "args": "limit?, after?",
        },
        {
            "name": "hubspot_read_api_resource",
            "alias": "hubspot.readApiResource",
            "args": "path, query?",
        },
    ],
    "jira": [
        {
            "name": "jira_list_assigned_issues",
            "alias": "jira.listAssignedIssues",
            "args": "limit?, status?",
        },
        {
            "name": "jira_search_issues",
            "alias": "jira.searchIssues",
            "args": "jql?, query?, limit?",
        },
        {
            "name": "jira_get_issue",
            "alias": "jira.getIssue",
            "args": "issueKey",
        },
        {
            "name": "jira_create_issue",
            "alias": "jira.createIssue",
            "args": "projectKey, issueTypeName, summary, description?",
        },
        {
            "name": "jira_add_comment",
            "alias": "jira.addComment",
            "args": "issueKey, body",
        },
    ],
    "slack": [
        {
            "name": "slack_search_users",
            "alias": "slack.searchUsers",
            "args": "query, limit?",
        },
        {
            "name": "slack_search_messages",
            "alias": "slack.searchMessages",
            "args": "query, limit?",
        },
    ],
}

DEFAULT_HERMES_PLATFORM_TOOLSETS = ["burble", "cronjob", "web"]
HERMES_STREAM_CURSOR = " ▉"
DEFAULT_HERMES_DISABLED_TOOLSETS = [
    "browser",
    "clarify",
    "code_execution",
    "computer_use",
    "context_engine",
    "delegation",
    "discord",
    "discord_admin",
    "file",
    "homeassistant",
    "image_gen",
    "memory",
    "messaging",
    "moa",
    "session_search",
    "skills",
    "spotify",
    "terminal",
    "todo",
    "tts",
    "video",
    "video_gen",
    "vision",
    "x_search",
    "yuanbao",
]


def env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def int_env(name: str, default: int) -> int:
    raw = env(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def truthy_env(name: str) -> bool:
    return env(name).lower() in {"1", "true", "yes", "on"}


def yaml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def env_list(name: str, default: list[str]) -> list[str]:
    raw = env(name)
    if not raw:
        return list(default)
    if raw.lower() in {"0", "false", "no", "none", "off"}:
        return []
    values = [value.strip() for value in raw.replace("\n", ",").split(",")]
    return list(dict.fromkeys(value for value in values if value))


def _to_non_negative_int(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def _pick_int(source: dict[str, Any], *keys: str) -> int | None:
    for key in keys:
        if key in source:
            value = _to_non_negative_int(source.get(key))
            if value is not None:
                return value
    return None


def _pick_nested_int(source: dict[str, Any], *paths: tuple[str, str]) -> int | None:
    for outer_key, inner_key in paths:
        nested = source.get(outer_key)
        if isinstance(nested, dict):
            value = _to_non_negative_int(nested.get(inner_key))
            if value is not None:
                return value
    return None


def normalize_usage(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None

    input_tokens = _pick_int(
        value,
        "inputTokens",
        "input_tokens",
        "promptTokens",
        "prompt_tokens",
    )
    output_tokens = _pick_int(
        value,
        "outputTokens",
        "output_tokens",
        "completionTokens",
        "completion_tokens",
    )
    total_tokens = _pick_int(value, "totalTokens", "total_tokens")
    cached_tokens = _pick_int(
        value,
        "cachedInputTokens",
        "cached_input_tokens",
        "cached_tokens",
        "cacheReadTokens",
        "cache_read_tokens",
    )
    if cached_tokens is None:
        cached_tokens = _pick_nested_int(
            value,
            ("inputTokenDetails", "cacheReadTokens"),
            ("inputTokenDetails", "cachedTokens"),
            ("input_token_details", "cache_read_tokens"),
            ("input_token_details", "cached_tokens"),
            ("input_tokens_details", "cache_read_tokens"),
            ("input_tokens_details", "cached_tokens"),
        )
    reasoning_tokens = _pick_int(
        value,
        "reasoningTokens",
        "reasoning_tokens",
    )
    if reasoning_tokens is None:
        reasoning_tokens = _pick_nested_int(
            value,
            ("outputTokenDetails", "reasoningTokens"),
            ("output_token_details", "reasoning_tokens"),
            ("output_tokens_details", "reasoning_tokens"),
        )

    if total_tokens is None and input_tokens is not None and output_tokens is not None:
        total_tokens = input_tokens + output_tokens

    usage: dict[str, Any] = {}
    if input_tokens is not None:
        usage["inputTokens"] = input_tokens
    if output_tokens is not None:
        usage["outputTokens"] = output_tokens
    if total_tokens is not None:
        usage["totalTokens"] = total_tokens
    if cached_tokens is not None:
        usage["cachedInputTokens"] = cached_tokens
    if reasoning_tokens is not None:
        usage["reasoningTokens"] = reasoning_tokens

    source = value.get("usageSource") or value.get("usage_source") or value.get("source")
    if isinstance(source, str) and source.strip():
        usage["usageSource"] = source.strip()

    return usage or None


def build_runtime_response(result: dict[str, Any], prompt: str = "") -> dict[str, Any]:
    text = str(result.get("text") or "")
    response: dict[str, Any] = {
        "classification": result.get("classification") or "user_private",
        "text": text,
    }
    usage = normalize_usage(result.get("usage"))
    if usage:
        response["usage"] = usage
    return response


def build_runtime_tool_bridge_modes() -> list[str]:
    modes = ["tool_gateway"]
    if env("BURBLE_MCP_GATEWAY_URL") and env("BURBLE_RUNTIME_JWT"):
        modes.append("mcp")
    return modes


def build_runtime_capability_manifest() -> dict[str, Any]:
    return {
        "runtimeType": "hermes",
        "version": "1",
        "transports": ["http", "websocket"],
        "streaming": True,
        "cancellation": False,
        "nativeScheduler": True,
        "scheduledProviderCalls": True,
        "toolCalls": True,
        "toolBridgeModes": build_runtime_tool_bridge_modes(),
        "usageReporting": "exact",
        "multimodalInput": False,
        "multimodalOutput": False,
        "memory": False,
        "durableWorkflowState": True,
        "attachments": False,
        "conversationSend": True,
        "jobScopedAuth": True,
    }


def build_hermes_turn_text(input_body: dict[str, Any]) -> str:
    text = str(input_body.get("text") or "")
    sections: list[str] = []

    context = input_body.get("context")
    recent_messages = []
    if isinstance(context, dict):
        raw_messages = context.get("recentMessages")
        if isinstance(raw_messages, list):
            recent_messages = raw_messages[-MAX_HERMES_CONTEXT_MESSAGES:]

    if recent_messages:
        lines = ["Recent Burble context (bounded, newest last):"]
        for message in recent_messages:
            if not isinstance(message, dict):
                continue
            speaker = str(message.get("speaker") or message.get("author") or "unknown")
            message_text = truncate_hermes_context_text(str(message.get("text") or ""))
            if message_text:
                lines.append(f"- {speaker}: {message_text}")
        if len(lines) > 1:
            sections.append("\n".join(lines))

    tool_groups = input_body.get("toolGroups")
    if isinstance(tool_groups, dict):
        groups = tool_groups.get("groups")
        if isinstance(groups, list):
            names = [str(group) for group in groups if str(group).strip()]
            if names:
                sections.append(f"Selected Burble tool groups: {', '.join(names)}")
                if "scheduler" in names:
                    sections.append(
                        "\n".join(
                            [
                                "Provider-backed scheduled job repair:",
                                "Before manually triggering, enabling, or rescheduling an existing native job, inspect whether it uses provider-backed state or authenticated provider resources.",
                                "Setup-time provider calls are not scheduled provider calls. If you need to create, find, read, or validate durable provider state during the current user turn, use ordinary Burble provider calls for the active conversation and do not include jobId.",
                                "Never invent placeholder job ids for setup-time provider calls. jobId is only valid after the native scheduler has returned a stable job id and scheduled_job_register_capability has returned ok for that exact id.",
                                "When creating a new provider-backed native job, do not request an immediate/manual run as part of the create call. Create it paused/disabled or without an immediate trigger if the scheduler supports that; otherwise create it, then stop before triggering.",
                                "After the native scheduler returns the stable job id, call the dedicated scheduled provider registration tool scheduled_job_register_capability with that exact jobId and requiredTools, then wait for an ok result. If registration does not return ok, do not trigger the job and report the registration failure.",
                                "If it does and its prompt lacks Burble jobId provider-call instructions, update the job first by calling the dedicated scheduled provider registration tool scheduled_job_register_capability with jobId and requiredTools, then rewrite the scheduled prompt to include the returned scheduledPromptInstruction verbatim.",
                                "Only after the job prompt has been updated with the returned scheduledPromptInstruction may you enable, manually trigger, or reschedule the job.",
                                "Scheduled provider tool calls must include the returned jobId in each Burble provider tool input. Do not use routeId as provider-call identity; routeId is only a delivery/state binding.",
                                "The job must not use direct web/browser access to provider URLs for authenticated provider work.",
                            ]
                        )
                    )
                tool_hints = selected_hermes_provider_tool_hints(names)
                if tool_hints:
                    lines = [
                        "Selected Burble provider tools:",
                        "Use Hermes tool burble_provider_call with toolName set to one of these names and input set to that tool's arguments.",
                        "For setup-time provider calls in the current user turn, do not include jobId.",
                        "For native scheduled/background jobs that will use Burble provider tools, first create the native job without an immediate/manual run, then call the dedicated scheduled provider registration tool scheduled_job_register_capability with the exact returned jobId and requiredTools, then include the returned scheduledPromptInstruction verbatim in the scheduled job prompt before enabling or triggering it.",
                    ]
                    for hint in tool_hints:
                        lines.append(
                            f"- {hint['name']} ({hint['alias']}): args {hint['args']}"
                        )
                    sections.append("\n".join(lines))

    scheduled_job_context = format_scheduled_job_context(input_body)
    if scheduled_job_context:
        sections.append(scheduled_job_context)

    sections.append(f"User request:\n{text}")
    return "\n\n".join(sections)


def format_scheduled_job_context(input_body: dict[str, Any]) -> str:
    scheduled_job = input_body.get("scheduledJob")
    if not isinstance(scheduled_job, dict):
        return ""

    allowed_tools = scheduled_job.get("allowedTools")
    if isinstance(allowed_tools, list):
        allowed_tool_text = ",".join(
            sorted({str(tool) for tool in allowed_tools if str(tool).strip()})
        )
    else:
        allowed_tool_text = ""

    visibility_policy = scheduled_job.get("visibilityPolicy")
    if not isinstance(visibility_policy, dict):
        visibility_policy = {}

    allow_declassification = (
        "true"
        if visibility_policy.get("allowPrivateToolDeclassification") is True
        else "false"
    )
    max_visibility = str(
        visibility_policy.get("maxOutputVisibility") or "user_private"
    )

    lines = [
        "Scheduled Burble job context:",
        f"- jobId={scheduled_job.get('jobId') or ''}",
        f"- capabilityProfile={scheduled_job.get('capabilityProfile') or ''}",
        f"- allowedTools={allowed_tool_text}",
    ]
    route_id = scheduled_job.get("routeId")
    if route_id:
        lines.append(f"- routeId={route_id}")
    runtime_type = scheduled_job.get("runtimeType")
    if runtime_type:
        lines.append(f"- runtimeType={runtime_type}")

    lines.append(f"- maxOutputVisibility={max_visibility}")
    lines.append(f"- allowPrivateToolDeclassification={allow_declassification}")

    state_refs = scheduled_job.get("stateRefs")
    if isinstance(state_refs, list):
        for state_ref in state_refs:
            if not isinstance(state_ref, dict):
                continue
            parts = [
                f"provider={state_ref.get('provider') or ''}",
                f"kind={state_ref.get('kind') or ''}",
            ]
            if state_ref.get("id"):
                parts.append(f"id={state_ref.get('id')}")
            if state_ref.get("name"):
                parts.append(f"name={state_ref.get('name')}")
            if state_ref.get("purpose"):
                parts.append(f"purpose={state_ref.get('purpose')}")
            lines.append(f"- stateRef {' '.join(parts)}")

    lines.append(
        "For this scheduled job, use only the listed allowedTools for Burble provider calls. Treat stateRefs as durable job state locations supplied by Burble."
    )
    lines.append(
        "Ensure this native scheduled job has the provider bridge toolset enabled: include the cronjob toolset along with any other needed toolsets such as web. Do not run provider-backed scheduled jobs with only web enabled."
    )
    lines.append(
        "Respect maxOutputVisibility when sending scheduled output. Do not publicly post private-tool-derived content unless allowPrivateToolDeclassification is true and the user explicitly asked for that behavior."
    )
    return "\n".join(lines)


def selected_hermes_provider_tool_hints(groups: list[str]) -> list[dict[str, str]]:
    hints: list[dict[str, str]] = []
    seen: set[str] = set()
    for group in groups:
        for hint in HERMES_PROVIDER_TOOL_HINTS.get(group, []):
            if hint["name"] in seen:
                continue
            seen.add(hint["name"])
            hints.append(hint)
    return hints


def truncate_hermes_context_text(text: str) -> str:
    if len(text) <= MAX_HERMES_CONTEXT_MESSAGE_CHARS:
        return text
    return f"{text[:MAX_HERMES_CONTEXT_MESSAGE_CHARS - 3]}..."


def build_hermes_thread_id(
    run_id: str,
    conversation: dict[str, Any],
    scope: str | None = None,
) -> str:
    selected_scope = (scope or env("HERMES_BURBLE_SESSION_SCOPE", "run")).strip().lower()
    if selected_scope == "conversation":
        root_id = str(conversation.get("rootId") or "")
        return root_id or run_id
    return run_id


DEFAULT_SOUL_MD = """# Burble Runtime

You are Burble's Hermes runtime.

Answer in concise Slack mrkdwn. Do not ask the user to run Hermes-native setup
commands such as /sethome or /help. Burble manages channel delivery, OAuth
connections, and runtime configuration outside Hermes.

Use Burble MCP provider tools for GitHub, Jira, Google Workspace, and Slack
facts/actions. Do not ask the user for provider URLs, API tokens, browser
sessions, or local config when a Burble MCP tool can answer the request. If a
provider tool reports that a connection is missing or expired, tell the user to
connect that provider through Burble. When a provider tool returns an error
object with a message, explain that message in normal Slack text; do not print
raw JSON.

When introducing yourself, call yourself Burble, not Hermes.
"""


class RunWaiter:
    def __init__(self) -> None:
        loop = asyncio.get_running_loop()
        self.future: asyncio.Future[dict[str, Any]] = loop.create_future()
        self.final_response: dict[str, Any] | None = None
        self.completed = False
        self.queues: list[asyncio.Queue[dict[str, Any] | None]] = []

    async def emit(self, event: dict[str, Any]) -> None:
        validate_runtime_run_event(event)
        for queue in list(self.queues):
            await queue.put(event)

    async def finish(self, response: dict[str, Any]) -> None:
        self.final_response = response
        self.completed = True
        await self.emit({"type": "final", "response": response})
        for queue in list(self.queues):
            await queue.put(None)

    async def fail(self, message: str) -> None:
        self.completed = True
        await self.emit({"type": "error", "message": message})
        for queue in list(self.queues):
            await queue.put(None)


class BurbleHermesRuntime:
    def __init__(self) -> None:
        self.port = int_env("BURBLE_HERMES_RUNTIME_PORT", 8080)
        self.platform_port = int_env("BURBLE_HERMES_PLATFORM_PORT", 8766)
        self.home = Path(env("HERMES_HOME", "/data/openclaw/hermes"))
        self.runs: dict[str, RunWaiter] = {}
        self.gateway_process: subprocess.Popen[str] | None = None

    async def start(self) -> None:
        self._install_plugin()
        self._ensure_gateway_config()
        self._start_gateway()

        app = web.Application()
        app.router.add_get("/healthz", self.handle_healthz)
        app.router.add_get("/capabilities", self.handle_capabilities)
        app.router.add_post("/runs", self.handle_run)
        app.router.add_get("/runs/{run_id}", self.handle_run_snapshot)
        app.router.add_get("/runs/{run_id}/events", self.handle_run_events)
        app.router.add_post(
            "/internal/hermes/runs/{run_id}/messages",
            self.handle_run_message,
        )
        runner = web.AppRunner(app)
        await runner.setup()
        await web.TCPSite(runner, "0.0.0.0", self.port).start()
        print(
            f"[INFO] {timestamp()} Nemo Hermes Burble runtime listening on http://localhost:{self.port}",
            flush=True,
        )

        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)
        await stop.wait()
        await runner.cleanup()
        self._stop_gateway()

    async def handle_healthz(self, _request: web.Request) -> web.Response:
        if self.gateway_process and self.gateway_process.poll() is not None:
            return web.Response(text="gateway stopped", status=503)
        return web.Response(text="ok")

    async def handle_capabilities(self, _request: web.Request) -> web.Response:
        return web.json_response(
            validate_runtime_capability_manifest(build_runtime_capability_manifest()),
            headers={"cache-control": "no-store"},
        )

    async def handle_run(self, request: web.Request) -> web.Response:
        try:
            body = validate_runtime_run_request(await request.json())
        except ContractValidationError as error:
            return web.Response(text=f"Invalid Hermes runtime run request: {error}", status=400)
        run_id = str(body.get("runId") or uuid.uuid4())
        input_body = body.get("input") or {}
        text = str(input_body.get("text") or "")
        conversation = (input_body.get("conversation") or {})
        principal = body.get("principal") or {}
        route_id = str(conversation.get("routeId") or "")
        if not route_id:
            return web.Response(text="Hermes Burble runtime requires input.conversation.routeId", status=400)
        if not text.strip():
            return web.Response(text="Hermes Burble runtime requires input.text", status=400)

        os.environ["BURBLE_HOME_CHANNEL"] = route_id
        waiter = RunWaiter()
        self.runs[run_id] = waiter
        print(
            f"[INFO] {timestamp()} Nemo Hermes run start runId={run_id} routeId={route_id} textChars={len(text)}",
            flush=True,
        )
        task = asyncio.create_task(
            self._execute_run(
                run_id,
                waiter,
                {
                    "runId": run_id,
                    "routeId": route_id,
                    "originalText": text,
                    "scheduledJob": input_body.get("scheduledJob"),
                    "text": build_hermes_turn_text(input_body),
                    "threadId": build_hermes_thread_id(run_id, conversation),
                    "actorId": principal.get("slackUserId"),
                    "actorName": principal.get("slackUserId"),
                    "slackUserId": principal.get("slackUserId"),
                    "isDirectMessage": conversation.get("isDirectMessage"),
                },
            )
        )
        if self._prefers_async(request):
            task.add_done_callback(lambda done_task: self._on_async_run_done(run_id, done_task))
            return web.json_response(
                {"runId": run_id, "eventsUrl": f"/runs/{run_id}/events"},
                headers={"cache-control": "no-store"},
            )

        try:
            result = await task
            return web.json_response(
                {"response": build_runtime_response(result, text)},
                headers={"cache-control": "no-store"},
            )
        finally:
            self.runs.pop(run_id, None)

    async def handle_run_snapshot(self, request: web.Request) -> web.Response:
        run_id = request.match_info["run_id"]
        waiter = self.runs.get(run_id)
        if not waiter:
            return web.Response(text="Run not found", status=404)
        if not waiter.completed:
            try:
                await asyncio.wait_for(
                    asyncio.shield(waiter.future),
                    timeout=int_env("HERMES_RUN_TIMEOUT_SECONDS", 180),
                )
            except asyncio.TimeoutError:
                await waiter.fail("Hermes did not produce a response before the run timeout.")
                return web.Response(text="Run timed out", status=504)
        if not waiter.final_response:
            return web.Response(text="Run did not produce a final response", status=500)
        return web.json_response(
            {"response": waiter.final_response},
            headers={"cache-control": "no-store"},
        )

    async def handle_run_events(self, request: web.Request) -> web.StreamResponse:
        run_id = request.match_info["run_id"]
        waiter = self.runs.get(run_id)
        if not waiter:
            return web.Response(text="Run not found", status=404)

        ws = web.WebSocketResponse()
        await ws.prepare(request)
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        waiter.queues.append(queue)
        print(
            f"[INFO] {timestamp()} Nemo Hermes run events attached runId={run_id}",
            flush=True,
        )
        try:
            if waiter.final_response:
                await ws.send_json({"type": "final", "response": waiter.final_response})
                return ws
            while True:
                event = await queue.get()
                if event is None:
                    break
                await ws.send_json(event)
        finally:
            if queue in waiter.queues:
                waiter.queues.remove(queue)
            await ws.close()
            print(
                f"[INFO] {timestamp()} Nemo Hermes run events closed runId={run_id}",
                flush=True,
            )
        return ws

    async def handle_run_message(self, request: web.Request) -> web.Response:
        run_id = request.match_info["run_id"]
        waiter = self.runs.get(run_id)
        if not waiter:
            return web.json_response({"error": "run not found"}, status=404)
        body = await request.json()
        text = str(body.get("text") or "")
        print(
            f"[INFO] {timestamp()} Nemo Hermes run callback runId={run_id} textChars={len(text)}",
            flush=True,
        )
        event_type = str(body.get("type") or "")
        if event_type in {"message_delta", "message_replace"}:
            if "text" not in body:
                return web.Response(text=f"Hermes runtime event {event_type} requires text", status=400)
            if text:
                await waiter.emit({"type": event_type, "text": text})
            return web.json_response({"ok": True})
        if not waiter.future.done():
            waiter.future.set_result(body)
        return web.json_response({"ok": True})

    async def _execute_run(
        self,
        run_id: str,
        waiter: RunWaiter,
        message: dict[str, Any],
    ) -> dict[str, Any]:
        progress_task: asyncio.Task[None] | None = None
        try:
            if truthy_env("BURBLE_RUNTIME_CONTRACT_PROBE"):
                if message.get("scheduledJob"):
                    await waiter.emit({"type": "status", "text": "Runtime contract probe accepted."})
                    await waiter.emit({
                        "type": "tool_call",
                        "toolName": "scheduledJob.registerCapability",
                        "callId": "contract-scheduled-provider-probe",
                    })
                    await waiter.emit({
                        "type": "tool_result",
                        "toolName": "scheduledJob.registerCapability",
                        "callId": "contract-scheduled-provider-probe",
                        "classification": "user_private",
                    })
                    response = {
                        "classification": "user_private",
                        "text": "Runtime contract scheduled provider capability response.",
                        "usage": {
                            "inputTokens": 1,
                            "outputTokens": 1,
                            "totalTokens": 2,
                            "usageSource": "contract-probe",
                        },
                    }
                    await waiter.emit({"type": "message_delta", "text": response["text"]})
                    await waiter.finish(response)
                    return response
                if (
                    message.get("originalText") == "runtime contract tool capability probe"
                    or message.get("text") == "runtime contract tool capability probe"
                ):
                    await waiter.emit({"type": "status", "text": "Runtime contract probe accepted."})
                    await waiter.emit({
                        "type": "tool_call",
                        "toolName": "runtime.conformance.echo",
                        "callId": "contract-tool-probe",
                    })
                    await waiter.emit({
                        "type": "tool_result",
                        "toolName": "runtime.conformance.echo",
                        "callId": "contract-tool-probe",
                        "classification": "user_private",
                    })
                    response = {
                        "classification": "user_private",
                        "text": "Runtime contract tool capability response.",
                        "usage": {
                            "inputTokens": 1,
                            "outputTokens": 1,
                            "totalTokens": 2,
                            "usageSource": "contract-probe",
                        },
                    }
                    await waiter.emit({"type": "message_delta", "text": response["text"]})
                    await waiter.finish(response)
                    return response
                response = {
                    "classification": "user_private",
                    "text": "Runtime contract probe response.",
                    "usage": {
                        "inputTokens": 1,
                        "outputTokens": 1,
                        "totalTokens": 2,
                        "usageSource": "contract-probe",
                    },
                }
                await waiter.emit({"type": "status", "text": "Runtime contract probe accepted."})
                await waiter.emit({"type": "message_delta", "text": response["text"]})
                await waiter.finish(response)
                return response

            await waiter.emit({"type": "status", "text": "Burble accepted the turn."})
            progress_task = asyncio.create_task(
                self._emit_progress_until_finished(run_id, waiter)
            )
            print(
                f"[INFO] {timestamp()} Nemo Hermes run inject start runId={run_id}",
                flush=True,
            )
            await self._inject_message(message)
            print(
                f"[INFO] {timestamp()} Nemo Hermes run inject finish runId={run_id}",
                flush=True,
            )
            result = await asyncio.wait_for(
                waiter.future,
                timeout=int_env("HERMES_RUN_TIMEOUT_SECONDS", 180),
            )
            response = build_runtime_response(result, str(message.get("text") or ""))
            await waiter.finish(response)
            print(
                f"[INFO] {timestamp()} Nemo Hermes run finish runId={run_id} textChars={len(response['text'])}",
                flush=True,
            )
            return response
        except asyncio.TimeoutError:
            message_text = "Hermes did not produce a response before the run timeout."
            print(
                f"[ERROR] {timestamp()} Nemo Hermes run timeout runId={run_id}",
                file=sys.stderr,
                flush=True,
            )
            await waiter.fail(message_text)
            raise
        except Exception as error:
            print(
                f"[ERROR] {timestamp()} Nemo Hermes run failed runId={run_id} error={error}",
                file=sys.stderr,
                flush=True,
            )
            await waiter.fail(str(error))
            raise
        finally:
            if progress_task:
                progress_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await progress_task

    async def _emit_progress_until_finished(
        self,
        run_id: str,
        waiter: RunWaiter,
    ) -> None:
        interval_seconds = max(1, int_env("HERMES_PROGRESS_INTERVAL_SECONDS", 8))
        started_at = time.time()
        try:
            while not waiter.completed and not waiter.future.done():
                await asyncio.sleep(interval_seconds)
                if waiter.completed or waiter.future.done():
                    return
                elapsed_seconds = int(time.time() - started_at)
                await waiter.emit({
                    "type": "status",
                    "text": f"Agent has thought for {elapsed_seconds}s..."
                })
        except asyncio.CancelledError:
            raise
        except Exception as error:
            print(
                f"[WARN] {timestamp()} Nemo Hermes progress emitter failed runId={run_id} error={error}",
                file=sys.stderr,
                flush=True,
            )

    def _on_async_run_done(self, run_id: str, done_task: asyncio.Task[dict[str, Any]]) -> None:
        try:
            done_task.result()
        except Exception:
            pass
        asyncio.create_task(self._expire_run_later(run_id))

    async def _expire_run_later(self, run_id: str) -> None:
        await asyncio.sleep(int_env("HERMES_COMPLETED_RUN_TTL_SECONDS", 300))
        self.runs.pop(run_id, None)

    async def _inject_message(self, body: dict[str, Any]) -> None:
        url = f"http://127.0.0.1:{self.platform_port}/internal/burble/messages"
        last_error = ""
        for _attempt in range(60):
            try:
                async with ClientSession(timeout=ClientTimeout(total=5)) as session:
                    async with session.post(url, json=body) as response:
                        if response.status < 400:
                            return
                        last_error = await response.text()
            except Exception as error:
                last_error = str(error)
            await asyncio.sleep(0.5)
        raise RuntimeError(f"Hermes Burble platform did not accept message: {last_error}")

    def _prefers_async(self, request: web.Request) -> bool:
        return any(
            value.strip().lower() == "respond-async"
            for value in request.headers.get("prefer", "").split(",")
        )

    def _install_plugin(self) -> None:
        plugins_dir = self.home / "plugins"
        plugins_dir.mkdir(parents=True, exist_ok=True)
        for source_dir in HERMES_PLUGIN_SOURCE.iterdir():
            if not source_dir.is_dir():
                continue
            target_dir = plugins_dir / source_dir.name
            if target_dir.exists():
                shutil.rmtree(target_dir)
            shutil.copytree(source_dir, target_dir)

    def _ensure_gateway_config(self) -> None:
        config_path = self.home / "config.yaml"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        soul_path = self.home / "SOUL.md"
        soul_path.write_text(DEFAULT_SOUL_MD, encoding="utf-8")
        lines = []
        model_config = self._resolve_model_config()
        if model_config:
            print(
                f"[INFO] {timestamp()} Nemo Hermes model config provider={model_config['provider']} model={model_config['model']}",
                flush=True,
            )
            lines.extend(
                [
                    "model:",
                    f"  provider: {yaml_string(model_config['provider'])}",
                    f"  default: {yaml_string(model_config['model'])}",
                ]
            )
        web_config = self._resolve_web_config()
        if web_config:
            lines.append("web:")
            for key, value in web_config.items():
                lines.append(f"  {key}: {yaml_string(value)}")
        browser_config = self._resolve_browser_config()
        if browser_config:
            lines.append("browser:")
            for key, value in browser_config.items():
                lines.append(f"  {key}: {yaml_string(value)}")
        native_memory_enabled = truthy_env("BURBLE_HERMES_NATIVE_MEMORY")
        lines.extend(
            [
                "memory:",
                f"  memory_enabled: {str(native_memory_enabled).lower()}",
                f"  user_profile_enabled: {str(native_memory_enabled).lower()}",
                "streaming:",
                "  enabled: true",
                "  transport: edit",
                f"  cursor: {yaml_string(HERMES_STREAM_CURSOR)}",
            ]
        )
        disabled_toolsets = env_list(
            "BURBLE_HERMES_DISABLED_TOOLSETS",
            DEFAULT_HERMES_DISABLED_TOOLSETS,
        )
        if native_memory_enabled:
            disabled_toolsets = [
                toolset for toolset in disabled_toolsets if toolset != "memory"
            ]
        if disabled_toolsets:
            lines.append("agent:")
            lines.append("  disabled_toolsets:")
            for toolset in disabled_toolsets:
                lines.append(f"    - {toolset}")
        platform_toolsets = env_list(
            "BURBLE_HERMES_PLATFORM_TOOLSETS",
            DEFAULT_HERMES_PLATFORM_TOOLSETS,
        )
        lines.append("platform_toolsets:")
        lines.append("  burble:")
        for toolset in platform_toolsets:
            lines.append(f"    - {toolset}")
        lines.extend(
            [
                "plugins:",
                "  enabled:",
                "    - burble-platform",
                "    - burble-web-extract",
                "    - burble-provider-tool",
            ]
        )
        if (
            truthy_env("BURBLE_HERMES_ENABLE_MCP_CATALOG")
            and env("BURBLE_MCP_GATEWAY_URL")
            and env("BURBLE_RUNTIME_JWT")
        ):
            lines.extend(
                [
                    "mcp_servers:",
                    "  burble:",
                    "    url: ${BURBLE_MCP_GATEWAY_URL}",
                    "    headers:",
                    "      Authorization: Bearer ${BURBLE_RUNTIME_JWT}",
                    "    timeout: 120",
                    "    connect_timeout: 30",
                    "    supports_parallel_tool_calls: true",
                ]
            )
        config_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def _resolve_web_config(self) -> dict[str, str]:
        config: dict[str, str] = {}
        mappings = {
            "HERMES_WEB_BACKEND": "backend",
            "HERMES_WEB_SEARCH_BACKEND": "search_backend",
            "HERMES_WEB_EXTRACT_BACKEND": "extract_backend",
        }
        for env_key, config_key in mappings.items():
            value = env(env_key)
            if value:
                config[config_key] = value
        return config

    def _resolve_browser_config(self) -> dict[str, str]:
        config: dict[str, str] = {}
        engine = env("HERMES_BROWSER_ENGINE") or env("AGENT_BROWSER_ENGINE")
        cloud_provider = env("HERMES_BROWSER_CLOUD_PROVIDER")
        cdp_url = env("BROWSER_CDP_URL")
        if engine:
            config["engine"] = engine
        if cloud_provider:
            config["cloud_provider"] = cloud_provider
        if cdp_url:
            config["cdp_url"] = cdp_url
        return config

    def _resolve_model_config(self) -> dict[str, str] | None:
        raw = env("AI_MODEL") or env("HERMES_INFERENCE_MODEL") or env("HERMES_MODEL")
        if not raw:
            return None
        provider = env("HERMES_INFERENCE_PROVIDER")
        model = raw
        if ":" in raw:
            maybe_provider, maybe_model = raw.split(":", 1)
            if maybe_provider and maybe_model:
                provider = provider or maybe_provider
                model = maybe_model
        elif "/" in raw:
            maybe_provider, maybe_model = raw.split("/", 1)
            if maybe_provider and maybe_model:
                provider = provider or maybe_provider
                model = maybe_model
        provider = self._normalize_provider(provider or "openai")
        return {"provider": provider, "model": model}

    def _normalize_provider(self, provider: str) -> str:
        normalized = provider.strip().lower()
        if normalized in {"openai", "openai-api"}:
            return "openai-api"
        if normalized in {"google", "google-ai-studio"}:
            return "gemini"
        return normalized

    def _start_gateway(self) -> None:
        self.home.mkdir(parents=True, exist_ok=True)
        runtime_env = os.environ.copy()
        runtime_env["HOME"] = str(self.home)
        runtime_env.setdefault("BURBLE_HERMES_RUNTIME_CALLBACK_URL", "http://127.0.0.1:8080/internal/hermes/runs")
        runtime_env.setdefault("BURBLE_HERMES_PLATFORM_HOST", "127.0.0.1")
        runtime_env.setdefault("BURBLE_HERMES_PLATFORM_PORT", str(self.platform_port))
        runtime_env.setdefault("BURBLE_ALLOW_ALL_USERS", "true")
        runtime_env.setdefault("GATEWAY_ALLOW_ALL_USERS", "true")

        command = env("HERMES_GATEWAY_COMMAND", "hermes gateway run")
        self.gateway_process = subprocess.Popen(
            shlex.split(command),
            cwd=str(self.home),
            env=runtime_env,
            text=True,
        )
        print(
            f"[INFO] {timestamp()} Nemo Hermes gateway started pid={self.gateway_process.pid}",
            flush=True,
        )

    def _stop_gateway(self) -> None:
        if not self.gateway_process or self.gateway_process.poll() is not None:
            return
        self.gateway_process.terminate()
        try:
            self.gateway_process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.gateway_process.kill()


def timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


if __name__ == "__main__":
    try:
        asyncio.run(BurbleHermesRuntime().start())
    except KeyboardInterrupt:
        pass
    except Exception as error:
        print(f"[ERROR] {timestamp()} Nemo Hermes runtime failed: {error}", file=sys.stderr, flush=True)
        raise
