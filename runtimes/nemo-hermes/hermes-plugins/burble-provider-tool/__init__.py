from __future__ import annotations

import json
import os
from typing import Any
from urllib.parse import quote

from aiohttp import ClientSession, ClientTimeout


TOOL_NAME_ALIASES = {
    "github_get_authenticated_user": "github.getAuthenticatedUser",
    "github_list_assigned_issues": "github.listAssignedIssues",
    "github_search_issues": "github.searchIssues",
    "github_list_my_pull_requests": "github.listMyPullRequests",
    "github_get_issue": "github.getIssue",
    "github_get_pr": "github.getPullRequest",
    "github_get_pull_request": "github.getPullRequest",
    "github_create_issue": "github.createIssue",
    "github_update_issue": "github.updateIssue",
    "github_close_issue": "github.closeIssue",
    "github_reopen_issue": "github.reopenIssue",
    "github_comment_on_issue_or_pr": "github.commentOnIssueOrPullRequest",
    "github_create_pr": "github.createPullRequest",
    "github_update_pr": "github.updatePullRequest",
    "github_add_labels": "github.addLabels",
    "github_remove_labels": "github.removeLabels",
    "github_request_review": "github.requestReview",
    "github_get_file": "github.getFile",
    "github_create_or_update_file": "github.createOrUpdateFile",
    "github_create_branch": "github.createBranch",
    "google_get_authenticated_user": "google.getAuthenticatedUser",
    "google_search_drive_files": "google.searchDriveFiles",
    "google_get_drive_file": "google.getDriveFile",
    "google_create_drive_text_file": "google.createDriveTextFile",
    "google_update_drive_text_file": "google.updateDriveTextFile",
    "google_append_to_drive_text_file": "google.appendDriveTextFile",
    "google_create_drive_folder": "google.createDriveFolder",
    "google_move_drive_file": "google.moveDriveFile",
    "google_search_calendar_events": "google.searchCalendarEvents",
    "google_create_calendar_event": "google.createCalendarEvent",
    "google_update_calendar_event": "google.updateCalendarEvent",
    "google_search_mail_messages": "google.searchMailMessages",
    "google_slides_search_presentations": "google.slidesSearchPresentations",
    "google_slides_get_presentation": "google.slidesGetPresentation",
    "google_slides_probe_template": "google.slidesProbeTemplate",
    "google_slides_copy_presentation": "google.slidesCopyPresentation",
    "google_slides_create_slide": "google.slidesCreateSlide",
    "google_slides_fill_placeholders": "google.slidesFillPlaceholders",
    "google_analytics_list_properties": "google.analyticsListProperties",
    "google_analytics_get_metadata": "google.analyticsGetMetadata",
    "google_analytics_run_report": "google.analyticsRunReport",
    "gmail_create_draft": "gmail.createDraft",
    "hubspot_get_authenticated_user": "hubspot.getAuthenticatedUser",
    "hubspot_search_contacts": "hubspot.searchContacts",
    "hubspot_search_companies": "hubspot.searchCompanies",
    "hubspot_search_deals": "hubspot.searchDeals",
    "hubspot_search_crm_objects": "hubspot.searchCrmObjects",
    "hubspot_list_owners": "hubspot.listOwners",
    "hubspot_list_users": "hubspot.listUsers",
    "hubspot_read_api_resource": "hubspot.readApiResource",
    "jira_get_authenticated_user": "jira.getAuthenticatedUser",
    "jira_list_accessible_resources": "jira.listAccessibleResources",
    "jira_list_visible_projects": "jira.listVisibleProjects",
    "jira_search_users": "jira.searchUsers",
    "jira_create_issue": "jira.createIssue",
    "jira_edit_issue": "jira.editIssue",
    "jira_list_assigned_issues": "jira.listAssignedIssues",
    "jira_search_issues": "jira.searchIssues",
    "jira_get_issue": "jira.getIssue",
    "jira_update_issue": "jira.updateIssue",
    "jira_add_comment": "jira.addComment",
    "jira_transition_issue": "jira.transitionIssue",
    "jira_add_labels": "jira.addLabels",
    "jira_remove_labels": "jira.removeLabels",
    "jira_link_issues": "jira.linkIssues",
    "jira_create_subtask": "jira.createSubtask",
    "slack_search_users": "slack.searchUsers",
    "slack_search_messages": "slack.searchMessages",
    "atlassian_list_mcp_tools": "atlassian.listMcpTools",
    "atlassian_call_mcp_tool": "atlassian.callMcpTool",
    "scheduled_job_register_capability": "scheduledJob.registerCapability",
    "conversation_get_attachment": "conversation.getAttachment",
}

