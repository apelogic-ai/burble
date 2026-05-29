import { readFileSync } from "node:fs";
import YAML from "yaml";
import {
  loadProviderToolSpecs,
  type ProviderToolSpec
} from "../tool-specs";

export const atlassianProviderToolSpecs: ProviderToolSpec[] =
  loadProviderToolSpecs(new URL("./tools.yaml", import.meta.url));

export const allowedMutatingAtlassianMcpTools = new Set(
  readAtlassianPolicy(new URL("./policy.yaml", import.meta.url)).allowedMutatingTools
);

type AtlassianPolicy = {
  allowedMutatingTools: string[];
};

function readAtlassianPolicy(url: URL): AtlassianPolicy {
  const parsed = YAML.parse(readFileSync(url, "utf8")) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.allowedMutatingTools)) {
    throw new Error(`${url.pathname} must define allowedMutatingTools`);
  }

  const allowedMutatingTools = parsed.allowedMutatingTools.map((tool, index) => {
    if (typeof tool !== "string" || tool.length === 0) {
      throw new Error(
        `${url.pathname}.allowedMutatingTools[${index}] must be a non-empty string`
      );
    }
    return tool.trim().toLowerCase();
  });

  return { allowedMutatingTools };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
