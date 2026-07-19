import { readFileSync } from "node:fs";
import YAML from "yaml";
import * as z from "zod/v4";

export type ProviderToolSpec = {
  provider: string;
  name: string;
  alias: string;
  aliases?: string[];
  implementation: string;
  title: string;
  description: string;
  risk?: ProviderToolRisk;
  confirmation?: ProviderToolConfirmation;
  retrySafe?: boolean;
  grantCoverage?: "provider";
  input: Record<string, ProviderToolInputSpec>;
};

export type ProviderToolRisk =
  | "read"
  | "low_write"
  | "moderate_write"
  | "high_write";

export type ProviderToolConfirmation = "none" | "explicit" | "strong";

export type ProviderToolInputSpec =
  | ProviderStringInputSpec
  | ProviderNumberInputSpec
  | ProviderBooleanInputSpec
  | ProviderEnumInputSpec
  | ProviderArrayInputSpec
  | ProviderObjectInputSpec;

type BaseInputSpec = {
  optional?: boolean;
  nullable?: boolean;
  description?: string;
  aliases?: string[];
};

type ProviderStringInputSpec = BaseInputSpec & {
  type: "string";
  format?: "email";
  min?: number;
  max?: number;
};

type ProviderNumberInputSpec = BaseInputSpec & {
  type: "number";
  int?: boolean;
  min?: number;
  max?: number;
  positive?: boolean;
};

type ProviderBooleanInputSpec = BaseInputSpec & {
  type: "boolean";
};

type ProviderEnumInputSpec = BaseInputSpec & {
  type: "enum";
  values: string[];
};

type ProviderArrayInputSpec = BaseInputSpec & {
  type: "array";
  items: "string" | ProviderObjectInputSpec;
  itemFormat?: "email";
  min?: number;
  max?: number;
  itemMin?: number;
  itemMax?: number;
};

type ProviderObjectInputSpec = BaseInputSpec & {
  type: "object";
  properties?: Record<string, ProviderToolInputSpec>;
};

type ProviderToolSpecDocument = {
  provider: string;
  tools: Array<Omit<ProviderToolSpec, "provider">>;
};

export function loadProviderToolSpecs(url: URL): ProviderToolSpec[] {
  const text = readFileSync(url, "utf8");
  const parsed = YAML.parse(text) as unknown;
  const document = parseProviderToolSpecDocument(parsed, url.pathname);

  return document.tools.map((tool) => ({
    provider: document.provider,
    ...tool
  }));
}

export function providerToolInputSchema(
  tool: ProviderToolSpec
): Record<string, z.ZodType> {
  return Object.fromEntries(
    Object.entries(tool.input).map(([name, spec]) => [name, zodForInputSpec(spec)])
  );
}

function zodForInputSpec(spec: ProviderToolInputSpec): z.ZodType {
  let schema: z.ZodType;

  switch (spec.type) {
    case "string": {
      let stringSchema = z.string();
      if (spec.format === "email") stringSchema = stringSchema.email();
      if (spec.min !== undefined) stringSchema = stringSchema.min(spec.min);
      if (spec.max !== undefined) stringSchema = stringSchema.max(spec.max);
      schema = stringSchema;
      break;
    }
    case "number": {
      let numberSchema = z.number();
      if (spec.int) numberSchema = numberSchema.int();
      if (spec.positive) numberSchema = numberSchema.positive();
      if (spec.min !== undefined) numberSchema = numberSchema.min(spec.min);
      if (spec.max !== undefined) numberSchema = numberSchema.max(spec.max);
      schema = numberSchema;
      break;
    }
    case "boolean":
      schema = z.boolean();
      break;
    case "enum":
      if (spec.values.length === 0) {
        throw new Error("Provider enum input spec must include at least one value");
      }
      schema = z.enum(spec.values as [string, ...string[]]);
      break;
    case "array": {
      let itemSchema: z.ZodType;
      if (spec.items === "string") {
        let stringSchema = z.string();
        if (spec.itemFormat === "email") stringSchema = stringSchema.email();
        if (spec.itemMin !== undefined) stringSchema = stringSchema.min(spec.itemMin);
        if (spec.itemMax !== undefined) stringSchema = stringSchema.max(spec.itemMax);
        itemSchema = stringSchema;
      } else {
        itemSchema = zodForInputSpec(spec.items);
      }

      let arraySchema = z.array(itemSchema);
      if (spec.min !== undefined) arraySchema = arraySchema.min(spec.min);
      if (spec.max !== undefined) arraySchema = arraySchema.max(spec.max);
      schema = arraySchema;
      break;
    }
    case "object":
      schema = spec.properties
        ? z.object(
            Object.fromEntries(
              Object.entries(spec.properties).map(([name, child]) => [
                name,
                zodForInputSpec(child)
              ])
            )
          )
        : z.record(z.string(), z.unknown());
      break;
  }

  if (spec.description) {
    schema = schema.describe(spec.description);
  }

  if (spec.nullable) {
    schema = schema.nullable();
  }

  return spec.optional ? schema.optional() : schema;
}

