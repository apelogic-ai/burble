from __future__ import annotations

import asyncio
import html
import json
import os
import re
from html.parser import HTMLParser
from typing import Any

from aiohttp import ClientSession, ClientTimeout


MAX_URLS = 5
MAX_CONTENT_CHARS = 12000


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.title = ""
        self._in_title = False
        self._skip_depth = 0
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag == "title":
            self._in_title = True
        if tag in {"script", "style", "noscript", "svg"}:
            self._skip_depth += 1
        if tag in {"p", "br", "div", "section", "article", "li", "h1", "h2", "h3"}:
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "title":
            self._in_title = False
        if tag in {"script", "style", "noscript", "svg"} and self._skip_depth:
            self._skip_depth -= 1
        if tag in {"p", "div", "section", "article", "li", "h1", "h2", "h3"}:
            self._parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        text = html.unescape(data).strip()
        if not text:
            return
        if self._in_title:
            self.title = f"{self.title} {text}".strip()
        else:
            self._parts.append(text)

    def text(self) -> str:
        raw = " ".join(self._parts)
        raw = re.sub(r"[ \t\r\f\v]+", " ", raw)
        raw = re.sub(r"\n\s+", "\n", raw)
        raw = re.sub(r"\n{3,}", "\n\n", raw)
        return raw.strip()


def _has_configured_extract_backend() -> bool:
    env_keys = (
        "FIRECRAWL_API_KEY",
        "FIRECRAWL_API_URL",
        "TAVILY_API_KEY",
        "EXA_API_KEY",
        "PARALLEL_API_KEY",
    )
    return any(os.getenv(key, "").strip() for key in env_keys)


async def _fetch_url(session: ClientSession, url: str) -> dict[str, Any]:
    try:
        from tools.web_tools import is_safe_url

        if not is_safe_url(url):
            return {
                "url": url,
                "title": "",
                "content": "",
                "error": "Blocked: URL targets a private or internal network address",
            }

        async with session.get(
            url,
            allow_redirects=True,
            headers={"User-Agent": "Burble-Hermes/0.1"},
        ) as response:
            final_url = str(response.url)
            if not is_safe_url(final_url):
                return {
                    "url": final_url,
                    "title": "",
                    "content": "",
                    "error": "Blocked: redirected URL targets a private or internal network address",
                }
            if response.status >= 400:
                return {
                    "url": final_url,
                    "title": "",
                    "content": "",
                    "error": f"HTTP {response.status}",
                }
            body = await response.text(errors="ignore")
    except Exception as error:
        return {"url": url, "title": "", "content": "", "error": str(error)}

    parser = _TextExtractor()
    parser.feed(body)
    content = parser.text()
    if len(content) > MAX_CONTENT_CHARS:
        content = content[:MAX_CONTENT_CHARS].rstrip() + "\n\n[truncated]"
    return {
        "url": final_url,
        "title": parser.title,
        "content": content,
        "raw_content": content,
        "error": None,
    }


async def _local_web_extract(args: dict[str, Any], **_kwargs: Any) -> str:
    if _has_configured_extract_backend():
        from tools.web_tools import web_extract_tool

        return await web_extract_tool(**args)

    urls = args.get("urls")
    if not isinstance(urls, list) or not urls:
        return json.dumps({"success": False, "error": "urls must be a non-empty array"})

    clean_urls = [str(url) for url in urls[:MAX_URLS]]
    timeout = ClientTimeout(total=30)
    async with ClientSession(timeout=timeout) as session:
        results = await asyncio.gather(*(_fetch_url(session, url) for url in clean_urls))
    return json.dumps({"results": results}, ensure_ascii=False)


def register(ctx) -> None:
    import tools.web_tools as web_tools
    from tools.registry import registry

    existing = registry.get_entry("web_extract")
    schema = existing.schema if existing is not None else web_tools.WEB_EXTRACT_SCHEMA
    description = existing.description if existing is not None else schema.get("description", "")
    ctx.register_tool(
        name="web_extract",
        toolset="web",
        schema=schema,
        handler=_local_web_extract,
        is_async=True,
        description=description,
        override=True,
    )
