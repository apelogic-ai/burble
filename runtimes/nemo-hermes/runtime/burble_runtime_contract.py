from __future__ import annotations

import json
import os
from copy import deepcopy
from pathlib import Path
from typing import Any


DEFAULT_SCHEMA_PATH = Path("/runtime/runtime-contract.schema.json")
SCHEMA_ENV = "BURBLE_RUNTIME_CONTRACT_SCHEMA_PATH"


class ContractValidationError(ValueError):
    pass


_schema_cache: dict[str, Any] | None = None


def load_runtime_contract_schema(path: str | Path | None = None) -> dict[str, Any]:
    global _schema_cache
    selected_path = Path(path or os.getenv(SCHEMA_ENV, "") or default_schema_path())
    cache_key = str(selected_path)
    if _schema_cache is not None and _schema_cache.get("_path") == cache_key:
        return _schema_cache["schema"]

    with selected_path.open("r", encoding="utf-8") as schema_file:
        schema = json.load(schema_file)
    if not isinstance(schema, dict) or not isinstance(schema.get("schemas"), dict):
        raise ContractValidationError("runtime contract schema is missing schemas")

    _schema_cache = {"_path": cache_key, "schema": schema}
    return schema


def default_schema_path() -> Path:
    if DEFAULT_SCHEMA_PATH.exists():
        return DEFAULT_SCHEMA_PATH

    current = Path(__file__).resolve()
    for parent in current.parents:
        candidate = parent / "packages/runtime-sdk/schema/runtime-contract.schema.json"
        if candidate.exists():
            return candidate
    return DEFAULT_SCHEMA_PATH


def validate_runtime_run_request(value: Any) -> Any:
    return validate_runtime_contract_schema("RuntimeRunRequest", value)


def validate_runtime_run_event(value: Any) -> Any:
    return validate_runtime_contract_schema("RuntimeRunEvent", value)


def validate_runtime_capability_manifest(value: Any) -> Any:
    return validate_runtime_contract_schema("RuntimeCapabilityManifest", value)


def validate_runtime_contract_schema(name: str, value: Any) -> Any:
    schema = load_runtime_contract_schema()
    schema_def = schema["schemas"].get(name)
    if not isinstance(schema_def, dict):
        raise ContractValidationError(f"runtime contract schema {name} not found")
    _validate(schema_def, value, name, schema)
    return value


def _validate(schema: dict[str, Any], value: Any, path: str, root: dict[str, Any]) -> None:
    if not schema:
        return

    ref = schema.get("$ref")
    if isinstance(ref, str):
        target = _resolve_ref(ref, root)
        _validate(target, value, path, root)
        return

    all_of = schema.get("allOf")
    if isinstance(all_of, list):
        for index, option in enumerate(all_of):
            if isinstance(option, dict):
                _validate(option, value, f"{path}.allOf[{index}]", root)

    one_of = schema.get("oneOf")
    if isinstance(one_of, list):
        discriminated = _matching_discriminated_schema(one_of, value)
        if discriminated is not None:
            _validate(discriminated, value, path, root)
            return

        errors: list[str] = []
        matches = 0
        for option in one_of:
            if not isinstance(option, dict):
                continue
            try:
                _validate(option, value, path, root)
            except ContractValidationError as error:
                errors.append(str(error))
            else:
                matches += 1
        if matches != 1:
            detail = errors[0] if errors else f"matched {matches} variants"
            raise ContractValidationError(f"{path}: expected exactly one schema match ({detail})")
        return

    expected_type = schema.get("type")
    if isinstance(expected_type, str):
        _validate_type(expected_type, value, path)

    if "const" in schema and value != schema["const"]:
        raise ContractValidationError(f"{path}: expected {schema['const']!r}")

    enum_values = schema.get("enum")
    if isinstance(enum_values, list) and value not in enum_values:
        raise ContractValidationError(f"{path}: expected one of {', '.join(map(str, enum_values))}")

    if isinstance(value, str):
        min_length = schema.get("minLength")
        if isinstance(min_length, int) and len(value) < min_length:
            raise ContractValidationError(f"{path}: expected at least {min_length} characters")

    if _is_number(value):
        minimum = schema.get("minimum")
        if _is_number(minimum) and value < minimum:
            raise ContractValidationError(f"{path}: expected >= {minimum}")
        maximum = schema.get("maximum")
        if _is_number(maximum) and value > maximum:
            raise ContractValidationError(f"{path}: expected <= {maximum}")

    if isinstance(value, list):
        min_items = schema.get("minItems")
        if isinstance(min_items, int) and len(value) < min_items:
            raise ContractValidationError(f"{path}: expected at least {min_items} items")
        items = schema.get("items")
        if isinstance(items, dict):
            for index, item in enumerate(value):
                _validate(items, item, f"{path}[{index}]", root)

    if isinstance(value, dict):
        _validate_object(schema, value, path, root)


