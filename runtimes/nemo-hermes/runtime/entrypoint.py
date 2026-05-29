from __future__ import annotations

import asyncio
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


HERMES_PLUGIN_SOURCE = Path("/runtime/hermes-plugins/burble-platform")


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
        route_id = str(conversation.get("routeId") or "")
        if not route_id:
            return web.Response(text="Hermes Burble runtime requires input.conversation.routeId", status=400)
        if not text.strip():
            return web.Response(text="Hermes Burble runtime requires input.text", status=400)

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
                    "slackUserId": (body.get("principal") or {}).get("slackUserId"),
                    "isDirectMessage": conversation.get("isDirectMessage"),
                },
            )
        )
        if self._prefers_async(request):
            task.add_done_callback(lambda _task: asyncio.create_task(self._expire_run_later(run_id)))
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
        try:
            await waiter.emit({"type": "status", "text": "Hermes accepted the Burble turn."})
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
        plugins_dir = self.home / "plugins" / "burble-platform"
        plugins_dir.parent.mkdir(parents=True, exist_ok=True)
        if plugins_dir.exists():
            shutil.rmtree(plugins_dir)
        shutil.copytree(HERMES_PLUGIN_SOURCE, plugins_dir)

    def _ensure_gateway_config(self) -> None:
        config_path = self.home / "config.yaml"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        lines = [
            "plugins:",
            "  enabled:",
            "    - burble-platform",
        ]
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
