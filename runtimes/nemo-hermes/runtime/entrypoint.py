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


HERMES_PLUGIN_SOURCE = Path("/runtime/hermes-plugins")


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


def yaml_string(value: str) -> str:
    return json.dumps(value)


DEFAULT_SOUL_MD = """# Burble Runtime

You are Burble's Hermes runtime.

Answer in concise Slack mrkdwn. Do not ask the user to run Hermes-native setup
commands such as /sethome or /help. Burble manages channel delivery, OAuth
connections, and runtime configuration outside Hermes.

Use Burble MCP provider tools for GitHub, Jira, Google Workspace, and Slack
facts/actions. Do not ask the user for provider URLs, API tokens, browser
sessions, or local config when a Burble MCP tool can answer the request. If a
provider tool reports that a connection is missing or expired, tell the user to
connect that provider through Burble.

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

    async def handle_run(self, request: web.Request) -> web.Response:
        body = await request.json()
        run_id = str(body.get("runId") or uuid.uuid4())
        text = str((body.get("input") or {}).get("text") or "")
        conversation = ((body.get("input") or {}).get("conversation") or {})
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
                    "text": text,
                    "threadId": conversation.get("rootId"),
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
                {
                    "response": {
                        "classification": result.get("classification") or "user_private",
                        "text": result.get("text") or "",
                    }
                },
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
            response = {
                "classification": result.get("classification") or "user_private",
                "text": result.get("text") or "",
            }
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
        lines.extend(["plugins:", "  enabled:", "    - burble-platform", "    - burble-web-extract"])
        if env("BURBLE_MCP_GATEWAY_URL") and env("BURBLE_RUNTIME_JWT"):
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