function parseProviderToolSpecDocument(
  parsed: unknown,
  source: string
): ProviderToolSpecDocument {
  if (!isRecord(parsed)) {
    throw new Error(`Provider tool spec ${source} must be a mapping`);
  }
  const provider = readRequiredString(parsed, "provider", source);
  const tools = parsed.tools;
  if (!Array.isArray(tools)) {
    throw new Error(`Provider tool spec ${source} must include a tools array`);
  }

  return {
    provider,
    tools: tools.map((tool, index) =>
      parseProviderToolSpec(tool, `${source}:tools[${index}]`)
    )
  };
}

function parseProviderToolSpec(
  parsed: unknown,
  source: string
): Omit<ProviderToolSpec, "provider"> {
  if (!isRecord(parsed)) {
    throw new Error(`Provider tool spec ${source} must be a mapping`);
  }

  const input = parsed.input ?? {};
  if (!isRecord(input)) {
    throw new Error(`Provider tool spec ${source}.input must be a mapping`);
  }

  return {
    name: readRequiredString(parsed, "name", source),
    alias: readRequiredString(parsed, "alias", source),
    aliases: readOptionalStringArray(parsed, "aliases", source),
    implementation: readRequiredString(parsed, "implementation", source),
    title: readRequiredString(parsed, "title", source),
    description: readRequiredString(parsed, "description", source),
    risk: readOptionalStringEnum(parsed, "risk", source, [
      "read",
      "low_write",
      "moderate_write",
      "high_write"
    ]),
    confirmation: readOptionalStringEnum(parsed, "confirmation", source, [
      "none",
      "explicit",
      "strong"
    ]),
    retrySafe: readOptionalBoolean(parsed, "retrySafe", source),
    grantCoverage: readOptionalStringEnum(parsed, "grantCoverage", source, [
      "provider"
    ]),
    input: Object.fromEntries(
      Object.entries(input).map(([name, spec]) => [
        name,
        parseInputSpec(spec, `${source}.input.${name}`)
      ])
    )
  };
}

function parseInputSpec(parsed: unknown, source: string): ProviderToolInputSpec {
  if (!isRecord(parsed)) {
    throw new Error(`Provider input spec ${source} must be a mapping`);
  }

  const type = readRequiredString(parsed, "type", source);
  const base = {
    optional: readOptionalBoolean(parsed, "optional", source),
    nullable: readOptionalBoolean(parsed, "nullable", source),
    description: readOptionalString(parsed, "description", source),
    aliases: readOptionalStringArray(parsed, "aliases", source)
  };

  switch (type) {
    case "string":
      return {
        ...base,
        type,
        format: readOptionalStringEnum(parsed, "format", source, ["email"]),
        min: readOptionalNumber(parsed, "min", source),
        max: readOptionalNumber(parsed, "max", source)
      };
    case "number":
      return {
        ...base,
        type,
        int: readOptionalBoolean(parsed, "int", source),
        min: readOptionalNumber(parsed, "min", source),
        max: readOptionalNumber(parsed, "max", source),
        positive: readOptionalBoolean(parsed, "positive", source)
      };
    case "boolean":
      return { ...base, type };
    case "enum": {
      const values = parsed.values;
      if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
        throw new Error(`Provider enum input spec ${source}.values must be string[]`);
      }
      return { ...base, type, values };
    }
    case "array": {
      const rawItems = parsed.items;
      const items =
        typeof rawItems === "string"
          ? rawItems
          : isRecord(rawItems)
            ? parseInputSpec(rawItems, `${source}.items`)
            : null;
      if (
        items !== "string" &&
        !(typeof items === "object" && items !== null && items.type === "object")
      ) {
        throw new Error(
          `Provider array input spec ${source}.items must be string or object`
        );
      }
      return {
        ...base,
        type,
        items,
        itemFormat: readOptionalStringEnum(parsed, "itemFormat", source, ["email"]),
        min: readOptionalNumber(parsed, "min", source),
        max: readOptionalNumber(parsed, "max", source),
        itemMin: readOptionalNumber(parsed, "itemMin", source),
        itemMax: readOptionalNumber(parsed, "itemMax", source)
      };
    }
    case "object":
      return {
        ...base,
        type,
        properties: parseOptionalInputProperties(parsed, `${source}.properties`)
      };
    default:
      throw new Error(`Unsupported provider input spec type ${type} at ${source}`);
  }
}

function parseOptionalInputProperties(
  parsed: Record<string, unknown>,
  source: string
): Record<string, ProviderToolInputSpec> | undefined {
  const value = parsed.properties;
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${source} must be a mapping`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, child]) => [
      name,
      parseInputSpec(child, `${source}.${name}`)
    ])
  );
}

function readRequiredString(
  record: Record<string, unknown>,
  key: string,
  source: string
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${source}.${key} must be a non-empty string`);
  }
  return value;
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  source: string
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${source}.${key} must be a string`);
  }
  return value;
}

function readOptionalStringEnum<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  source: string,
  allowed: T
): T[number] | undefined {
  const value = readOptionalString(record, key, source);
  if (value === undefined) return undefined;
  if (!allowed.includes(value)) {
    throw new Error(`${source}.${key} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function readOptionalStringArray(
  record: Record<string, unknown>,
  key: string,
  source: string
): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new Error(`${source}.${key} must be a non-empty string array`);
  }
  return value.map((item) => item.trim());
}

function readOptionalNumber(
  record: Record<string, unknown>,
  key: string,
  source: string
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number") {
    throw new Error(`${source}.${key} must be a number`);
  }
  return value;
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  source: string
): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${source}.${key} must be a boolean`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
