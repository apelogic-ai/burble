import hashlib
import json
from datetime import datetime
from typing import Any, Optional
from urllib.parse import urlsplit

from litellm.integrations.custom_logger import CustomLogger


LOG_PREFIX = "burble_llm_boundary "
MAX_SAFE_VALUE_CHARS = 160


def _read(value: Any, *path: str) -> Any:
    current = value
    for key in path:
        if isinstance(current, dict):
            current = current.get(key)
        else:
            current = getattr(current, key, None)
        if current is None:
            return None
    return current


def _first(value: Any, paths: list[tuple[str, ...]]) -> Any:
    for path in paths:
        candidate = _read(value, *path)
        if candidate is not None:
            return candidate
    return None


def _safe_string(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    normalized = " ".join(value.split())
    if not normalized:
        return None
    return normalized[:MAX_SAFE_VALUE_CHARS]


def _safe_integer(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def _timestamp_ms(value: Any) -> Optional[int]:
    if isinstance(value, datetime):
        return round(value.timestamp() * 1000)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return round(value * 1000)
    return None


def _elapsed_ms(start_time: Any, end_time: Any) -> Optional[int]:
    start_ms = _timestamp_ms(start_time)
    end_ms = _timestamp_ms(end_time)
    if start_ms is None or end_ms is None:
        return None
    return max(0, end_ms - start_ms)


def _correlation_id(payload: Any) -> Optional[str]:
    prompt_cache_key = _first(
        payload,
        [
            ("prompt_cache_key",),
            ("optional_params", "prompt_cache_key"),
            ("proxy_server_request", "body", "prompt_cache_key"),
        ],
    )
    if not isinstance(prompt_cache_key, str) or not prompt_cache_key:
        return None
    clamped = prompt_cache_key[:64]
    return hashlib.sha256(clamped.encode("utf-8")).hexdigest()[:16]


def _route(payload: Any) -> Optional[str]:
    raw_url = _first(
        payload,
        [
            ("proxy_server_request", "url"),
            ("proxy_server_request", "request_url"),
        ],
    )
    if not isinstance(raw_url, str):
        return None
    try:
        return urlsplit(raw_url).path or "/"
    except ValueError:
        return None


def _list_count(payload: Any, *paths: tuple[str, ...]) -> Optional[int]:
    value = _first(payload, list(paths))
    return len(value) if isinstance(value, list) else None


def _call_id(payload: Any) -> Optional[str]:
    return _safe_string(
        _first(
            payload,
            [
                ("litellm_call_id",),
                ("litellm_params", "litellm_call_id"),
                ("standard_logging_object", "id"),
            ],
        )
    )


def _provider_request_id(response: Any) -> Optional[str]:
    for header_name in (
        "x-request-id",
        "request-id",
        "openai-request-id",
        "x-ms-request-id",
    ):
        value = _first(
            response,
            [
                ("_hidden_params", "additional_headers", header_name),
                ("hidden_params", "additional_headers", header_name),
                ("headers", header_name),
            ],
        )
        safe_value = _safe_string(value)
        if safe_value:
            return safe_value
    return _safe_string(_read(response, "id"))


def _base_event(event: str, payload: Any) -> dict[str, Any]:
    model = _safe_string(_first(payload, [("model",), ("model_group",)]))
    provider = _safe_string(
        _first(
            payload,
            [
                ("custom_llm_provider",),
                ("litellm_params", "custom_llm_provider"),
                ("standard_logging_object", "custom_llm_provider"),
            ],
        )
    )
    result: dict[str, Any] = {
        "schemaVersion": 1,
        "component": "litellm",
        "event": event,
        "timestamp": datetime.now().astimezone().isoformat(timespec="milliseconds"),
    }
    optional_fields = {
        "correlationId": _correlation_id(payload),
        "callId": _call_id(payload),
        "model": model,
        "provider": provider,
        "route": _route(payload),
        "stream": _first(payload, [("stream",), ("litellm_params", "stream")]),
        "toolCount": _list_count(
            payload,
            ("tools",),
            ("optional_params", "tools"),
            ("proxy_server_request", "body", "tools"),
        ),
        "inputItemCount": _list_count(
            payload,
            ("input",),
            ("messages",),
            ("proxy_server_request", "body", "input"),
        ),
    }
    for key, value in optional_fields.items():
        if value is not None and (not isinstance(value, str) or value):
            result[key] = value
    return result


def _emit(event: dict[str, Any]) -> None:
    print(
        LOG_PREFIX + json.dumps(event, separators=(",", ":"), sort_keys=True),
        flush=True,
    )


class BurbleBoundaryLogger(CustomLogger):
    def __init__(self) -> None:
        super().__init__(turn_off_message_logging=True)

    async def async_pre_call_hook(
        self,
        user_api_key_dict: Any,
        cache: Any,
        data: dict[str, Any],
        call_type: Any,
    ) -> dict[str, Any]:
        event = _base_event("request_received", data)
        safe_call_type = _safe_string(str(call_type))
        if safe_call_type:
            event["callType"] = safe_call_type
        _emit(event)
        return data

    async def async_pre_call_deployment_hook(
        self, kwargs: dict[str, Any], call_type: Any
    ) -> dict[str, Any]:
        event = _base_event("provider_start", kwargs)
        safe_call_type = _safe_string(str(call_type))
        if safe_call_type:
            event["callType"] = safe_call_type
        _emit(event)
        return kwargs

    async def async_log_success_event(
        self,
        kwargs: dict[str, Any],
        response_obj: Any,
        start_time: Any,
        end_time: Any,
    ) -> None:
        event = _base_event("provider_success", kwargs)
        elapsed_ms = _elapsed_ms(start_time, end_time)
        completion_started_at = _first(
            kwargs,
            [
                ("completion_start_time",),
                ("standard_logging_object", "completionStartTime"),
            ],
        )
        first_token_ms = _elapsed_ms(start_time, completion_started_at)
        provider_request_id = _provider_request_id(response_obj)
        if elapsed_ms is not None:
            event["elapsedMs"] = elapsed_ms
        if first_token_ms is not None:
            event["firstTokenMs"] = first_token_ms
        if provider_request_id:
            event["providerRequestId"] = provider_request_id
        _emit(event)

    async def async_log_failure_event(
        self,
        kwargs: dict[str, Any],
        response_obj: Any,
        start_time: Any,
        end_time: Any,
    ) -> None:
        event = _base_event("provider_failure", kwargs)
        elapsed_ms = _elapsed_ms(start_time, end_time)
        status_code = _safe_integer(
            _first(response_obj, [("status_code",), ("status",)])
        )
        error_code = _safe_string(
            _first(response_obj, [("code",), ("error", "code")])
        )
        if elapsed_ms is not None:
            event["elapsedMs"] = elapsed_ms
        if status_code is not None:
            event["statusCode"] = status_code
        if error_code:
            event["errorCode"] = error_code
        event["errorType"] = type(response_obj).__name__[:MAX_SAFE_VALUE_CHARS]
        provider_request_id = _provider_request_id(response_obj)
        if provider_request_id:
            event["providerRequestId"] = provider_request_id
        _emit(event)

    async def async_post_call_failure_hook(
        self,
        request_data: dict[str, Any],
        original_exception: Exception,
        user_api_key_dict: Any,
        traceback_str: Optional[str] = None,
    ) -> None:
        event = _base_event("proxy_failure", request_data)
        status_code = _safe_integer(getattr(original_exception, "status_code", None))
        error_code = _safe_string(getattr(original_exception, "code", None))
        if status_code is not None:
            event["statusCode"] = status_code
        if error_code:
            event["errorCode"] = error_code
        event["errorType"] = type(original_exception).__name__[:MAX_SAFE_VALUE_CHARS]
        _emit(event)


boundary_logger = BurbleBoundaryLogger()