PROVIDER_BRIDGE_TOOLSETS = ["burble", "cronjob", "web"]
PROVIDER_ALIAS_TOOLSETS = ["burble", "cronjob"]
TOOLSET_BRIDGE_TOOLS = {
    "burble": ["burble_provider_call"],
    "cronjob": ["burble_provider_call"],
    "web": ["burble_provider_call"],
}
BRIDGE_TOOL_NAMES = {"burble_provider_call", "burble.providerCall"}


BURBLE_PROVIDER_CALL_SCHEMA = {
    "description": "Call one selected Burble provider tool through the runtime-scoped Burble tool gateway.",
    "parameters": {
        "type": "object",
        "properties": {
            "toolName": {
                "type": "string",
                "description": "Burble tool name from the selected tool hints, for example github_list_my_pull_requests or google.searchDriveFiles.",
            },
            "input": {
                "type": "object",
                "description": "Arguments for that Burble tool.",
                "additionalProperties": True,
            },
        },
        "required": ["toolName"],
        "additionalProperties": False,
    },
}


def _provider_alias_schema(alias: str, canonical_name: str) -> dict[str, Any]:
    if canonical_name == "scheduledJob.registerCapability":
        return {
            "description": (
                "Register the Burble provider tools a native scheduled/background job "
                "will need before creating, updating, or manually triggering that job. "
                "Include the returned scheduledPromptInstruction verbatim in the job prompt. "
                "For scheduled Slack channel delivery, pass the channel label as destination "
                "and use the returned convrt_* route for native delivery."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "jobId": {
                        "type": "string",
                        "description": "Stable native scheduler job id or job name.",
                    },
                    "requiredTools": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "Exact Burble provider tool names the scheduled job may call, "
                            "for example google_get_drive_file and google_append_to_drive_text_file."
                        ),
                    },
                    "allowedTools": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Alias for requiredTools.",
                    },
                    "required_tools": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Alias for requiredTools.",
                    },
                    "allowed_tools": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Alias for requiredTools.",
                    },
                    "tools": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Alias for requiredTools.",
                    },
                    "routeId": {
                        "type": "string",
                        "description": "Optional durable Burble route id for scheduled/background delivery.",
                    },
                    "destination": {
                        "type": "string",
                        "description": (
                            "Optional Slack destination label for scheduled/background delivery, "
                            "such as #eng, <#C123|eng>, or a channel id. Burble resolves it only "
                            "when the user has already granted that channel with /agent grant here. "
                            "Pass named Slack channels here instead of using them as route ids."
                        ),
                    },
                    "stateRefs": {
                        "type": "array",
                        "description": "Optional durable provider-backed state references.",
                        "items": {"type": "object", "additionalProperties": True},
                    },
                    "visibilityPolicy": {
                        "type": "object",
                        "description": (
                            "Optional output visibility policy for scheduled delivery. Slack "
                            'channel destinations require {"maxOutputVisibility":"public"} '
                            "when the user explicitly asked to post public scheduled output "
                            "to that channel. Do not set allowPrivateToolDeclassification "
                            "automatically."
                        ),
                        "properties": {
                            "maxOutputVisibility": {
                                "type": "string",
                                "enum": ["public", "user_private", "restricted"],
                                "description": (
                                    'Set to "public" only when the user explicitly asked '
                                    "public-source scheduled output to post to a Slack channel."
                                ),
                            },
                            "allowPrivateToolDeclassification": {
                                "type": "boolean",
                                "description": (
                                    "Do not set automatically. Reserved for an explicit "
                                    "declassification approval flow."
                                ),
                            },
                        },
                        "additionalProperties": False,
                    },
                },
                "required": ["jobId"],
                "additionalProperties": True,
            },
        }
    return {
        "description": (
            f"Call Burble provider tool {canonical_name}. "
            "Pass the provider tool arguments directly. For scheduled jobs, include jobId."
        ),
        "parameters": {
            "type": "object",
            "description": f"Arguments for Burble provider tool {canonical_name}.",
            "additionalProperties": True,
        },
    }


def _env(name: str) -> str:
    return os.getenv(name, "").strip()


def normalize_burble_tool_name(name: str) -> str:
    clean_name = str(name or "").strip()
    if not clean_name:
        raise ValueError("toolName is required")
    return TOOL_NAME_ALIASES.get(clean_name, clean_name)


def _bridge_call_envelope(args: dict[str, Any]) -> dict[str, Any]:
    raw_name = args.get("toolName") or args.get("tool") or args.get("name")
    if raw_name and str(raw_name).strip() not in BRIDGE_TOOL_NAMES:
        return args

    for key in ("input", "arguments"):
        raw_value = args.get(key)
        if isinstance(raw_value, dict) and (
            raw_value.get("toolName") or raw_value.get("tool") or raw_value.get("name")
        ):
            return raw_value

    return args


