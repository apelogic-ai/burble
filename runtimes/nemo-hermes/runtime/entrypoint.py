from __future__ import annotations

import asyncio
import contextlib
import importlib.util
import json
import os
import re
import shutil
import shlex
import signal
import subprocess
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from aiohttp import ClientSession, ClientTimeout, web

from burble_runtime_contract import (
    ContractValidationError,
    validate_runtime_capability_manifest,
    validate_runtime_run_event,
    validate_runtime_run_request,
)


HERMES_PLUGIN_SOURCE = Path("/runtime/hermes-plugins")
HERMES_PROVIDER_TOOL_PLUGIN_PATHS = [
    HERMES_PLUGIN_SOURCE / "burble-provider-tool" / "__init__.py",
    Path(__file__).resolve().parent.parent
    / "hermes-plugins"
    / "burble-provider-tool"
    / "__init__.py",
]
MAX_HERMES_CONTEXT_MESSAGES = 12
MAX_HERMES_CONTEXT_MESSAGE_CHARS = 300
MAX_HERMES_ATTACHMENT_NAME_CHARS = 120
HERMES_PROVIDER_TOOL_HINTS_PATH = Path(__file__).with_name("provider-tool-hints.json")


def load_hermes_provider_tool_hints(path: Path) -> dict[str, list[dict[str, Any]]]:
    if not path.exists():
        raise ValueError(f"Missing provider tool hints: {path}")
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    providers = payload.get("providers") if isinstance(payload, dict) else None
    if not isinstance(providers, list):
        raise ValueError(f"Invalid provider tool hints: {path}")
    hints_by_provider: dict[str, list[dict[str, Any]]] = {}
    for provider_payload in providers:
        if not isinstance(provider_payload, dict):
            raise ValueError(f"Invalid provider tool hint provider entry: {path}")
        provider = provider_payload.get("provider")
        tools = provider_payload.get("tools")
        if not isinstance(provider, str) or not isinstance(tools, list):
            raise ValueError(f"Invalid provider tool hint provider shape: {path}")
        hints: list[dict[str, Any]] = []
        for tool in tools:
            if not isinstance(tool, dict):
                raise ValueError(f"Invalid provider tool hint entry: {path}")
            name = tool.get("name")
            alias = tool.get("alias")
            description = tool.get("description")
            input_schema = tool.get("input")
            if (
                not isinstance(name, str)
                or not isinstance(alias, str)
                or not isinstance(description, str)
                or not isinstance(input_schema, dict)
            ):
                raise ValueError(f"Invalid provider tool hint shape: {path}")
            hints.append(
                {
                    "name": name,
                    "alias": alias,
                    "description": description,
                    "input": input_schema,
                }
            )
        hints_by_provider[provider] = hints
    return hints_by_provider


HERMES_PROVIDER_TOOL_HINTS = load_hermes_provider_tool_hints(
    HERMES_PROVIDER_TOOL_HINTS_PATH
)

HERMES_PROVIDER_PROGRESS_RE = re.compile(
    r"^(?::gear:|⚙️?|gear:)?\s*(?P<tool>burble_provider_call|(?:github|google|gmail|hubspot|jira|slack|atlassian|scheduled_job|conversation)_[a-z0-9_]+)(?:\.{3}|…)?$",
    re.IGNORECASE,
)
DEFAULT_HERMES_PLATFORM_TOOLSETS = ["burble", "cronjob", "web"]
REQUIRED_HERMES_SCHEDULED_PLATFORM_TOOLSETS = ["burble"]
HERMES_STREAM_CURSOR = "[[BURBLE_STREAM_CURSOR]]"
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


def bool_env(name: str, default: bool = False) -> bool:
    raw = env(name)
    if not raw:
        return default
    normalized = raw.lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


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


def append_required_hermes_scheduled_toolsets(toolsets: list[str]) -> list[str]:
    merged = list(dict.fromkeys(toolsets))
    for toolset in REQUIRED_HERMES_SCHEDULED_PLATFORM_TOOLSETS:
        if toolset not in merged:
            merged.append(toolset)
    return merged


def current_utc_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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
    if hermes_mcp_catalog_enabled():
        modes.append("mcp")
    return modes


def hermes_mcp_catalog_enabled() -> bool:
    return (
        bool_env("BURBLE_HERMES_ENABLE_MCP_CATALOG", False)
        and bool(env("BURBLE_MCP_GATEWAY_URL"))
        and bool(env("BURBLE_RUNTIME_JWT"))
    )


def build_runtime_capability_manifest() -> dict[str, Any]:
    return {
        "runtimeType": "hermes",
        "version": "1",
        "transports": ["http", "sse", "ndjson", "websocket"],
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
        "attachments": True,
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

    attachment_context = format_current_request_attachments(input_body)
    if attachment_context:
        sections.append(attachment_context)

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
                                'If the user explicitly asks public scheduled output to post to a granted Slack channel, pass destination with the channel mention/name/id to scheduled_job_register_capability and include visibilityPolicy {"maxOutputVisibility":"public"}. Slack channel labels are not route ids and must not be used as native delivery targets.',
                                "After scheduled_job_register_capability returns ok for a Slack channel destination, use the Burble platform delivery target burble:<returned routeId> for the native job. Never use slack:<channelId> or a raw Slack channel id/name for Burble scheduled channel output.",
                                "If the scheduled job reads from authenticated Burble provider sources such as GitHub, Google Drive, Jira, Slack search, HubSpot, or Atlassian MCP, do not register a Slack channel destination. Report that public channel delivery for private-tool output requires an explicit declassification approval flow that is not implemented yet.",
                                "If the scheduled job only reads public/open-internet sources, channel delivery may include write-only provider state tools such as google.updateDriveTextFile or google.appendToDriveTextFile in requiredTools.",
                                "If it does and its prompt lacks Burble jobId provider-call instructions, update the job first by calling the dedicated scheduled provider registration tool scheduled_job_register_capability with jobId and requiredTools, then rewrite the scheduled prompt to include the returned scheduledPromptInstruction verbatim.",
                                "Only after the job prompt has been updated with the returned scheduledPromptInstruction may you enable, manually trigger, or reschedule the job.",
                                "Scheduled provider tool calls must include the returned jobId in each Burble provider tool input. Do not use routeId as provider-call identity; routeId is only a delivery/state binding.",
                                "The job must not use direct web/browser access to provider URLs for authenticated provider work.",
                            ]
                        )
                    )
                tool_hints = selected_hermes_provider_tool_hints(names)
                if tool_hints:
                    lines = ["Selected Burble provider tools:"]
                    if hermes_mcp_catalog_enabled():
                        lines.extend(
                            [
                                "Use direct Burble MCP provider tools with the listed underscored tool names when they are available in this Hermes session.",
                                "Do not wrap a direct MCP provider call in burble_provider_call. Use burble_provider_call only if Hermes does not expose the listed direct tool.",
                                "In that fallback, set toolName to the dotted alias in parentheses and input to that tool's arguments.",
                            ]
                        )
                    else:
                        lines.append(
                            "Use Hermes tool burble_provider_call with toolName set to one of these names and input set to that tool's arguments."
                        )
                    lines.extend(
                        [
                            "Do not write `burble_provider_call`, `:gear: burble_provider_call...`, or any other tool-progress marker as chat text. Invoke the provider tool, wait for its JSON result, then write a final Slack-ready answer from that result.",
                            "If a provider tool returns an error object, explain the error in normal Slack text instead of stopping on a tool-progress marker.",
                            "Do not call provider tools that are not listed here for this turn. If the needed provider is not listed, say it is unavailable in this turn instead of discovering or calling unrelated provider tools.",
                            "For setup-time provider calls in the current user turn, do not include jobId.",
                            "For native scheduled/background jobs that will use Burble provider tools, first create the native job without an immediate/manual run, then call the dedicated scheduled provider registration tool scheduled_job_register_capability with the exact returned jobId and requiredTools, then include the returned scheduledPromptInstruction verbatim in the scheduled job prompt before enabling or triggering it.",
                        ]
                    )
                    for hint in tool_hints:
                        lines.append(format_hermes_provider_tool_hint(hint))
                    sections.append("\n".join(lines))

    scheduled_job_context = format_scheduled_job_context(input_body)
    if scheduled_job_context:
        sections.append(scheduled_job_context)

    sections.append(f"User request:\n{text}")
    return "\n\n".join(sections)


