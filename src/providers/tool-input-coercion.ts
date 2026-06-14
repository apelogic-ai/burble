import { createHash } from "node:crypto";
import { providerToolCatalog } from "./catalog";
import type { ProviderToolInputSpec, ProviderToolSpec } from "./tool-specs";

export type ProviderToolInputCoercionResult =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; error: string };

export function coerceProviderToolGatewayInput(
  toolName: string,
  input: unknown
): ProviderToolInputCoercionResult {
  const tool = providerToolCatalog.find(
    (candidate) =>
      candidate.name === toolName ||
      candidate.alias === toolName ||
      candidate.aliases?.includes(toolName)
  );
  if (!tool) {
    return { ok: true, input: isRecord(input) ? input : {} };
  }

  const source = readProviderToolInput(input);
  const coerced = coerceProviderToolInput(source, tool);
  return coerced.ok
    ? { ok: true, input: postProcessProviderToolInput(tool, coerced.input) }
    : coerced;
}

function coerceProviderToolInput(
  input: Record<string, unknown> | null,
  tool: ProviderToolSpec
): ProviderToolInputCoercionResult {
  if (Object.keys(tool.input).length === 0) {
    return { ok: true, input: input ?? {} };
  }

  const output: Record<string, unknown> = input ? { ...input } : {};
  for (const [name, spec] of Object.entries(tool.input)) {
    const result = readInputField(input, name, spec);
    if (result.invalid) {
      output[name] = result.raw;
      deleteInputAliases(output, name, spec);
      continue;
    }
    if (result.value !== undefined) {
      output[name] = result.value;
      deleteInputAliases(output, name, spec);
    }
  }
  return { ok: true, input: output };
}

function readInputField(
  input: Record<string, unknown> | null,
  name: string,
  spec: ProviderToolInputSpec
): { value: unknown; invalid: boolean; raw?: unknown } {
  if (!input) {
    return { value: undefined, invalid: false };
  }

  let invalidRaw: unknown;
  for (const key of inputFieldKeys(name, spec)) {
    if (Object.hasOwn(input, key)) {
      const raw = input[key];
      const value = coerceInputValue(raw, spec);
      if (value !== undefined) {
        return { value, invalid: false };
      }
      invalidRaw = raw;
    }
  }
  return invalidRaw !== undefined
    ? { value: undefined, invalid: true, raw: invalidRaw }
    : { value: undefined, invalid: false };
}

function inputFieldKeys(name: string, spec: ProviderToolInputSpec): string[] {
  return uniqueStrings([
    name,
    snakeCase(name),
    ...(spec.aliases ?? [])
  ]);
}

function deleteInputAliases(
  output: Record<string, unknown>,
  name: string,
  spec: ProviderToolInputSpec
): void {
  for (const key of inputFieldKeys(name, spec)) {
    if (key !== name) {
      delete output[key];
    }
  }
}

function coerceInputValue(value: unknown, spec: ProviderToolInputSpec): unknown {
  if (value === null) {
    return spec.nullable ? null : undefined;
  }
  if (value === undefined) {
    return undefined;
  }

  switch (spec.type) {
    case "string":
      return typeof value === "string" && value.trim() ? value : undefined;
    case "number":
      return coerceNumberValue(value, spec);
    case "boolean":
      return coerceBooleanValue(value);
    case "enum":
      return typeof value === "string" && value.trim()
        ? spec.values.includes(value.trim())
          ? value.trim()
          : undefined
        : undefined;
    case "array":
      return coerceArrayValue(value, spec);
    case "object":
      return coerceObjectValue(value, spec);
  }
}

function coerceNumberValue(
  value: unknown,
  spec: Extract<ProviderToolInputSpec, { type: "number" }>
): number | undefined {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(number)) {
    return undefined;
  }
  if (spec.int && !Number.isInteger(number)) {
    return undefined;
  }
  return number;
}

function coerceBooleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return undefined;
}

function coerceArrayValue(
  value: unknown,
  spec: Extract<ProviderToolInputSpec, { type: "array" }>
): unknown[] | undefined {
  const values = Array.isArray(value) ? value : [value];
  if (!Array.isArray(value) && value === undefined) {
    return undefined;
  }
  const items = values
    .map((item) =>
      spec.items === "string"
        ? coerceStringArrayItem(item)
        : coerceObjectValue(item, spec.items)
    )
    .filter((item) => item !== undefined);
  if (items.length !== values.length) {
    return undefined;
  }
  if (spec.min !== undefined && items.length < spec.min) {
    return undefined;
  }
  if (spec.max !== undefined && items.length > spec.max) {
    return undefined;
  }
  return items;
}

