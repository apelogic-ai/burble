import type { JiraToolDeps } from "../tools/jira";
import type { UpstreamMcpToolResult } from "./upstream-http-client";

export async function verifyJiraAuthForOpaqueAtlassianMcpError(
  result: UpstreamMcpToolResult,
  accessToken: string,
  deps: Pick<JiraToolDeps, "getJiraUser">
): Promise<void> {
  if (!isOpaqueAtlassianMcpError(result)) {
    return;
  }

  await deps.getJiraUser(accessToken);
}

function isOpaqueAtlassianMcpError(result: UpstreamMcpToolResult): boolean {
  if (!result.isError || !Array.isArray(result.content)) {
    return false;
  }

  return result.content.some((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const text = (item as { type?: unknown; text?: unknown }).text;
    return (
      typeof text === "string" &&
      text.includes("We are having trouble completing this action")
    );
  });
}