def reachable_manifest_tools(message: dict[str, Any]) -> list[dict[str, Any]]:
    runtime = message.get("runtime")
    if not isinstance(runtime, dict):
        return []
    manifest = runtime.get("manifest")
    if not isinstance(manifest, dict):
        return []
    tools = manifest.get("tools")
    if not isinstance(tools, list):
        return []
    reachable: list[dict[str, str]] = []
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        if tool.get("enabled") is not True:
            continue
        name = str(tool.get("name") or "")
        alias = str(tool.get("alias") or "")
        provider = str(tool.get("provider") or "")
        if not alias or not name or not provider:
            continue
        hint = hermes_provider_tool_hint(provider, name, alias)
        normalized = normalize_burble_provider_tool_name(name)
        if normalized != alias:
            raise ValueError(
                f"Hermes provider bridge normalized {name} to {normalized}, expected {alias}"
            )
        reachable.append({
            "name": hint["name"],
            "alias": hint["alias"],
            "input": tool.get("input") if isinstance(tool.get("input"), list) else [],
        })
    return reachable


def hermes_provider_tool_hint(
    provider: str,
    name: str,
    alias: str,
) -> dict[str, Any]:
    for hint in HERMES_PROVIDER_TOOL_HINTS.get(provider, []):
        if hint.get("name") == name and hint.get("alias") == alias:
            return hint
    raise ValueError(f"Hermes provider hints do not include {provider}:{name} ({alias})")


_BURBLE_PROVIDER_TOOL_PLUGIN: Any | None = None


def load_burble_provider_tool_plugin() -> Any:
    global _BURBLE_PROVIDER_TOOL_PLUGIN
    if _BURBLE_PROVIDER_TOOL_PLUGIN is None:
        for path in HERMES_PROVIDER_TOOL_PLUGIN_PATHS:
            if not path.exists():
                continue
            spec = importlib.util.spec_from_file_location(
                "burble_provider_tool_contract_probe",
                path,
            )
            if spec is None or spec.loader is None:
                continue
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            _BURBLE_PROVIDER_TOOL_PLUGIN = module
            break
    if _BURBLE_PROVIDER_TOOL_PLUGIN is None:
        raise ValueError("Hermes provider bridge plugin is not available")
    return _BURBLE_PROVIDER_TOOL_PLUGIN


def normalize_burble_provider_tool_name(name: str) -> str:
    module = load_burble_provider_tool_plugin()
    return str(module.normalize_burble_tool_name(name))


def provider_tool_hint_by_name(name: str) -> dict[str, Any] | None:
    for hints in HERMES_PROVIDER_TOOL_HINTS.values():
        for hint in hints:
            if hint.get("name") == name:
                return hint
    return None


def canonical_hermes_provider_tool_name(name: str) -> str:
    cleaned = str(name or "").strip()
    if not cleaned:
        return cleaned
    if provider_tool_hint_by_name(cleaned):
        return cleaned
    for hints in HERMES_PROVIDER_TOOL_HINTS.values():
        for hint in hints:
            if hint.get("alias") == cleaned:
                return str(hint["name"])
    with contextlib.suppress(Exception):
        normalized = normalize_burble_provider_tool_name(cleaned)
        for hints in HERMES_PROVIDER_TOOL_HINTS.values():
            for hint in hints:
                if hint.get("alias") == normalized:
                    return str(hint["name"])
    return cleaned


def hermes_tool_event_name(body: dict[str, Any]) -> str:
    for source in (
        body,
        body.get("toolCall") if isinstance(body.get("toolCall"), dict) else {},
        body.get("tool") if isinstance(body.get("tool"), dict) else {},
    ):
        if not isinstance(source, dict):
            continue
        for key in ("toolName", "tool_name", "name", "tool"):
            value = source.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return ""


def hermes_tool_event_call_id(body: dict[str, Any], tool_name: str) -> str:
    for source in (
        body,
        body.get("toolCall") if isinstance(body.get("toolCall"), dict) else {},
        body.get("tool") if isinstance(body.get("tool"), dict) else {},
    ):
        if not isinstance(source, dict):
            continue
        for key in ("callId", "call_id", "id", "toolCallId", "tool_call_id"):
            value = source.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return f"hermes-tool-call-{tool_name or 'unknown'}-{uuid.uuid4()}"


def hermes_tool_event_input(body: dict[str, Any]) -> dict[str, Any] | None:
    for source in (
        body,
        body.get("toolCall") if isinstance(body.get("toolCall"), dict) else {},
        body.get("tool") if isinstance(body.get("tool"), dict) else {},
    ):
        if not isinstance(source, dict):
            continue
        for key in ("input", "arguments", "args"):
            value = source.get(key)
            if isinstance(value, dict):
                return value
            if isinstance(value, str) and value.strip():
                with contextlib.suppress(Exception):
                    parsed = json.loads(value)
                    if isinstance(parsed, dict):
                        return parsed
    return None


def unwrap_hermes_provider_tool_call(
    tool_name: str,
    tool_input: dict[str, Any] | None,
) -> tuple[str, dict[str, Any] | None]:
    if tool_name not in {"burble_provider_call", "burble.providerCall"}:
        return tool_name, tool_input
    if not isinstance(tool_input, dict):
        return tool_name, tool_input
    inner_tool_name = tool_input.get("toolName") or tool_input.get("tool_name")
    if not isinstance(inner_tool_name, str) or not inner_tool_name.strip():
        return tool_name, tool_input
    inner_input = tool_input.get("input")
    return (
        canonical_hermes_provider_tool_name(inner_tool_name),
        inner_input if isinstance(inner_input, dict) else {},
    )


def extract_hermes_provider_progress_tool(text: str) -> str | None:
    normalized = " ".join(text.strip().split())
    match = HERMES_PROVIDER_PROGRESS_RE.match(normalized)
    if not match:
        return None
    return str(match.group("tool")).lower()


def extract_hermes_calling_provider_tool(text: str) -> str | None:
    normalized = " ".join(text.strip().split())
    match = re.match(r"^Calling\s+(.+?)(?:\.{3}|…)?$", normalized, re.IGNORECASE)
    if not match:
        return None
    display_name = match.group(1).strip().lower()
    for hints in HERMES_PROVIDER_TOOL_HINTS.values():
        for hint in hints:
            name = str(hint.get("name") or "").strip()
            if not name:
                continue
            if display_name == name.replace("_", " ").lower():
                return name
    return None


def is_hermes_provider_fallback_final(text: str) -> bool:
    normalized = " ".join(text.lower().split())
    return (
        "burble here" in normalized
        and "/help shows commands" in normalized
    ) or (
        "i can help" in normalized
        and "short profile" in normalized
        and "more useful" in normalized
    ) or (
        "could not handle that message" in normalized
    )