function coerceStringArrayItem(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function coerceObjectValue(
  value: unknown,
  spec: Extract<ProviderToolInputSpec, { type: "object" }>
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (!spec.properties) {
    return value;
  }

  const output: Record<string, unknown> = { ...value };
  for (const [name, child] of Object.entries(spec.properties)) {
    const result = readInputField(value, name, child);
    if (result.invalid) {
      output[name] = result.raw;
      deleteInputAliases(output, name, child);
      continue;
    }
    if (result.value === undefined) {
      if (!child.optional) {
        return undefined;
      }
      continue;
    }
    output[name] = result.value;
    deleteInputAliases(output, name, child);
  }
  return output;
}

function postProcessProviderToolInput(
  tool: ProviderToolSpec,
  input: Record<string, unknown>
): Record<string, unknown> {
  if (tool.alias === "google.slidesCreateSlide") {
    return postProcessGoogleSlidesCreateSlide(input);
  }
  if (tool.alias === "google.slidesFillPlaceholders") {
    return postProcessGoogleSlidesFillPlaceholders(input);
  }
  return input;
}

function postProcessGoogleSlidesCreateSlide(
  input: Record<string, unknown>
): Record<string, unknown> {
  const replacements = normalizeSlidesReplacements(input);
  const normalized: Record<string, unknown> = {
    ...input,
    ...(typeof input.predefinedLayout === "string"
      ? { predefinedLayout: input.predefinedLayout.trim().toUpperCase() }
      : {}),
    ...(replacements ? { replacements } : {})
  };
  delete normalized.placeholderType;
  delete normalized.text;
  delete normalized.index;
  delete normalized.title;
  delete normalized.subtitle;
  delete normalized.body;

  if (typeof normalized.objectId === "string" || typeof input.presentationId !== "string") {
    return normalized;
  }
  return {
    ...normalized,
    objectId: deterministicGoogleSlidesObjectId(normalized)
  };
}

function postProcessGoogleSlidesFillPlaceholders(
  input: Record<string, unknown>
): Record<string, unknown> {
  const replacements = normalizeSlidesReplacements(input);
  const normalized: Record<string, unknown> = {
    ...input,
    ...(replacements ? { replacements } : {})
  };
  delete normalized.placeholderType;
  delete normalized.text;
  delete normalized.index;
  delete normalized.title;
  delete normalized.subtitle;
  delete normalized.body;
  return normalized;
}

function normalizeSlidesReplacements(
  input: Record<string, unknown>
): Array<Record<string, unknown>> | undefined {
  const raw = input.replacements;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map(normalizeSlidesReplacement);
  }
  if (isRecord(raw)) {
    return [normalizeSlidesReplacement(raw)];
  }

  const topLevel = normalizeSlidesReplacement(input);
  if (isRecord(topLevel) && topLevel.placeholderType !== undefined) {
    return [topLevel];
  }

  const replacements: Array<Record<string, unknown>> = [];
  for (const [key, placeholderType] of [
    ["title", "TITLE"],
    ["subtitle", "SUBTITLE"],
    ["body", "BODY"]
  ] as const) {
    const text = input[key];
    if (typeof text === "string") {
      replacements.push({ placeholderType, text });
    }
  }
  return replacements.length ? replacements : undefined;
}

function normalizeSlidesReplacement(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  const output: Record<string, unknown> = {};
  if (typeof value.placeholderType === "string") {
    output.placeholderType = value.placeholderType.trim().toUpperCase();
  }
  if (typeof value.text === "string") {
    output.text = value.text;
  }
  if (typeof value.index === "number") {
    output.index = value.index;
  }
  return output;
}

function readProviderToolInput(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input)) {
    return null;
  }
  const keys = Object.keys(input);
  if (
    keys.length === 1 &&
    (keys[0] === "input" || keys[0] === "arguments" || keys[0] === "params")
  ) {
    const nested = input[keys[0]];
    return isRecord(nested) ? nested : input;
  }
  return input;
}

function deterministicGoogleSlidesObjectId(input: unknown): string {
  return `burble_slide_${createHash("sha256")
    .update(stableJson(input))
    .digest("hex")
    .slice(0, 32)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