def _read_tool_name(args: dict[str, Any]) -> str:
    envelope = _bridge_call_envelope(args)
    raw_name = envelope.get("toolName") or envelope.get("tool") or envelope.get("name")
    tool_name = normalize_burble_tool_name(str(raw_name or ""))
    if tool_name in BRIDGE_TOOL_NAMES:
        raise ValueError("burble_provider_call requires toolName")
    return tool_name


def _read_tool_input(args: dict[str, Any]) -> dict[str, Any]:
    envelope = _bridge_call_envelope(args)
    raw_input = envelope.get("input")
    if raw_input is None:
        raw_input = envelope.get("arguments")
    if raw_input is None:
        return {}
    if isinstance(raw_input, dict):
        return raw_input
    raise ValueError("input must be an object")


async def _burble_provider_call(args: dict[str, Any], **_kwargs: Any) -> str:
    gateway_url = _env("BURBLE_TOOL_GATEWAY_URL").rstrip("/")
    internal_token = _env("BURBLE_INTERNAL_TOKEN")
    runtime_id = _env("BURBLE_RUNTIME_ID")
    if not gateway_url or not internal_token or not runtime_id:
        return json.dumps(
            {
                "error": True,
                "message": "Burble provider tool bridge is not configured.",
            },
            ensure_ascii=False,
        )

    try:
        tool_name = _read_tool_name(args)
        tool_input = _read_tool_input(args)
    except ValueError as error:
        return json.dumps({"error": True, "message": str(error)}, ensure_ascii=False)

    url = f"{gateway_url}/{quote(tool_name, safe='')}/execute"
    payload = {"input": tool_input}
    headers = {
        "authorization": f"Bearer {internal_token}",
        "content-type": "application/json",
        "x-burble-runtime-id": runtime_id,
    }
    try:
        async with ClientSession(timeout=ClientTimeout(total=120)) as session:
            async with session.post(url, json=payload, headers=headers) as response:
                try:
                    body = await response.json()
                except Exception:
                    body = {"message": await response.text()}
                if response.status >= 400:
                    return json.dumps(
                        {
                            "error": True,
                            "status": response.status,
                            "message": body.get("message") if isinstance(body, dict) else str(body),
                            "body": body,
                        },
                        ensure_ascii=False,
                    )
                if isinstance(body, dict) and "content" in body:
                    return json.dumps(body["content"], ensure_ascii=False)
                return json.dumps(body, ensure_ascii=False)
    except Exception as error:
        return json.dumps({"error": True, "message": str(error)}, ensure_ascii=False)


def _make_provider_alias_handler(canonical_name: str):
    async def _provider_alias_call(args: dict[str, Any], **_kwargs: Any) -> str:
        return await _burble_provider_call(
            {"toolName": canonical_name, "input": args or {}}
        )

    return _provider_alias_call


def _pin_provider_bridge_to_toolsets() -> None:
    try:
        import toolsets

        for toolset_name, bridge_tools in TOOLSET_BRIDGE_TOOLS.items():
            entry = toolsets.TOOLSETS.setdefault(
                toolset_name,
                {
                    "description": f"{toolset_name} tools",
                    "tools": [],
                    "includes": [],
                },
            )
            tools = entry.setdefault("tools", [])
            if not isinstance(tools, list):
                continue
            for tool_name in bridge_tools:
                if tool_name not in tools:
                    tools.append(tool_name)
    except Exception as error:
        print(
            f"[WARN] Burble provider bridge web toolset install failed: {error}",
            flush=True,
        )


def register(ctx) -> None:
    _pin_provider_bridge_to_toolsets()
    for toolset in PROVIDER_BRIDGE_TOOLSETS:
        ctx.register_tool(
            name="burble_provider_call",
            toolset=toolset,
            schema=BURBLE_PROVIDER_CALL_SCHEMA,
            handler=_burble_provider_call,
            is_async=True,
            description=BURBLE_PROVIDER_CALL_SCHEMA["description"],
            override=True,
        )
    for toolset in PROVIDER_ALIAS_TOOLSETS:
        for alias, canonical_name in sorted(TOOL_NAME_ALIASES.items()):
            schema = _provider_alias_schema(alias, canonical_name)
            ctx.register_tool(
                name=alias,
                toolset=toolset,
                schema=schema,
                handler=_make_provider_alias_handler(canonical_name),
                is_async=True,
                description=schema["description"],
                override=True,
            )