def _validate_object(
    schema: dict[str, Any],
    value: dict[str, Any],
    path: str,
    root: dict[str, Any],
) -> None:
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        properties = {}

    for key, property_schema in properties.items():
        if (
            key not in value
            and isinstance(property_schema, dict)
            and "default" in property_schema
        ):
            value[key] = deepcopy(property_schema["default"])

    required = schema.get("required")
    if isinstance(required, list):
        for key in required:
            if isinstance(key, str) and key not in value:
                raise ContractValidationError(f"{path}.{key}: required")

    property_names = schema.get("propertyNames")
    if isinstance(property_names, dict):
        for key in value:
            _validate(property_names, key, f"{path}.{key}", root)

    for key, property_schema in properties.items():
        if key in value and isinstance(property_schema, dict):
            _validate(property_schema, value[key], f"{path}.{key}", root)

    additional = schema.get("additionalProperties", True)
    for key, item in value.items():
        if key in properties:
            continue
        if additional is False:
            raise ContractValidationError(f"{path}: additional property {key}")
        if isinstance(additional, dict):
            _validate(additional, item, f"{path}.{key}", root)


def _resolve_ref(ref: str, root: dict[str, Any]) -> dict[str, Any]:
    if ref.startswith("#/"):
        target: Any = root
        for part in ref.removeprefix("#/").split("/"):
            if not isinstance(target, dict):
                break
            target = target.get(part)
        if isinstance(target, dict):
            return target
    target = root.get("schemas", {}).get(ref)
    if isinstance(target, dict):
        return target
    raise ContractValidationError(f"unresolved schema ref {ref}")


def _matching_discriminated_schema(
    options: list[Any],
    value: Any,
) -> dict[str, Any] | None:
    if not isinstance(value, dict) or "type" not in value:
        return None
    for option in options:
        if not isinstance(option, dict):
            continue
        properties = option.get("properties")
        if not isinstance(properties, dict):
            continue
        type_schema = properties.get("type")
        if isinstance(type_schema, dict) and type_schema.get("const") == value.get("type"):
            return option
    return None


def _validate_type(expected_type: str, value: Any, path: str) -> None:
    if expected_type == "object" and not isinstance(value, dict):
        raise ContractValidationError(f"{path}: expected object")
    if expected_type == "array" and not isinstance(value, list):
        raise ContractValidationError(f"{path}: expected array")
    if expected_type == "string" and not isinstance(value, str):
        raise ContractValidationError(f"{path}: expected string")
    if expected_type == "boolean" and not isinstance(value, bool):
        raise ContractValidationError(f"{path}: expected boolean")
    if expected_type == "integer" and not (isinstance(value, int) and not isinstance(value, bool)):
        raise ContractValidationError(f"{path}: expected integer")
    if expected_type == "number" and not _is_number(value):
        raise ContractValidationError(f"{path}: expected number")


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)
