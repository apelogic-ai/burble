from __future__ import annotations

import asyncio
import logging
import os
import time
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

logger = logging.getLogger(__name__)


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


class BurbleAdapter(BasePlatformAdapter):
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

        pending_run_id = self._pending_runs.pop(route_id, None)
        print(
            f"[INFO] Burble Hermes platform send routeId={route_id} textChars={len(text)} pendingRun={pending_run_id or 'none'}",
            flush=True,
        )
        if pending_run_id:
            callback = f"{self.runtime_callback_url}/{quote(pending_run_id, safe='')}/messages"
            print(
                f"[INFO] Burble Hermes platform callback start runId={pending_run_id} textChars={len(text)}",
                flush=True,
            )
            async with ClientSession(timeout=ClientTimeout(total=30)) as session:
                async with session.post(
                    callback,
                    json={
                        "routeId": route_id,
                        "text": text,
                        "classification": "user_private",
                    },
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

    async def send_typing(self, chat_id: str) -> bool:
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
        return SendResult(
            success=True,
            message_id=f"burble:{route_id}:{int(time.time() * 1000)}",
            raw_response=body,
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
            "For scheduled/background delivery, target the Burble route provided "
            "by the conversation context; do not mention Slack IDs, webhooks, or "
            "internal Burble URLs."
        ),
    )
