import { formatLogLine } from "../logging";
import type { UpstreamMcpToolResult } from "./upstream-http-client";

export function logAtlassianMcpCallStart(
  transport: string,
  runtimeId: string,
  toolName: string,
  args: Record<string, unknown> | undefined
): void {
  console.info(
    formatLogLine(
      "info",
      `Atlassian MCP call start transport=${transport} runtimeId=${runtimeId} tool=${toolName}${summarizeMcpArgumentKeys(args)}`
    )
  );
}

export function logAtlassianMcpCallFinish(
  transport: string,
  runtimeId: string,
  toolName: string,
  result: UpstreamMcpToolResult
): void {
  console.info(
    formatLogLine(
      "info",
      `Atlassian MCP call finish transport=${transport} runtimeId=${runtimeId} tool=${toolName}${summarizeUpstreamMcpToolResult(result)}`
    )
  );
}

export function logAtlassianMcpCallFailure(
  transport: string,
  runtimeId: string,
  toolName: string,
  error: unknown
): void {
  console.error(
    formatLogLine(
      "error",
      `Atlassian MCP call failed transport=${transport} runtimeId=${runtimeId} tool=${toolName} error=${JSON.stringify(summarizeError(error))}`
    )
  );
}

function summarizeMcpArgumentKeys(
  args: Record<string, unknown> | undefined
): string {
  const keys = args ? Object.keys(args).sort() : [];
  return keys.length > 0 ? ` argKeys=${keys.join(",")}` : " argKeys=none";
}

function summarizeUpstreamMcpToolResult(result: UpstreamMcpToolResult): string {
  const firstText = result.content
    ?.map((item) =>
      item &&
      typeof item === "object" &&
      "type" in item &&
      item.type === "text" &&
      "text" in item &&
      typeof item.text === "string"
        ? item.text
        : null
    )
    .find((text): text is string => text !== null);
  const text = firstText?.trim().replace(/\s+/g, " ");
  return [
    ` isError=${result.isError === true}`,
    text ? ` text=${JSON.stringify(truncateLogValue(text, 300))}` : ""
  ].join("");
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return truncateLogValue(error.message, 300);
  }

  return truncateLogValue(String(error), 300);
}

function truncateLogValue(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 3)}...`;
}

