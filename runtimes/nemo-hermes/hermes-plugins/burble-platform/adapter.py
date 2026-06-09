from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections.abc import Mapping
from typing import Any, Dict, Optional
from urllib.parse import quote

try:
    from aiohttp import ClientSession, ClientTimeout, web
except ImportError:  # pragma: no cover - Hermes image installs aiohttp.
    ClientSession = None  # type: ignore[assignment]
    ClientTimeout = None  # type: ignore[assignment]
    web = None  # type: ignore[assignment]

from gateway.config import Platform
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)
from gateway.session import build_session_key

logger = logging.getLogger(__name__)
HERMES_STREAM_CURSOR = "\u2063"
HERMES_LEGACY_STREAM_CURSOR = " ▉"
HERMES_STREAM_CURSOR_GLYPHS = ("\u2063", "▉", "■")
HERMES_STREAM_CURSORS = (HERMES_STREAM_CURSOR, HERMES_LEGACY_STREAM_CURSOR)


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _int_env(name: str, default: int) -> int:
    raw = _env(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_enabled() -> Optional[dict]:
    if not _env("BURBLE_TOOL_GATEWAY_URL"):
        return None
    return {
        "host": _env("BURBLE_HERMES_PLATFORM_HOST", "127.0.0.1"),
        "port": _int_env("BURBLE_HERMES_PLATFORM_PORT", 8766),
        "runtime_callback_url": _env(
            "BURBLE_HERMES_RUNTIME_CALLBACK_URL",
            "http://127.0.0.1:8080/internal/hermes/runs",
        ),
    }


def _configured(config: Any) -> bool:
    return bool(_env("BURBLE_TOOL_GATEWAY_URL") and _env("BURBLE_INTERNAL_TOKEN"))


def _requirements() -> bool:
    return web is not None and ClientSession is not None


def _is_burble_platform_notice(text: str) -> bool:
    normalized = " ".join(text.strip().split())
    return (
        "No home channel is set for Burble" in normalized
        or "Type /sethome to make this chat your home channel" in normalized
    )


def _to_non_negative_int(value: Any) -> Optional[int]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


_MISSING = object()


def _keyed(value: Any) -> bool:
    return isinstance(value, Mapping) or callable(getattr(value, "keys", None))


def _get_key(source: Any, key: str) -> Any:
    if isinstance(source, Mapping):
        return source.get(key, _MISSING)

    keys = getattr(source, "keys", None)
    if not callable(keys):
        return _MISSING

    try:
        if key not in keys():
            return _MISSING
        return source[key]
    except Exception:
        return _MISSING


def _first_key(source: Any, *keys: str) -> Any:
    for key in keys:
        value = _get_key(source, key)
        if value is not _MISSING:
            return value
    return None


def _pick_int(source: Any, *keys: str) -> Optional[int]:
    for key in keys:
        value = _get_key(source, key)
        if value is not _MISSING:
            value = _to_non_negative_int(value)
            if value is not None:
                return value
    return None


def _pick_nested_int(source: Any, *paths: tuple[str, str]) -> Optional[int]:
    for outer_key, inner_key in paths:
        nested = _get_key(source, outer_key)
        if _keyed(nested):
            value = _get_key(nested, inner_key)
            if value is not _MISSING:
                value = _to_non_negative_int(value)
                if value is not None:
                    return value
    return None


def _normalize_usage(value: Any) -> Optional[dict[str, Any]]:
    if not _keyed(value):
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

    source = _first_key(value, "usageSource", "usage_source", "source")
    if isinstance(source, str) and source.strip():
        usage["usageSource"] = source.strip()

    return usage or None


def _usage_from_metadata(metadata: Optional[Dict[str, Any]]) -> Optional[dict[str, Any]]:
    if not _keyed(metadata):
        return None

    for key in ("usage", "token_usage", "tokenUsage", "llm_usage", "llmUsage"):
        usage = _normalize_usage(_get_key(metadata, key))
        if usage:
            return usage

    for key in ("response", "result", "generation", "model", "llm"):
        nested = _get_key(metadata, key)
        if _keyed(nested):
            usage = _usage_from_metadata(nested)
            if usage:
                return usage

    return _normalize_usage(metadata)


def _usage_snapshot(value: Any) -> Optional[dict[str, int]]:
    if not _keyed(value):
        return None

    input_tokens = _pick_int(value, "input_tokens", "inputTokens", "prompt_tokens", "promptTokens") or 0
    output_tokens = (
        _pick_int(value, "output_tokens", "outputTokens", "completion_tokens", "completionTokens") or 0
    )
    cache_read_tokens = (
        _pick_int(value, "cache_read_tokens", "cacheReadTokens", "cached_input_tokens", "cachedInputTokens")
        or 0
    )
    cache_write_tokens = _pick_int(value, "cache_write_tokens", "cacheWriteTokens") or 0
    reasoning_tokens = _pick_int(value, "reasoning_tokens", "reasoningTokens") or 0
    total_tokens = _pick_int(value, "total_tokens", "totalTokens")
    if total_tokens is None:
        total_tokens = (
            input_tokens
            + output_tokens
            + cache_read_tokens
            + cache_write_tokens
            + reasoning_tokens
        )

    return {
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "cachedInputTokens": cache_read_tokens,
        "cacheWriteTokens": cache_write_tokens,
        "reasoningTokens": reasoning_tokens,
        "totalTokens": total_tokens,
    }


def _usage_delta(
    before: Optional[dict[str, int]],
    after: Optional[dict[str, int]],
) -> Optional[dict[str, Any]]:
    if not after:
        return None

    before = before or {}

    def delta(key: str) -> int:
        return max(0, int(after.get(key, 0)) - int(before.get(key, 0)))

    input_tokens = delta("inputTokens")
    output_tokens = delta("outputTokens")
    cached_tokens = delta("cachedInputTokens")
    cache_write_tokens = delta("cacheWriteTokens")
    reasoning_tokens = delta("reasoningTokens")
    total_tokens = delta("totalTokens")
    if total_tokens <= 0:
        total_tokens = (
            input_tokens
            + output_tokens
            + cached_tokens
            + cache_write_tokens
            + reasoning_tokens
        )

    if total_tokens <= 0:
        return None

    usage: dict[str, Any] = {
        "totalTokens": total_tokens,
        "usageSource": "provider-output",
    }
    if input_tokens:
        usage["inputTokens"] = input_tokens
    if output_tokens:
        usage["outputTokens"] = output_tokens
    if cached_tokens:
        usage["cachedInputTokens"] = cached_tokens
    if reasoning_tokens:
        usage["reasoningTokens"] = reasoning_tokens
    return usage


class BurbleAdapter(BasePlatformAdapter):
    SUPPORTS_MESSAGE_EDITING = True
    MAX_MESSAGE_LENGTH = 200_000

    def __init__(self, config: Any):
        super().__init__(config=config, platform=Platform("burble"))
        extra = getattr(config, "extra", {}) or {}
        self.host = str(extra.get("host") or _env("BURBLE_HERMES_PLATFORM_HOST", "127.0.0.1"))
        self.port = int(extra.get("port") or _int_env("BURBLE_HERMES_PLATFORM_PORT", 8766))
        self.tool_gateway_url = _env("BURBLE_TOOL_GATEWAY_URL").rstrip("/")
        self.internal_token = _env("BURBLE_INTERNAL_TOKEN")
        self.runtime_id = _env("BURBLE_RUNTIME_ID")
        self.runtime_callback_url = str(
            extra.get("runtime_callback_url")
            or _env(
                "BURBLE_HERMES_RUNTIME_CALLBACK_URL",
                "http://127.0.0.1:8080/internal/hermes/runs",
            )
        ).rstrip("/")
        self._runner: Any = None
        self._pending_runs: dict[str, str] = {}
        self._pending_run_sources: dict[str, Any] = {}
        self._pending_usage_snapshots: dict[str, dict[str, int] | None] = {}
        self._stream_messages: dict[str, dict[str, Any]] = {}
        self._stream_message_counter = 0

    async def connect(self) -> bool:
        if not _requirements():
            logger.error("Burble: aiohttp is required")
            return False
        if not self.tool_gateway_url or not self.internal_token or not self.runtime_id:
            logger.error(
                "Burble: BURBLE_TOOL_GATEWAY_URL, BURBLE_INTERNAL_TOKEN, and "
                "BURBLE_RUNTIME_ID are required"
            )
            return False

        app = web.Application()
        app.router.add_get("/health", self._handle_health)
        app.router.add_post("/internal/burble/messages", self._handle_message_request)
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        await web.TCPSite(self._runner, self.host, self.port).start()
        self._mark_connected()
        logger.info("Burble: platform adapter listening on %s:%s", self.host, self.port)
        print(f"[INFO] Burble Hermes platform adapter listening on {self.host}:{self.port}", flush=True)
        return True

    async def disconnect(self) -> None:
        self._mark_disconnected()
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        route_id = str(chat_id or "").strip()
        text = str(content or "")
        if not route_id:
            return SendResult(success=False, error="Burble route id is required")
        if not text.strip():
            return SendResult(success=True, message_id=f"burble:{route_id}:{int(time.time() * 1000)}")
        if _is_burble_platform_notice(text):
            print(
                f"[INFO] Burble Hermes platform notice suppressed routeId={route_id} textChars={len(text)}",
                flush=True,
            )
            return SendResult(success=True, message_id=f"burble-notice:{route_id}:{int(time.time() * 1000)}")

        pending_run_id = self._pending_runs.pop(route_id, None)
        print(
            f"[INFO] Burble Hermes platform send routeId={route_id} textChars={len(text)} pendingRun={pending_run_id or 'none'}",
            flush=True,
        )
        if pending_run_id:
            if self._is_stream_preview(text):
                message_id = self._next_stream_message_id(pending_run_id)
                clean_text = self._clean_stream_preview(text)
                self._stream_messages[message_id] = {
                    "runId": pending_run_id,
                    "routeId": route_id,
                    "lastText": clean_text,
                    "usage": None,
                }
                if clean_text:
                    await self._post_runtime_callback(
                        pending_run_id,
                        {
                            "type": "message_delta",
                            "routeId": route_id,
                            "text": clean_text,
                            "classification": "user_private",
                        },
                    )
                return SendResult(success=True, message_id=message_id)

            callback = f"{self.runtime_callback_url}/{quote(pending_run_id, safe='')}/messages"
            payload: dict[str, Any] = {
                "routeId": route_id,
                "text": text,
                "classification": "user_private",
            }
            usage = _usage_from_metadata(metadata) or self._usage_delta_for_run(pending_run_id)
            self._pending_run_sources.pop(pending_run_id, None)
            self._pending_usage_snapshots.pop(pending_run_id, None)
            if usage:
                payload["usage"] = usage
            print(
                f"[INFO] Burble Hermes platform callback start runId={pending_run_id} textChars={len(text)} usage={'present' if usage else 'none'}",
                flush=True,
            )
            async with ClientSession(timeout=ClientTimeout(total=30)) as session:
                async with session.post(
                    callback,
                    json=payload,
                ) as response:
                    if response.status >= 400:
                        body = await response.text()
                        print(
                            f"[ERROR] Burble Hermes platform callback failed runId={pending_run_id} status={response.status}",
                            flush=True,
                        )
                        return SendResult(
                            success=False,
                            error=f"Burble runtime callback failed: {response.status} {body[:200]}",
                            retryable=response.status >= 500,
                        )
                    print(
                        f"[INFO] Burble Hermes platform callback finish runId={pending_run_id} status={response.status}",
                        flush=True,
                    )
            return SendResult(success=True, message_id=f"burble-run:{pending_run_id}")

        print(
            f"[INFO] Burble Hermes platform route send routeId={route_id} textChars={len(text)}",
            flush=True,
        )
        return await self._send_to_burble_route(route_id, text)

    async def edit_message(
        self,
        chat_id: str,
        message_id: str,
        content: str,
        finalize: bool = False,
        metadata: Optional[Dict[str, Any]] = None,
        **_kwargs: Any,
    ) -> SendResult:
        stream = self._stream_messages.get(str(message_id))
        if not stream:
            return SendResult(success=False, error="Burble stream message not found")

        run_id = str(stream["runId"])
        route_id = str(stream["routeId"] or chat_id)
        clean_text = self._clean_stream_preview(content)
        previous_text = str(stream.get("lastText") or "")
        usage = _usage_from_metadata(metadata) or self._usage_delta_for_run(run_id)
        if usage:
            stream["usage"] = usage

        if finalize:
            payload: dict[str, Any] = {
                "routeId": route_id,
                "text": clean_text,
                "classification": "user_private",
            }
            final_usage = stream.get("usage") or usage
            if final_usage:
                payload["usage"] = final_usage
            self._stream_messages.pop(str(message_id), None)
            self._pending_run_sources.pop(run_id, None)
            self._pending_usage_snapshots.pop(run_id, None)
            await self._post_runtime_callback(run_id, payload)
            return SendResult(success=True, message_id=message_id)

        stream["lastText"] = clean_text
        if clean_text.startswith(previous_text):
            delta = clean_text[len(previous_text):]
            if delta:
                await self._post_runtime_callback(
                    run_id,
                    {
                        "type": "message_delta",
                        "routeId": route_id,
                        "text": delta,
                        "classification": "user_private",
                    },
                )
        elif clean_text:
            await self._post_runtime_callback(
                run_id,
                {
                    "type": "message_replace",
                    "routeId": route_id,
                    "text": clean_text,
                    "classification": "user_private",
                },
            )
        return SendResult(success=True, message_id=message_id)

    async def send_typing(self, chat_id: str, **_kwargs: Any) -> bool:
        return True

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {
            "id": chat_id,
            "name": f"Burble route {chat_id}",
            "type": "channel",
            "chat_id": chat_id,
        }

    async def _handle_health(self, _request: Any) -> Any:
        return web.json_response({"ok": True})

    def _next_stream_message_id(self, run_id: str) -> str:
        self._stream_message_counter += 1
        return f"burble-stream:{run_id}:{self._stream_message_counter}"

    @staticmethod
    def _clean_stream_preview(text: str) -> str:
        value = str(text or "")
        for glyph in HERMES_STREAM_CURSOR_GLYPHS:
            value = value.replace(glyph, "")
        return value.rstrip()

    @staticmethod
    def _is_stream_preview(text: str) -> bool:
        value = str(text or "")
        return any(value.endswith(cursor) for cursor in HERMES_STREAM_CURSORS)

    async def _post_runtime_callback(self, run_id: str, payload: dict[str, Any]) -> bool:
        callback = f"{self.runtime_callback_url}/{quote(run_id, safe='')}/messages"
        async with ClientSession(timeout=ClientTimeout(total=30)) as session:
            async with session.post(callback, json=payload) as response:
                if response.status >= 400:
                    body = await response.text()
                    raise RuntimeError(
                        f"Burble runtime callback failed: {response.status} {body[:200]}"
                    )
        return True

    async def _handle_message_request(self, request: Any) -> Any:
        body = await request.json()
        route_id = str(body.get("routeId") or "").strip()
        text = str(body.get("text") or "")
        run_id = str(body.get("runId") or "").strip()
        print(
            f"[INFO] Burble Hermes platform inbound runId={run_id or 'none'} routeId={route_id or 'missing'} textChars={len(text)}",
            flush=True,
        )
        if not route_id:
            return web.json_response({"error": "routeId is required"}, status=400)
        if not text.strip():
            return web.json_response({"error": "text is required"}, status=400)

        if run_id:
            self._pending_runs[route_id] = run_id

        source = self.build_source(
            chat_id=route_id,
            chat_name=body.get("conversationName") or "Burble",
            chat_type="dm" if body.get("isDirectMessage") else "channel",
            user_id=body.get("actorId") or body.get("slackUserId"),
            user_name=body.get("actorName") or "Burble user",
            thread_id=body.get("threadId"),
            message_id=run_id or body.get("messageId"),
        )
        if run_id:
            self._pending_run_sources[run_id] = source
            self._pending_usage_snapshots[run_id] = self._usage_snapshot_for_source(source)
        event = MessageEvent(
            text=text,
            message_type=MessageType.TEXT,
            source=source,
            raw_message=body,
            message_id=run_id or body.get("messageId"),
            media_urls=[],
            media_types=[],
        )
        await self.handle_message(event)
        print(
            f"[INFO] Burble Hermes platform handed message to gateway runId={run_id or 'none'}",
            flush=True,
        )
        return web.json_response({"ok": True})

    def _usage_delta_for_run(self, run_id: str) -> Optional[dict[str, Any]]:
        source = self._pending_run_sources.get(run_id)
        if source is None:
            return None
        before = self._pending_usage_snapshots.get(run_id)
        after = self._usage_snapshot_for_source(source)
        return _usage_delta(before, after)

    def _usage_snapshot_for_source(self, source: Any) -> Optional[dict[str, int]]:
        store = getattr(self, "_session_store", None)
        if store is None:
            return None

        ensure_loaded = getattr(store, "_ensure_loaded", None)
        if callable(ensure_loaded):
            try:
                ensure_loaded()
            except Exception:
                return None

        session_key = self._session_key_for_source(source, store)
        if not session_key:
            return None

        entry = getattr(store, "_entries", {}).get(session_key)
        if entry is None:
            return None

        session_id = getattr(entry, "session_id", None)
        db = getattr(store, "_db", None)
        if db is not None and session_id:
            try:
                row = db.get_session(session_id)
                snapshot = _usage_snapshot(row)
                if snapshot is not None:
                    return snapshot
            except Exception:
                pass

        return _usage_snapshot(
            {
                "input_tokens": getattr(entry, "input_tokens", 0),
                "output_tokens": getattr(entry, "output_tokens", 0),
                "cache_read_tokens": getattr(entry, "cache_read_tokens", 0),
                "cache_write_tokens": getattr(entry, "cache_write_tokens", 0),
                "reasoning_tokens": getattr(entry, "reasoning_tokens", 0),
                "total_tokens": getattr(entry, "total_tokens", 0),
            }
        )

    def _session_key_for_source(self, source: Any, store: Any) -> Optional[str]:
        generator = getattr(store, "_generate_session_key", None)
        if callable(generator):
            try:
                return str(generator(source))
            except Exception:
                pass

        extra = getattr(self.config, "extra", {}) or {}
        try:
            return build_session_key(
                source,
                group_sessions_per_user=bool(extra.get("group_sessions_per_user", True)),
                thread_sessions_per_user=bool(extra.get("thread_sessions_per_user", False)),
            )
        except Exception:
            return None

    async def _send_to_burble_route(self, route_id: str, text: str) -> SendResult:
        url = (
            f"{self.tool_gateway_url}/"
            f"{quote('conversation.sendMessage', safe='')}/execute"
        )
        async with ClientSession(timeout=ClientTimeout(total=60)) as session:
            async with session.post(
                url,
                headers={
                    "authorization": f"Bearer {self.internal_token}",
                    "content-type": "application/json",
                    "x-burble-runtime-id": self.runtime_id,
                },
                json={"input": {"routeId": route_id, "text": text}},
            ) as response:
                body = await response.text()
                if response.status >= 400:
                    return SendResult(
                        success=False,
                        error=f"Burble conversation gateway returned {response.status}: {body[:200]}",
                        retryable=response.status >= 500,
                    )
        raw_response: dict[str, Any]
        try:
            parsed_body = json.loads(body)
            raw_response = parsed_body if isinstance(parsed_body, dict) else {"body": parsed_body}
        except json.JSONDecodeError:
            raw_response = {"body": body}
        return SendResult(
            success=True,
            message_id=f"burble:{route_id}:{int(time.time() * 1000)}",
            raw_response=raw_response,
        )


def register(ctx: Any) -> None:
    ctx.register_platform(
        name="burble",
        label="Burble",
        adapter_factory=lambda cfg: BurbleAdapter(cfg),
        check_fn=_requirements,
        validate_config=_configured,
        is_connected=_configured,
        required_env=[
            "BURBLE_TOOL_GATEWAY_URL",
            "BURBLE_INTERNAL_TOKEN",
            "BURBLE_RUNTIME_ID",
        ],
        install_hint="Bundled with the Burble Hermes runtime image",
        env_enablement_fn=_env_enabled,
        cron_deliver_env_var="BURBLE_HOME_ROUTE",
        allowed_users_env="BURBLE_ALLOWED_USERS",
        allow_all_env="BURBLE_ALLOW_ALL_USERS",
        max_message_length=4000,
        pii_safe=True,
        allow_update_command=False,
        platform_hint=(
            "You are chatting through Burble. Use concise Slack mrkdwn. "
            "Use Burble MCP provider tools for GitHub, Jira, Google Workspace, "
            "and Slack facts/actions instead of asking for API tokens, provider "
            "URLs, browser sessions, or local config. "
            "When a Burble provider tool returns an error object with a message, "
            "explain that message in normal Slack text; do not print raw JSON. "
            "For scheduled/background delivery, target the Burble route provided "
            "by the conversation context; do not mention Slack IDs, webhooks, or "
            "internal Burble URLs."
        ),
    )