def is_hermes_provider_tool_read_safe(tool_name: str) -> bool:
    unsafe_terms = (
        "_add_",
        "_append_",
        "_close_",
        "_comment_",
        "_create_",
        "_delete_",
        "_edit_",
        "_fill_",
        "_link_",
        "_move_",
        "_reopen_",
        "_request_",
        "_transition_",
        "_update_",
    )
    return not any(term in tool_name for term in unsafe_terms)


def derive_hermes_provider_marker_input(
    tool_name: str,
    original_text: str,
) -> dict[str, Any] | None:
    text = " ".join(original_text.lower().split())
    if not is_hermes_provider_tool_read_safe(tool_name):
        return None

    if tool_name in {
        "github_get_authenticated_user",
        "github_list_assigned_issues",
        "jira_get_authenticated_user",
        "jira_list_accessible_resources",
        "jira_list_assigned_issues",
        "hubspot_get_authenticated_user",
        "google_get_authenticated_user",
    }:
        return {}

    if tool_name == "google_search_drive_files":
        return {"limit": 1 if any(word in text for word in ("last", "latest", "recent")) else 10}

    if tool_name == "hubspot_search_crm_objects":
        object_type = infer_hubspot_object_type(text)
        if not object_type:
            return None
        return {
            "objectType": object_type,
            "limit": 10,
            **hubspot_default_properties(object_type),
        }

    if tool_name in {"hubspot_list_owners", "hubspot_list_users"}:
        return {"limit": 10}

    if tool_name in {
        "google_search_calendar_events",
        "google_search_mail_messages",
        "google_slides_search_presentations",
    }:
        return {"limit": 10}

    if tool_name == "github_list_my_pull_requests":
        return {"state": "open", "sort": "updated", "order": "desc", "limit": 10}

    if tool_name == "jira_list_visible_projects":
        return {}

    return None


def infer_safe_hermes_provider_tool_from_text(original_text: str) -> str | None:
    text = " ".join(original_text.lower().split())
    if "hubspot" in text:
        if infer_hubspot_object_type(text):
            return "hubspot_search_crm_objects"
        if any(word in text for word in ("owner", "owners")):
            return "hubspot_list_owners"
        if any(word in text for word in ("user", "users")):
            return "hubspot_list_users"
    if "jira" in text:
        if any(word in text for word in ("ticket", "tickets", "issue", "issues", "assigned", "open")):
            return "jira_list_assigned_issues"
        if "project" in text or "projects" in text:
            return "jira_list_visible_projects"
    if "github" in text:
        if any(word in text for word in ("issue", "issues", "assigned")):
            return "github_list_assigned_issues"
        if any(word in text for word in ("pull request", "pull requests", "prs", "pr ")):
            return "github_list_my_pull_requests"
    if "drive" in text or "google drive" in text:
        if any(word in text for word in ("file", "files", "edited", "modified", "last", "latest", "recent")):
            return "google_search_drive_files"
    if "calendar" in text:
        return "google_search_calendar_events"
    if any(word in text for word in ("gmail", "mail", "email")):
        return "google_search_mail_messages"
    return None


def infer_hubspot_object_type(text: str) -> str | None:
    if any(word in text for word in ("company", "companies", "client", "clients", "account", "accounts")):
        return "companies"
    if "contact" in text or "contacts" in text:
        return "contacts"
    if "deal" in text or "deals" in text:
        return "deals"
    if any(word in text for word in ("user", "users", "owner", "owners")):
        return "users"
    return None


def hubspot_default_properties(object_type: str) -> dict[str, Any]:
    properties_by_type = {
        "companies": ["name", "domain", "createdate", "hs_lastmodifieddate"],
        "contacts": ["firstname", "lastname", "email", "createdate", "lastmodifieddate"],
        "deals": ["dealname", "amount", "dealstage", "createdate", "hs_lastmodifieddate"],
        "users": ["hs_name", "hs_email", "createdate", "hs_lastmodifieddate"],
    }
    properties = properties_by_type.get(object_type)
    return {"properties": properties} if properties else {}


async def call_burble_provider_tool(tool_name: str, tool_input: dict[str, Any]) -> Any:
    module = load_burble_provider_tool_plugin()
    raw_result = await module._burble_provider_call(
        {"toolName": normalize_burble_provider_tool_name(tool_name), "input": tool_input}
    )
    try:
        return json.loads(raw_result)
    except Exception:
        return raw_result


def normalize_provider_content(content: Any) -> Any:
    if isinstance(content, dict):
        for key in (
            "items",
            "results",
            "files",
            "issues",
            "companies",
            "contacts",
            "deals",
            "users",
            "owners",
            "data",
        ):
            value = content.get(key)
            if isinstance(value, list):
                return value
    return content


def format_hermes_provider_recovery_text(
    tool_name: str,
    tool_input: dict[str, Any],
    content: Any,
) -> str:
    if isinstance(content, dict) and content.get("error"):
        message = content.get("message") or content.get("error")
        return f"Provider tool failed: {message}"

    records = normalize_provider_content(content)
    if tool_name == "google_search_drive_files":
        if isinstance(records, list) and records:
            file = records[0]
            if isinstance(file, dict):
                name = first_string(file, "name", "title", "filename") or "unnamed file"
                modified = first_string(
                    file,
                    "modifiedTime",
                    "modified_time",
                    "modified",
                    "updatedAt",
                    "updated_at",
                )
                lines = [f"Last edited Google Drive file: {name}"]
                if modified:
                    lines.append(f"modified: {modified}")
                return "\n".join(lines)
        return "No Google Drive files matched."

    if tool_name == "hubspot_search_crm_objects":
        object_type = str(tool_input.get("objectType") or "objects")
        if isinstance(records, list) and records:
            title = f"Latest HubSpot {object_type.replace('_', ' ')}"
            return "\n".join([title, *[f"- {format_hubspot_record(record)}" for record in records[:10]]])
        return f"No HubSpot {object_type.replace('_', ' ')} matched."

    if tool_name == "github_list_assigned_issues":
        return format_generic_record_list("Assigned GitHub issues", records)

    if tool_name == "jira_list_assigned_issues":
        return format_generic_record_list("Your open Jira tickets", records)

    return format_generic_record_list(provider_tool_title(tool_name), records)


def provider_tool_title(tool_name: str) -> str:
    hint = provider_tool_hint_by_name(tool_name)
    if hint and isinstance(hint.get("description"), str):
        description = str(hint["description"]).rstrip(".")
        if description:
            return description
    return tool_name.replace("_", " ").title()


def format_generic_record_list(title: str, records: Any) -> str:
    if isinstance(records, list):
        if not records:
            return f"{title}: none found."
        return "\n".join([title, *[f"- {format_record(record)}" for record in records[:10]]])
    if isinstance(records, dict):
        return "\n".join([title, json.dumps(records, ensure_ascii=False, indent=2)])
    return f"{title}: {records}"


def format_hubspot_record(record: Any) -> str:
    if not isinstance(record, dict):
        return str(record)
    props = record.get("properties") if isinstance(record.get("properties"), dict) else {}
    name = (
        first_string(props, "name", "dealname", "hs_name")
        or " ".join(
            part
            for part in [
                first_string(props, "firstname"),
                first_string(props, "lastname"),
            ]
            if part
        ).strip()
        or first_string(props, "email", "hs_email", "domain")
        or first_string(record, "name", "title", "id")
        or "unnamed record"
    )
    domain = first_string(props, "domain", "website")
    email = first_string(props, "email", "hs_email")
    suffix = domain or email
    return f"{name} — {suffix}" if suffix else name


def format_record(record: Any) -> str:
    if not isinstance(record, dict):
        return str(record)
    props = record.get("properties") if isinstance(record.get("properties"), dict) else {}
    key = first_string(record, "key", "number", "id")
    name = (
        first_string(record, "title", "summary", "name")
        or first_string(props, "summary", "name", "dealname", "email")
        or json.dumps(record, ensure_ascii=False, separators=(",", ":"))
    )
    status = first_string(record, "status", "state") or first_string(props, "status", "dealstage")
    prefix = f"{key} — " if key else ""
    suffix = f" ({status})" if status else ""
    return f"{prefix}{name}{suffix}"


def first_string(source: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = source.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return str(value)
    return ""


async def probe_hermes_provider_tool_reachability(
    tool: dict[str, Any],
    message: dict[str, Any],
    input_body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    module = load_burble_provider_tool_plugin()
    runtime = message.get("runtime")
    runtime_id = (
        str(runtime.get("id") or "contract-probe-runtime")
        if isinstance(runtime, dict)
        else "contract-probe-runtime"
    )
    effective_input = input_body if input_body is not None else sample_hermes_tool_input(tool)
    observed: dict[str, Any] = {}
    previous_env = {
        "BURBLE_TOOL_GATEWAY_URL": os.environ.get("BURBLE_TOOL_GATEWAY_URL"),
        "BURBLE_INTERNAL_TOKEN": os.environ.get("BURBLE_INTERNAL_TOKEN"),
        "BURBLE_RUNTIME_ID": os.environ.get("BURBLE_RUNTIME_ID"),
    }
    previous_session = getattr(module, "ClientSession")
    previous_timeout = getattr(module, "ClientTimeout")
    try:
        os.environ["BURBLE_TOOL_GATEWAY_URL"] = "http://burble-contract-probe/internal/tools"
        os.environ["BURBLE_INTERNAL_TOKEN"] = "contract-probe-token"
        os.environ["BURBLE_RUNTIME_ID"] = runtime_id
        module.ClientTimeout = lambda total=None: {"total": total}
        module.ClientSession = lambda timeout=None: HermesProviderProbeSession(
            runtime_id,
            observed,
        )
        raw_result = await module._burble_provider_call(
            {"toolName": tool["alias"], "input": effective_input}
        )
        try:
            content = json.loads(raw_result)
        except Exception:
            content = raw_result
    finally:
        for key, value in previous_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        module.ClientSession = previous_session
        module.ClientTimeout = previous_timeout

    tool_name = observed.get("toolName")
    tool_input = observed.get("input")
    if not isinstance(tool_name, str) or not isinstance(tool_input, dict):
        raise ValueError("Hermes provider bridge reachability probe did not call a tool")
    return {
        "toolName": tool_name,
        "input": tool_input,
        "content": content,
    }


class HermesProviderProbeSession:
    def __init__(self, runtime_id: str, observed: dict[str, Any]) -> None:
        self.runtime_id = runtime_id
        self.observed = observed

    async def __aenter__(self) -> "HermesProviderProbeSession":
        return self

    async def __aexit__(self, *_args: Any) -> None:
        return None

    def post(
        self,
        url: str,
        *,
        json: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> "HermesProviderProbeResponse":
        headers = headers or {}
        if headers.get("authorization") != "Bearer contract-probe-token":
            return HermesProviderProbeResponse(
                401,
                {"message": "missing probe authorization"},
            )
        if headers.get("x-burble-runtime-id") != self.runtime_id:
            return HermesProviderProbeResponse(
                400,
                {"message": "missing probe runtime id"},
            )
        if headers.get("content-type") != "application/json":
            return HermesProviderProbeResponse(
                400,
                {"message": "missing probe content type"},
            )
        parsed = urlparse(url)
        if not parsed.path.endswith("/execute"):
            return HermesProviderProbeResponse(
                400,
                {"message": "invalid probe path"},
            )
        encoded_tool_name = parsed.path.removesuffix("/execute").rsplit("/", 1)[-1]
        tool_name = unquote(encoded_tool_name)
        input_body = json.get("input") if isinstance(json, dict) else None
        if not tool_name or not isinstance(input_body, dict):
            return HermesProviderProbeResponse(
                400,
                {"message": "invalid probe tool call"},
            )
        self.observed["toolName"] = tool_name
        self.observed["input"] = input_body
        return HermesProviderProbeResponse(
            200,
            {
                "classification": "user_private",
                "content": {
                    "ok": True,
                    "toolName": tool_name,
                    "input": input_body,
                },
            },
        )


class HermesProviderProbeResponse:
    def __init__(self, status: int, body: dict[str, Any]) -> None:
        self.status = status
        self.body = body

    async def __aenter__(self) -> "HermesProviderProbeResponse":
        return self

    async def __aexit__(self, *_args: Any) -> None:
        return None

    async def json(self) -> dict[str, Any]:
        return self.body

    async def text(self) -> str:
        return json.dumps(self.body, ensure_ascii=False)


def sample_hermes_tool_input(tool: dict[str, Any]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    fields = tool.get("input")
    if not isinstance(fields, list):
        return output
    for field in fields:
        if not isinstance(field, dict) or field.get("required") is not True:
            continue
        name = str(field.get("name") or "").strip()
        if not name:
            continue
        output[name] = sample_hermes_tool_input_value(field)
    return output


def sample_hermes_tool_input_value(field: dict[str, Any]) -> Any:
    field_type = str(field.get("type") or "")
    if field_type == "number":
        return 1
    if field_type == "boolean":
        return True
    if field_type == "enum":
        values = field.get("values")
        return values[0] if isinstance(values, list) and values else "contract"
    if field_type == "string[]":
        return ["contract"]
    if field_type == "object":
        return {"contract": True}
    return f"contract-{field.get('name') or 'value'}"


def format_current_request_attachments(input_body: dict[str, Any]) -> str:
    attachments = input_body.get("attachments")
    if not isinstance(attachments, list) or not attachments:
        return ""

    lines = [
        "Current request attachments:",
        "Use Hermes tool conversation_get_attachment or burble_provider_call with toolName conversation.getAttachment and input {\"attachmentId\":\"<id>\"} to fetch content for these current-turn attachments.",
        "Use only the opaque attachment id shown here. Do not invent or mention Slack file ids, external ids, private URLs, or download URLs.",
    ]
    for index, attachment in enumerate(attachments, start=1):
        if not isinstance(attachment, dict):
            continue
        attachment_id = str(attachment.get("id") or "").strip()
        if not attachment_id:
            continue
        name = truncate_hermes_context_text(
            str(attachment.get("name") or "attachment"),
            MAX_HERMES_ATTACHMENT_NAME_CHARS,
        )
        kind = str(attachment.get("kind") or "file").strip() or "file"
        mime_type = str(attachment.get("mimeType") or "application/octet-stream").strip()
        size = attachment.get("sizeBytes")
        size_text = f", size={size} bytes" if isinstance(size, (int, float)) else ""
        lines.append(
            f"- {index}. id={attachment_id}, name={name}, kind={kind}, mimeType={mime_type}{size_text}"
        )

    return "\n".join(lines) if len(lines) > 3 else ""


def format_scheduled_job_context(
    input_body: dict[str, Any], *, now_utc: str | None = None
) -> str:
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
        f"- currentUtc={now_utc or current_utc_iso()}",
        f"- capabilityProfile={scheduled_job.get('capabilityProfile') or ''}",
        f"- allowedTools={allowed_tool_text}",
    ]
    route_id = scheduled_job.get("routeId")
    if route_id:
        lines.append(f"- routeId={route_id}")
        lines.append(
            f"- nativeDeliveryTarget=burble:{route_id} (use the Burble platform; never use slack:<channelId> for this Burble route)"
        )
    runtime_type = scheduled_job.get("runtimeType")
    if runtime_type:
        lines.append(f"- runtimeType={runtime_type}")
    native_toolsets = scheduled_job.get("nativeToolsets")
    if isinstance(native_toolsets, list):
        native_toolset_text = ",".join(
            sorted({str(toolset) for toolset in native_toolsets if str(toolset).strip()})
        )
        if native_toolset_text:
            lines.append(f"- nativeToolsets={native_toolset_text}")

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
        "The Burble provider bridge tool burble_provider_call is exposed through the native Burble toolset for scheduled jobs; use it for allowedTools instead of declaring that the bridge is unavailable."
    )
    lines.append(
        "Use currentUtc for scheduled time-window calculations. Do not call shell, terminal, or time tools just to compute the current UTC time."
    )
    lines.append(
        "Respect maxOutputVisibility when sending scheduled output. Do not publicly post private-tool-derived content; public channel delivery for authenticated provider read output requires an explicit declassification approval flow that is not implemented yet. Write-only provider state tools do not by themselves make public-source output private."
    )
    return "\n".join(lines)


def format_hermes_provider_tool_hint(hint: dict[str, Any]) -> str:
    input_schema = hint.get("input")
    if isinstance(input_schema, dict):
        compact_schema = json.dumps(
            input_schema,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        return (
            f"- {hint['name']} ({hint['alias']}): {hint.get('description', '')} "
            f"input schema {compact_schema}"
        )
    return f"- {hint['name']} ({hint['alias']}): args {hint.get('args', '')}"


def selected_hermes_provider_tool_hints(groups: list[str]) -> list[dict[str, Any]]:
    hints: list[dict[str, Any]] = []
    seen: set[str] = set()
    for group in groups:
        for hint in HERMES_PROVIDER_TOOL_HINTS.get(group, []):
            if hint["name"] in seen:
                continue
            seen.add(hint["name"])
            hints.append(hint)
    return hints


def truncate_hermes_context_text(
    text: str, limit: int = MAX_HERMES_CONTEXT_MESSAGE_CHARS
) -> str:
    if len(text) <= limit:
        return text
    return f"{text[:limit - 3]}..."


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
        self.events: list[dict[str, Any]] = []
        self.queues: list[asyncio.Queue[dict[str, Any] | None]] = []

    async def emit(self, event: dict[str, Any]) -> None:
        validate_runtime_run_event(event)
        self.events.append(event)
        for queue in list(self.queues):
            await queue.put(event)

    async def replay_to(self, queue: asyncio.Queue[dict[str, Any] | None]) -> None:
        for event in list(self.events):
            await queue.put(event)
        if self.completed:
            await queue.put(None)

    async def finish(self, response: dict[str, Any]) -> None:
        self.final_response = response
        self.completed = True
        await self.emit({"type": "final", "response": response})
        for queue in list(self.queues):
            await queue.put(None)

    async def fail(self, message: str) -> None:
        if not self.future.done():
            self.future.set_exception(RuntimeError(message))
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
        self.run_messages: dict[str, dict[str, Any]] = {}
        self.provider_preview_recovery_tasks: dict[str, asyncio.Task[None]] = {}
        self.provider_tool_call_recovery_tasks: dict[str, asyncio.Task[None]] = {}
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
        message = {
            "runId": run_id,
            "routeId": route_id,
            "originalText": text,
            "scheduledJob": input_body.get("scheduledJob"),
            "attachments": input_body.get("attachments"),
            "runtime": body.get("runtime"),
            "text": build_hermes_turn_text(input_body),
            "threadId": build_hermes_thread_id(run_id, conversation),
            "actorId": principal.get("slackUserId"),
            "actorName": principal.get("slackUserId"),
            "slackUserId": principal.get("slackUserId"),
            "isDirectMessage": conversation.get("isDirectMessage"),
        }
        self.runs[run_id] = waiter
        self.run_messages[run_id] = message
        print(
            f"[INFO] {timestamp()} Nemo Hermes run start runId={run_id} routeId={route_id} textChars={len(text)}",
            flush=True,
        )
        task = asyncio.create_task(
            self._execute_run(run_id, waiter, message)
        )
        if self._prefers_http_event_stream(request):
            return await self._stream_run_response(
                request,
                run_id,
                waiter,
                task,
                sse=self._prefers_sse(request),
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
            self.run_messages.pop(run_id, None)

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
                print(
                    f"[ERROR] {timestamp()} Nemo Hermes run snapshot timeout runId={run_id}",
                    file=sys.stderr,
                    flush=True,
                )
                await waiter.fail("Hermes did not produce a response before the run timeout.")
                return web.Response(text="Run timed out", status=504)
        if not waiter.final_response:
            print(
                f"[ERROR] {timestamp()} Nemo Hermes run snapshot missing final response "
                f"runId={run_id} completed={waiter.completed} "
                f"events={len(waiter.events)} futureDone={waiter.future.done()}",
                file=sys.stderr,
                flush=True,
            )
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
        await waiter.replay_to(queue)
        print(
            f"[INFO] {timestamp()} Nemo Hermes run events attached runId={run_id}",
            flush=True,
        )
        try:
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
        event_type = str(body.get("type") or "")
        print(
            f"[INFO] {timestamp()} Nemo Hermes run callback runId={run_id} "
            f"eventType={event_type or 'final'} textChars={len(text)} "
            f"bodyKeys={','.join(sorted(str(key) for key in body.keys()))}",
            flush=True,
        )
        provider_progress_tool = extract_hermes_provider_progress_tool(text)
        if provider_progress_tool:
            print(
                f"[WARN] {timestamp()} Nemo Hermes suppressed provider progress callback "
                f"runId={run_id} tool={provider_progress_tool}",
                flush=True,
            )
            if event_type not in {"message_delta", "message_replace"}:
                recovered = await self._recover_provider_progress_marker(
                    run_id,
                    waiter,
                    provider_progress_tool,
                )
                if not recovered:
                    await waiter.fail(
                        "Hermes returned a provider tool progress marker "
                        f"({provider_progress_tool}) instead of invoking the Burble provider bridge."
                    )
            return web.json_response({"ok": True})
        if event_type == "tool_call":
            tool_name = canonical_hermes_provider_tool_name(hermes_tool_event_name(body))
            if not tool_name:
                return web.Response(text="Hermes runtime tool_call requires toolName", status=400)
            call_id = hermes_tool_event_call_id(body, tool_name)
            tool_input = hermes_tool_event_input(body)
            tool_name, tool_input = unwrap_hermes_provider_tool_call(tool_name, tool_input)
            event: dict[str, Any] = {
                "type": "tool_call",
                "toolName": tool_name,
                "callId": call_id,
            }
            if tool_input is not None:
                event["input"] = tool_input
            await waiter.emit(event)
            if provider_tool_hint_by_name(tool_name):
                self._schedule_provider_tool_call_recovery(
                    run_id,
                    waiter,
                    tool_name,
                    call_id,
                    tool_input,
                )
            else:
                inferred_tool_name = self._infer_provider_tool_for_run(
                    run_id,
                    tool_name,
                    tool_input,
                )
                if inferred_tool_name:
                    print(
                        f"[WARN] {timestamp()} Nemo Hermes provider tool call name was not recognized; "
                        f"scheduling inferred recovery runId={run_id} "
                        f"tool={tool_name} inferredTool={inferred_tool_name} callId={call_id}",
                        flush=True,
                    )
                    self._schedule_provider_tool_call_recovery(
                        run_id,
                        waiter,
                        inferred_tool_name,
                        call_id,
                        tool_input,
                    )
                else:
                    self._schedule_stale_tool_call_failure(
                        run_id,
                        waiter,
                        tool_name,
                        call_id,
                    )
            return web.json_response({"ok": True})
        if event_type == "tool_result":
            tool_name = canonical_hermes_provider_tool_name(hermes_tool_event_name(body))
            if not tool_name:
                return web.Response(text="Hermes runtime tool_result requires toolName", status=400)
            call_id = hermes_tool_event_call_id(body, tool_name)
            self._cancel_provider_tool_call_recovery(run_id, call_id)
            event = {
                "type": "tool_result",
                "toolName": tool_name,
                "callId": call_id,
                "classification": str(body.get("classification") or "user_private"),
            }
            for key in ("content", "result", "output"):
                if key in body:
                    event["content"] = body[key]
                    break
            await waiter.emit(event)
            return web.json_response({"ok": True})
        if event_type in {"message_delta", "message_replace"}:
            if "text" not in body:
                return web.Response(text=f"Hermes runtime event {event_type} requires text", status=400)
            if text:
                calling_provider_tool = extract_hermes_calling_provider_tool(text)
                if calling_provider_tool:
                    await waiter.emit({"type": "status", "text": text})
                    recovered = await self._recover_provider_progress_marker(
                        run_id,
                        waiter,
                        calling_provider_tool,
                    )
                    if not recovered:
                        self._schedule_provider_preview_recovery(
                            run_id,
                            waiter,
                            calling_provider_tool,
                        )
                    return web.json_response({"ok": True})
                await waiter.emit({"type": event_type, "text": text})
            return web.json_response({"ok": True})
        if text:
            calling_provider_tool = extract_hermes_calling_provider_tool(text)
            if calling_provider_tool:
                await waiter.emit({"type": "status", "text": text})
                recovered = await self._recover_provider_progress_marker(
                    run_id,
                    waiter,
                    calling_provider_tool,
                )
                if not recovered:
                    self._schedule_provider_preview_recovery(
                        run_id,
                        waiter,
                        calling_provider_tool,
                    )
                return web.json_response({"ok": True})
        if is_hermes_progress_text(text):
            await waiter.emit({"type": "status", "text": text})
            return web.json_response({"ok": True})
        if text and is_hermes_provider_fallback_final(text):
            inferred_tool_name = self._infer_provider_tool_for_run(run_id, "", None)
            if inferred_tool_name and not self._has_provider_tool_event(waiter):
                print(
                    f"[WARN] {timestamp()} Nemo Hermes returned provider fallback final; "
                    f"recovering runId={run_id} inferredTool={inferred_tool_name} "
                    f"textChars={len(text)}",
                    flush=True,
                )
                recovered = await self._recover_provider_progress_marker(
                    run_id,
                    waiter,
                    inferred_tool_name,
                )
                if recovered:
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
                    scheduled_job = (
                        message.get("scheduledJob")
                        if isinstance(message.get("scheduledJob"), dict)
                        else {}
                    )
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
                    await waiter.emit({
                        "type": "tool_call",
                        "toolName": "burble_provider_call",
                        "callId": "contract-scheduled-provider-bridge-probe",
                        "input": {
                            "toolName": "runtime.conformance.echo",
                            "input": {
                                "jobId": str(scheduled_job.get("jobId") or ""),
                                "message": "scheduled provider bridge probe",
                            },
                        },
                    })
                    probed = await probe_hermes_provider_tool_reachability(
                        {
                            "alias": "runtime.conformance.echo",
                            "input": [],
                        },
                        message,
                        {
                            "jobId": str(scheduled_job.get("jobId") or ""),
                            "message": "scheduled provider bridge probe",
                        },
                    )
                    await waiter.emit({
                        "type": "tool_result",
                        "toolName": "burble_provider_call",
                        "callId": "contract-scheduled-provider-bridge-probe",
                        "classification": "user_private",
                        "content": probed["content"],
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
                if (
                    message.get("originalText") == "runtime contract tool reachability probe"
                    or message.get("text") == "runtime contract tool reachability probe"
                ):
                    await waiter.emit({"type": "status", "text": "Runtime contract probe accepted."})
                    for index, tool in enumerate(reachable_manifest_tools(message)):
                        call_id = f"contract-tool-reachability-{index}"
                        probed = await probe_hermes_provider_tool_reachability(
                            tool,
                            message,
                        )
                        await waiter.emit({
                            "type": "tool_call",
                            "toolName": probed["toolName"],
                            "callId": call_id,
                            "input": probed["input"],
                        })
                        await waiter.emit({
                            "type": "tool_result",
                            "toolName": probed["toolName"],
                            "callId": call_id,
                            "classification": "user_private",
                            "content": probed["content"],
                        })
                    response = {
                        "classification": "user_private",
                        "text": "Runtime contract tool reachability response.",
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
                    message.get("originalText") == "runtime contract attachment capability probe"
                    or message.get("text") == "runtime contract attachment capability probe"
                ):
                    attachments = message.get("attachments")
                    attachment_id = "attcap_contract_probe"
                    if isinstance(attachments, list) and attachments:
                        first_attachment = attachments[0]
                        if isinstance(first_attachment, dict):
                            attachment_id = str(first_attachment.get("id") or attachment_id)
                    await waiter.emit({"type": "status", "text": "Runtime contract probe accepted."})
                    await waiter.emit({
                        "type": "tool_call",
                        "toolName": "conversation.getAttachment",
                        "callId": "contract-attachment-probe",
                        "input": {"attachmentId": attachment_id},
                    })
                    await waiter.emit({
                        "type": "tool_result",
                        "toolName": "conversation.getAttachment",
                        "callId": "contract-attachment-probe",
                        "classification": "user_private",
                        "content": {"text": "contract attachment content"},
                    })
                    response = {
                        "classification": "user_private",
                        "text": "Runtime contract attachment capability response.",
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
            recovered_response = await self._recover_provider_final_result(
                run_id,
                waiter,
                result,
            )
            response = build_runtime_response(
                recovered_response or result,
                str(message.get("text") or ""),
            )
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
            provider_preview_task = self.provider_preview_recovery_tasks.pop(run_id, None)
            if (
                provider_preview_task
                and provider_preview_task is not asyncio.current_task()
                and not provider_preview_task.done()
            ):
                provider_preview_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await provider_preview_task
            self._cancel_provider_tool_call_recoveries_for_run(run_id)
            self.run_messages.pop(run_id, None)

    def _provider_tool_call_recovery_key(self, run_id: str, call_id: str) -> str:
        return f"{run_id}:{call_id}"

    def _cancel_provider_tool_call_recovery(self, run_id: str, call_id: str) -> None:
        task = self.provider_tool_call_recovery_tasks.pop(
            self._provider_tool_call_recovery_key(run_id, call_id),
            None,
        )
        if task and not task.done():
            task.cancel()

    def _cancel_provider_tool_call_recoveries_for_run(self, run_id: str) -> None:
        prefix = f"{run_id}:"
        for key, task in list(self.provider_tool_call_recovery_tasks.items()):
            if not key.startswith(prefix):
                continue
            self.provider_tool_call_recovery_tasks.pop(key, None)
            if task and not task.done():
                task.cancel()

    def _schedule_provider_tool_call_recovery(
        self,
        run_id: str,
        waiter: RunWaiter,
        tool_name: str,
        call_id: str,
        tool_input: dict[str, Any] | None,
    ) -> None:
        key = self._provider_tool_call_recovery_key(run_id, call_id)
        if key in self.provider_tool_call_recovery_tasks:
            return
        delay_seconds = max(0, int_env("HERMES_PROVIDER_TOOL_CALL_RECOVERY_SECONDS", 20))
        self.provider_tool_call_recovery_tasks[key] = asyncio.create_task(
            self._recover_provider_tool_call_after_delay(
                run_id,
                waiter,
                tool_name,
                call_id,
                tool_input,
                delay_seconds,
            )
        )

    def _infer_provider_tool_for_run(
        self,
        run_id: str,
        tool_name: str,
        tool_input: dict[str, Any] | None,
    ) -> str | None:
        if provider_tool_hint_by_name(tool_name):
            return tool_name
        if isinstance(tool_input, dict):
            for key in ("toolName", "tool_name", "tool", "name"):
                value = tool_input.get(key)
                if isinstance(value, str) and value.strip():
                    candidate = canonical_hermes_provider_tool_name(value)
                    if provider_tool_hint_by_name(candidate):
                        return candidate
        message = self.run_messages.get(run_id)
        original_text = (
            str(message.get("originalText") or message.get("text") or "")
            if isinstance(message, dict)
            else ""
        )
        candidate = infer_safe_hermes_provider_tool_from_text(original_text)
        return candidate if candidate and provider_tool_hint_by_name(candidate) else None

    def _schedule_stale_tool_call_failure(
        self,
        run_id: str,
        waiter: RunWaiter,
        tool_name: str,
        call_id: str,
    ) -> None:
        key = self._provider_tool_call_recovery_key(run_id, call_id)
        if key in self.provider_tool_call_recovery_tasks:
            return
        delay_seconds = max(1, int_env("HERMES_TOOL_CALL_TIMEOUT_SECONDS", 60))
        self.provider_tool_call_recovery_tasks[key] = asyncio.create_task(
            self._fail_stale_tool_call_after_delay(
                run_id,
                waiter,
                tool_name,
                call_id,
                delay_seconds,
            )
        )

    async def _fail_stale_tool_call_after_delay(
        self,
        run_id: str,
        waiter: RunWaiter,
        tool_name: str,
        call_id: str,
        delay_seconds: int,
    ) -> None:
        try:
            await asyncio.sleep(delay_seconds)
            if waiter.completed or waiter.future.done():
                return
            message = (
                "Hermes started tool "
                f"({tool_name}) but did not produce a tool result or final answer."
            )
            print(
                f"[ERROR] {timestamp()} Nemo Hermes stale tool call timeout "
                f"runId={run_id} tool={tool_name} callId={call_id} "
                f"delaySeconds={delay_seconds}",
                file=sys.stderr,
                flush=True,
            )
            await waiter.fail(message)
        except asyncio.CancelledError:
            raise
        finally:
            key = self._provider_tool_call_recovery_key(run_id, call_id)
            if self.provider_tool_call_recovery_tasks.get(key) is asyncio.current_task():
                self.provider_tool_call_recovery_tasks.pop(key, None)

    async def _recover_provider_tool_call_after_delay(
        self,
        run_id: str,
        waiter: RunWaiter,
        tool_name: str,
        call_id: str,
        tool_input: dict[str, Any] | None,
        delay_seconds: int,
    ) -> None:
        try:
            await asyncio.sleep(delay_seconds)
            if waiter.completed or waiter.future.done():
                return
            print(
                f"[WARN] {timestamp()} Nemo Hermes provider tool call timed out; recovering "
                f"runId={run_id} tool={tool_name} callId={call_id} "
                f"delaySeconds={delay_seconds}",
                flush=True,
            )
            recovered = await self._recover_provider_tool(
                run_id,
                waiter,
                tool_name,
                call_id,
                tool_input,
                emit_tool_call=False,
            )
            if recovered or waiter.future.done():
                return
            await waiter.fail(
                "Hermes started provider tool "
                f"({tool_name}) but did not produce a tool result or final answer."
            )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            print(
                f"[ERROR] {timestamp()} Nemo Hermes provider tool call recovery failed "
                f"runId={run_id} tool={tool_name} callId={call_id} error={error}",
                file=sys.stderr,
                flush=True,
            )
            if not waiter.future.done():
                await waiter.fail(str(error))
        finally:
            key = self._provider_tool_call_recovery_key(run_id, call_id)
            if self.provider_tool_call_recovery_tasks.get(key) is asyncio.current_task():
                self.provider_tool_call_recovery_tasks.pop(key, None)

    def _schedule_provider_preview_recovery(
        self,
        run_id: str,
        waiter: RunWaiter,
        tool_name: str,
    ) -> None:
        if run_id in self.provider_preview_recovery_tasks:
            return
        delay_seconds = max(0, int_env("HERMES_PROVIDER_PREVIEW_RECOVERY_SECONDS", 20))
        self.provider_preview_recovery_tasks[run_id] = asyncio.create_task(
            self._recover_provider_preview_after_delay(
                run_id,
                waiter,
                tool_name,
                delay_seconds,
            )
        )

    async def _recover_provider_preview_after_delay(
        self,
        run_id: str,
        waiter: RunWaiter,
        tool_name: str,
        delay_seconds: int,
    ) -> None:
        try:
            await asyncio.sleep(delay_seconds)
            if waiter.completed or waiter.future.done():
                return
            print(
                f"[WARN] {timestamp()} Nemo Hermes provider preview timed out; recovering "
                f"runId={run_id} tool={tool_name} delaySeconds={delay_seconds}",
                flush=True,
            )
            recovered = await self._recover_provider_progress_marker(
                run_id,
                waiter,
                tool_name,
            )
            if recovered or waiter.future.done():
                return
            await waiter.fail(
                "Hermes started provider tool "
                f"({tool_name}) but did not produce a final answer."
            )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            print(
                f"[ERROR] {timestamp()} Nemo Hermes provider preview recovery failed "
                f"runId={run_id} tool={tool_name} error={error}",
                file=sys.stderr,
                flush=True,
            )
            if not waiter.future.done():
                await waiter.fail(str(error))
        finally:
            if self.provider_preview_recovery_tasks.get(run_id) is asyncio.current_task():
                self.provider_preview_recovery_tasks.pop(run_id, None)

    async def _recover_provider_progress_marker(
        self,
        run_id: str,
        waiter: RunWaiter,
        tool_name: str,
    ) -> bool:
        if tool_name == "burble_provider_call":
            inferred_tool_name = self._infer_provider_tool_for_run(run_id, tool_name, None)
            if not inferred_tool_name:
                print(
                    f"[ERROR] {timestamp()} Nemo Hermes provider marker recovery could not infer "
                    f"bridge target runId={run_id} tool={tool_name}",
                    file=sys.stderr,
                    flush=True,
                )
                return False
            print(
                f"[WARN] {timestamp()} Nemo Hermes provider marker inferred bridge target "
                f"runId={run_id} tool={tool_name} inferredTool={inferred_tool_name}",
                flush=True,
            )
            tool_name = inferred_tool_name
        return await self._recover_provider_tool(
            run_id,
            waiter,
            tool_name,
            f"hermes-provider-marker-{uuid.uuid4()}",
            None,
            emit_tool_call=True,
        )

    async def _recover_provider_final_result(
        self,
        run_id: str,
        waiter: RunWaiter,
        result: dict[str, Any],
    ) -> dict[str, Any] | None:
        text = str(result.get("text") or "")
        if not text:
            return None
        tool_name = extract_hermes_provider_progress_tool(text)
        if not tool_name:
            tool_name = extract_hermes_calling_provider_tool(text)
        if not tool_name and is_hermes_provider_fallback_final(text):
            tool_name = self._infer_provider_tool_for_run(run_id, "", None)
        if not tool_name:
            return None
        print(
            f"[WARN] {timestamp()} Nemo Hermes returned provider-like final result; "
            f"recovering runId={run_id} tool={tool_name} textChars={len(text)}",
            flush=True,
        )
        recovered = await self._recover_provider_progress_marker(
            run_id,
            waiter,
            tool_name,
        )
        return waiter.final_response if recovered and waiter.final_response else None

    def _has_provider_tool_event(self, waiter: RunWaiter) -> bool:
        for event in waiter.events:
            if event.get("type") not in {"tool_call", "tool_result"}:
                continue
            tool_name = canonical_hermes_provider_tool_name(str(event.get("toolName") or ""))
            if tool_name == "burble_provider_call" or provider_tool_hint_by_name(tool_name):
                return True
        return False

    async def _recover_provider_tool(
        self,
        run_id: str,
        waiter: RunWaiter,
        tool_name: str,
        call_id: str,
        tool_input: dict[str, Any] | None,
        *,
        emit_tool_call: bool,
    ) -> bool:
        message = self.run_messages.get(run_id)
        if not isinstance(message, dict):
            print(
                f"[ERROR] {timestamp()} Nemo Hermes provider recovery missing run message "
                f"runId={run_id} tool={tool_name} callId={call_id}",
                file=sys.stderr,
                flush=True,
            )
            return False

        original_text = str(message.get("originalText") or message.get("text") or "")
        derived_input = derive_hermes_provider_marker_input(tool_name, original_text)
        effective_input = (
            tool_input
            if isinstance(tool_input, dict)
            and bool(tool_input)
            and is_hermes_provider_tool_read_safe(tool_name)
            else derived_input
        )
        if effective_input is None:
            print(
                f"[ERROR] {timestamp()} Nemo Hermes provider recovery could not derive safe input "
                f"runId={run_id} tool={tool_name} callId={call_id} textChars={len(original_text)}",
                file=sys.stderr,
                flush=True,
            )
            return False

        try:
            print(
                f"[WARN] {timestamp()} Nemo Hermes recovering provider tool "
                f"runId={run_id} tool={tool_name} callId={call_id} "
                f"input={json.dumps(effective_input, ensure_ascii=False)}",
                flush=True,
            )
            if emit_tool_call:
                await waiter.emit({
                    "type": "tool_call",
                    "toolName": tool_name,
                    "callId": call_id,
                    "input": effective_input,
                })
            recovery_timeout = max(1, int_env("HERMES_PROVIDER_RECOVERY_TIMEOUT_SECONDS", 120))
            try:
                content = await asyncio.wait_for(
                    call_burble_provider_tool(tool_name, effective_input),
                    timeout=recovery_timeout,
                )
            except asyncio.TimeoutError:
                message = (
                    "Burble provider tool "
                    f"{normalize_burble_provider_tool_name(tool_name)} timed out "
                    f"after {recovery_timeout}s during Hermes recovery."
                )
                print(
                    f"[ERROR] {timestamp()} Nemo Hermes provider recovery timed out "
                    f"runId={run_id} tool={tool_name} callId={call_id} "
                    f"timeoutSeconds={recovery_timeout}",
                    file=sys.stderr,
                    flush=True,
                )
                await waiter.emit({
                    "type": "tool_result",
                    "toolName": tool_name,
                    "callId": call_id,
                    "classification": "user_private",
                    "content": {"error": True, "message": message},
                })
                text = f"Provider tool failed: {message}"
                response = {"classification": "user_private", "text": text}
                waiter.final_response = response
                await waiter.emit({"type": "message_delta", "text": text})
                if not waiter.future.done():
                    waiter.future.set_result(response)
                return True
            await waiter.emit({
                "type": "tool_result",
                "toolName": tool_name,
                "callId": call_id,
                "classification": "user_private",
                "content": content,
            })
            text = format_hermes_provider_recovery_text(tool_name, effective_input, content)
            response = {"classification": "user_private", "text": text}
            waiter.final_response = response
            if text:
                await waiter.emit({"type": "message_delta", "text": text})
            if not waiter.future.done():
                waiter.future.set_result(response)
            print(
                f"[WARN] {timestamp()} Nemo Hermes provider tool recovered "
                f"runId={run_id} tool={tool_name} callId={call_id} textChars={len(text)}",
                flush=True,
            )
            return True
        except Exception as error:
            print(
                f"[ERROR] {timestamp()} Nemo Hermes provider recovery failed "
                f"runId={run_id} tool={tool_name} callId={call_id} error={error}",
                file=sys.stderr,
                flush=True,
            )
            message = f"Burble provider tool {normalize_burble_provider_tool_name(tool_name)} failed during Hermes recovery."
            await waiter.emit({
                "type": "tool_result",
                "toolName": tool_name,
                "callId": call_id,
                "classification": "user_private",
                "content": {"error": True, "message": message},
            })
            text = f"Provider tool failed: {message}"
            response = {"classification": "user_private", "text": text}
            waiter.final_response = response
            await waiter.emit({"type": "message_delta", "text": text})
            if not waiter.future.done():
                waiter.future.set_result(response)
            return True

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

    def _prefers_http_event_stream(self, request: web.Request) -> bool:
        accept = request.headers.get("accept", "").lower()
        return "application/x-ndjson" in accept or "text/event-stream" in accept

    def _prefers_sse(self, request: web.Request) -> bool:
        return "text/event-stream" in request.headers.get("accept", "").lower()

    async def _stream_run_response(
        self,
        request: web.Request,
        run_id: str,
        waiter: RunWaiter,
        task: asyncio.Task[dict[str, Any]],
        *,
        sse: bool,
    ) -> web.StreamResponse:
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        waiter.queues.append(queue)
        await waiter.replay_to(queue)
        response = web.StreamResponse(
            status=200,
            headers={
                "cache-control": "no-store",
                "content-type": "text/event-stream" if sse else "application/x-ndjson",
            },
        )
        await response.prepare(request)
        print(
            f"[INFO] {timestamp()} Nemo Hermes run HTTP stream attached runId={run_id}",
            flush=True,
        )
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                payload = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
                if sse:
                    event_type = str(event.get("type") or "message")
                    chunk = f"event: {event_type}\ndata: {payload}\n\n"
                else:
                    chunk = f"{payload}\n"
                await response.write(chunk.encode("utf-8"))
        finally:
            if queue in waiter.queues:
                waiter.queues.remove(queue)
            with contextlib.suppress(Exception):
                await task
            self.runs.pop(run_id, None)
            with contextlib.suppress(Exception):
                await response.write_eof()
            print(
                f"[INFO] {timestamp()} Nemo Hermes run HTTP stream closed runId={run_id}",
                flush=True,
            )
        return response

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
        platform_toolsets = append_required_hermes_scheduled_toolsets(
            platform_toolsets
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
            hermes_mcp_catalog_enabled()
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


def is_hermes_progress_text(text: str) -> bool:
    normalized = text.strip()
    return bool(
        re.match(r"^Retrying in [0-9.]+s \(attempt \d+/\d+\)\.\.\.$", normalized)
        or normalized.startswith(":hourglass_flowing_sand: Retrying in ")
        or normalized.startswith("Agent has thought for ")
        or is_hermes_provider_progress_text(normalized)
    )


def is_hermes_provider_progress_text(text: str) -> bool:
    return extract_hermes_provider_progress_tool(text) is not None


if __name__ == "__main__":
    try:
        asyncio.run(BurbleHermesRuntime().start())
    except KeyboardInterrupt:
        pass
    except Exception as error:
        print(f"[ERROR] {timestamp()} Nemo Hermes runtime failed: {error}", file=sys.stderr, flush=True)
        raise
