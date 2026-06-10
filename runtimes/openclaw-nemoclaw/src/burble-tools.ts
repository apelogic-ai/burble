import type { RuntimeConfig } from "./config";
import { info } from "./logger";
import type {
  ConversationAttachment,
  RunRequest,
  ToolExecutor,
  ToolResult
} from "./types";

export function createBurbleToolExecutor(
  config: RuntimeConfig,
  runtimeId?: string,
  request?: RunRequest
): ToolExecutor {
  return createBurbleMcpToolExecutor(config, runtimeId, request);
}

function createBurbleMcpToolExecutor(
  config: RuntimeConfig,
  runtimeId?: string,
  request?: RunRequest
): ToolExecutor {
  let sessionIdPromise: Promise<string> | null = null;
  return async (toolName, body) => {
    const bridgeCall = isBurbleProviderBridgeTool(toolName)
      ? readBurbleProviderBridgeCall(body)
      : null;
    const actualToolName = bridgeCall?.toolName ?? toolName;
    const actualBody = bridgeCall ? { input: bridgeCall.input } : body;

    if (actualToolName === "conversation.sendMessage") {
      return sendConversationMessage(config, runtimeId, request, actualBody);
    }
    if (actualToolName === "conversation.getAttachment") {
      return getConversationAttachment(config, runtimeId, request, actualBody);
    }
    if (actualToolName === "scheduledJob.registerCapability") {
      return registerScheduledJobCapability(config, runtimeId, actualBody);
    }
    if (!config.mcpGatewayUrl || !config.runtimeJwt) {
      throw new Error(
        "Burble MCP gateway URL and runtime JWT are required for provider tools"
      );
    }

    sessionIdPromise ??= initializeMcpSession(config);
    if (actualToolName === "burble.mcp.listTools") {
      const sessionId = await sessionIdPromise;
      return listBurbleMcpTools(config, sessionId);
    }

    const mcpToolName = toMcpToolName(actualToolName, request);
    const args = toMcpToolArguments(actualToolName, actualBody);
    const sessionId = await sessionIdPromise;
    info(`Burble MCP tool start tool=${mcpToolName}${summarizeLogObject("args", args)}`);

    const response = await fetch(config.mcpGatewayUrl!, {
      method: "POST",
      headers: {
        ...mcpHeaders(config),
        "mcp-session-id": sessionId
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: {
          name: mcpToolName,
          arguments: args
        }
      })
    });

    if (!response.ok) {
      throw new Error(
        `Burble MCP gateway returned HTTP ${response.status}${await readErrorDetail(response)}`
      );
    }

    const result = await readMcpToolResult(response);
    info(
      `Burble MCP tool finish tool=${mcpToolName} classification=${result.classification}${summarizeLogObject("result", result.content)}`
    );
    return result;
  };
}

const BURBLE_PROVIDER_BRIDGE_TOOL = "burble_provider_call";
const BURBLE_PROVIDER_BRIDGE_COMPAT_TOOL = "burble.providerCall";

function isBurbleProviderBridgeTool(toolName: string): boolean {
  return toolName === BURBLE_PROVIDER_BRIDGE_TOOL ||
    toolName === BURBLE_PROVIDER_BRIDGE_COMPAT_TOOL;
}

function readBurbleProviderBridgeCall(body: unknown): {
  toolName: string;
  input: Record<string, unknown>;
} {
  const source = readRecordKey(body, "input");
  if (!source) {
    throw new Error("burble_provider_call requires input to be an object");
  }
  const toolName = readProviderBridgeToolName(source);
  const input =
    readRecordKey(source, "input") ??
    readRecordKey(source, "arguments") ??
    {};
  return { toolName, input };
}

function readProviderBridgeToolName(
  source: Record<string, unknown> | null
): string {
  const raw = source?.toolName;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("burble_provider_call requires input.toolName");
  }
  return raw.trim();
}

async function sendConversationMessage(
  config: RuntimeConfig,
  runtimeId: string | undefined,
  request: RunRequest | undefined,
  body: unknown
): Promise<ToolResult> {
  if (!runtimeId) {
    throw new Error("conversation.sendMessage requires a runtime id");
  }
  const text = readNestedText(body, "input", "text");
  const attachments = readNestedAttachments(body, "input", "attachments");
  if (!text && !attachments?.length) {
    throw new Error("conversation.sendMessage requires input.text or input.attachments");
  }
  const routeId =
    readNestedString(body, "input", "routeId") ??
    request?.input.conversation?.routeId;
  if (!routeId && !request?.input.conversation) {
    throw new Error("conversation.sendMessage requires a route id or active conversation");
  }

  const input = {
    text: text ?? "",
    ...(routeId ? { routeId } : {}),
    ...(attachments ? { attachments } : {})
  };
  info(
    `Burble conversation tool start tool=conversation.sendMessage${summarizeLogObject("input", input)}`
  );

  const response = await fetch(
    `${config.toolGatewayUrl}/${encodeURIComponent("conversation.sendMessage")}/execute`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.internalToken}`,
        "x-burble-runtime-id": runtimeId
      },
      body: JSON.stringify({
        input,
        ...(request?.input.conversation
          ? { conversation: request.input.conversation }
          : {})
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      `Burble conversation gateway returned HTTP ${response.status}${await readErrorDetail(response)}`
    );
  }

  const result = (await response.json()) as unknown;
  if (!isToolResult(result)) {
    throw new Error("Burble conversation gateway returned invalid tool result");
  }

  info(
    `Burble conversation tool finish tool=conversation.sendMessage classification=${result.classification}${summarizeLogObject("result", result.content)}`
  );
  return result;
}

async function registerScheduledJobCapability(
  config: RuntimeConfig,
  runtimeId: string | undefined,
  body: unknown
): Promise<ToolResult> {
  if (!runtimeId) {
    throw new Error("scheduledJob.registerCapability requires a runtime id");
  }
  const input = readNestedObject(body, "input");
  if (!input) {
    throw new Error("scheduledJob.registerCapability requires input");
  }
  info(
    `Burble scheduled job tool start tool=scheduledJob.registerCapability${summarizeLogObject("input", input)}`
  );

  const response = await fetch(
    `${config.toolGatewayUrl}/${encodeURIComponent("scheduledJob.registerCapability")}/execute`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.internalToken}`,
        "x-burble-runtime-id": runtimeId
      },
      body: JSON.stringify({ input })
    }
  );

  if (!response.ok) {
    const errorResult = await readToolGatewayErrorResult(response.clone());
    if (errorResult) {
      info(
        `Burble scheduled job tool finish tool=scheduledJob.registerCapability status=${response.status} classification=${errorResult.classification}${summarizeLogObject("result", errorResult.content)}`
      );
      return errorResult;
    }
    throw new Error(
      `Burble scheduled job gateway returned HTTP ${response.status}${await readErrorDetail(response)}`
    );
  }

  const result = (await response.json()) as unknown;
  if (!isToolResult(result)) {
    throw new Error("Burble scheduled job gateway returned invalid tool result");
  }

  info(
    `Burble scheduled job tool finish tool=scheduledJob.registerCapability classification=${result.classification}${summarizeLogObject("result", result.content)}`
  );
  return result;
}

async function getConversationAttachment(
  config: RuntimeConfig,
  runtimeId: string | undefined,
  request: RunRequest | undefined,
  body: unknown
): Promise<ToolResult> {
  if (!runtimeId) {
    throw new Error("conversation.getAttachment requires a runtime id");
  }
  const attachmentId = readNestedString(body, "input", "attachmentId");
  if (!attachmentId) {
    throw new Error("conversation.getAttachment requires input.attachmentId");
  }

  const input = { attachmentId };
  info(
    `Burble conversation tool start tool=conversation.getAttachment${summarizeLogObject("input", input)}`
  );

  const response = await fetch(
    `${config.toolGatewayUrl}/${encodeURIComponent("conversation.getAttachment")}/execute`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.internalToken}`,
        "x-burble-runtime-id": runtimeId
      },
      body: JSON.stringify({
        ...(request?.runId ? { runId: request.runId } : {}),
        input,
        ...(request?.input.attachments
          ? { attachments: request.input.attachments }
          : {}),
        ...(request?.input.conversation
          ? { conversation: request.input.conversation }
          : {})
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      `Burble conversation gateway returned HTTP ${response.status}${await readErrorDetail(response)}`
    );
  }

  const result = (await response.json()) as unknown;
  if (!isToolResult(result)) {
    throw new Error("Burble conversation gateway returned invalid tool result");
  }

  info(
    `Burble conversation tool finish tool=conversation.getAttachment classification=${result.classification}${summarizeLogObject("result", result.content)}`
  );
  return result;
}

async function listBurbleMcpTools(
  config: RuntimeConfig,
  sessionId: string
): Promise<ToolResult> {
  info("Burble MCP tools/list start");
  const response = await fetch(config.mcpGatewayUrl!, {
    method: "POST",
    headers: {
      ...mcpHeaders(config),
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/list"
    })
  });

  if (!response.ok) {
    throw new Error(
      `Burble MCP tools/list returned HTTP ${response.status}${await readErrorDetail(response)}`
    );
  }

  const tools = await readMcpToolsListResult(response);
  info(`Burble MCP tools/list finish count=${tools.length}`);
  return {
    classification: "user_private",
    content: tools
  };
}

async function initializeMcpSession(config: RuntimeConfig): Promise<string> {
  info("Burble MCP session initialize start");
  const response = await fetch(config.mcpGatewayUrl!, {
    method: "POST",
    headers: mcpHeaders(config),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "burble-openclaw-nemoclaw-runtime",
          version: "0.1.0"
        }
      }
    })
  });

  if (!response.ok) {
    throw new Error(
      `Burble MCP initialize returned HTTP ${response.status}${await readErrorDetail(response)}`
    );
  }

  const sessionId = response.headers.get("mcp-session-id")?.trim();
  if (!sessionId) {
    throw new Error("Burble MCP initialize did not return mcp-session-id");
  }

  await sendMcpInitializedNotification(config, sessionId);
  info("Burble MCP session initialize finish");
  return sessionId;
}

async function sendMcpInitializedNotification(
  config: RuntimeConfig,
  sessionId: string
): Promise<void> {
  const response = await fetch(config.mcpGatewayUrl!, {
    method: "POST",
    headers: {
      ...mcpHeaders(config),
      "mcp-session-id": sessionId
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized"
    })
  });

  if (!response.ok) {
    throw new Error(
      `Burble MCP initialized notification returned HTTP ${response.status}${await readErrorDetail(response)}`
    );
  }
}

function mcpHeaders(config: RuntimeConfig): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
    authorization: `Bearer ${config.runtimeJwt}`
  };
}

function toMcpToolName(
  toolName: string,
  request: RunRequest | undefined
): string {
  const manifestToolName = manifestToolNameToMcpToolName(toolName, request);
  if (manifestToolName) {
    return manifestToolName;
  }

  switch (toolName) {
    case "github_get_authenticated_user":
    case "github_list_assigned_issues":
    case "github_search_issues":
    case "github_list_my_pull_requests":
    case "github_get_issue":
    case "github_get_pr":
    case "github_create_issue":
    case "github_update_issue":
    case "github_close_issue":
    case "github_reopen_issue":
    case "github_comment_on_issue_or_pr":
    case "github_create_pr":
    case "github_update_pr":
    case "github_add_labels":
    case "github_remove_labels":
    case "github_request_review":
    case "github_get_file":
    case "github_create_or_update_file":
    case "github_create_branch":
    case "google_get_authenticated_user":
    case "google_search_drive_files":
    case "google_create_drive_text_file":
    case "google_get_drive_file":
    case "google_update_drive_text_file":
    case "google_append_to_drive_text_file":
    case "google_create_drive_folder":
    case "google_move_drive_file":
    case "google_search_calendar_events":
    case "google_create_calendar_event":
    case "google_update_calendar_event":
    case "google_search_mail_messages":
    case "google_slides_search_presentations":
    case "google_slides_get_presentation":
    case "google_slides_probe_template":
    case "google_slides_copy_presentation":
    case "google_slides_fill_placeholders":
    case "google_analytics_list_properties":
    case "google_analytics_get_metadata":
    case "google_analytics_run_report":
    case "gmail_create_draft":
    case "hubspot_get_authenticated_user":
    case "hubspot_search_contacts":
    case "hubspot_search_companies":
    case "hubspot_search_deals":
    case "hubspot_search_crm_objects":
    case "hubspot_list_owners":
    case "hubspot_list_users":
    case "hubspot_read_api_resource":
    case "jira_get_authenticated_user":
    case "jira_list_accessible_resources":
    case "jira_list_visible_projects":
    case "jira_search_users":
    case "jira_create_issue":
    case "jira_edit_issue":
    case "jira_get_issue":
    case "jira_update_issue":
    case "jira_add_comment":
    case "jira_transition_issue":
    case "jira_add_labels":
    case "jira_remove_labels":
    case "jira_link_issues":
    case "jira_create_subtask":
    case "jira_list_assigned_issues":
    case "jira_search_issues":
    case "slack_search_users":
    case "slack_search_messages":
    case "atlassian_list_mcp_tools":
    case "atlassian_call_mcp_tool":
      return toolName;
    case "github.getAuthenticatedUser":
      return "github_get_authenticated_user";
    case "github.listAssignedIssues":
      return "github_list_assigned_issues";
    case "github.searchIssues":
      return "github_search_issues";
    case "github.listMyPullRequests":
      return "github_list_my_pull_requests";
    case "github.getIssue":
      return "github_get_issue";
    case "github.getPullRequest":
      return "github_get_pr";
    case "github.createIssue":
      return "github_create_issue";
    case "github.updateIssue":
      return "github_update_issue";
    case "github.closeIssue":
      return "github_close_issue";
    case "github.reopenIssue":
      return "github_reopen_issue";
    case "github.commentOnIssueOrPullRequest":
      return "github_comment_on_issue_or_pr";
    case "github.createPullRequest":
      return "github_create_pr";
    case "github.updatePullRequest":
      return "github_update_pr";
    case "github.addLabels":
      return "github_add_labels";
    case "github.removeLabels":
      return "github_remove_labels";
    case "github.requestReview":
      return "github_request_review";
    case "github.getFile":
      return "github_get_file";
    case "github.createOrUpdateFile":
      return "github_create_or_update_file";
    case "github.createBranch":
      return "github_create_branch";
    case "google.getAuthenticatedUser":
      return "google_get_authenticated_user";
    case "google.searchDriveFiles":
      return "google_search_drive_files";
    case "google.createDriveTextFile":
      return "google_create_drive_text_file";
    case "google.getDriveFile":
      return "google_get_drive_file";
    case "google.updateDriveTextFile":
      return "google_update_drive_text_file";
    case "google.appendToDriveTextFile":
      return "google_append_to_drive_text_file";
    case "google.createDriveFolder":
      return "google_create_drive_folder";
    case "google.moveDriveFile":
      return "google_move_drive_file";
    case "google.searchCalendarEvents":
      return "google_search_calendar_events";
    case "google.createCalendarEvent":
      return "google_create_calendar_event";
    case "google.updateCalendarEvent":
      return "google_update_calendar_event";
    case "google.searchMailMessages":
      return "google_search_mail_messages";
    case "google.slidesSearchPresentations":
      return "google_slides_search_presentations";
    case "google.slidesGetPresentation":
      return "google_slides_get_presentation";
    case "google.slidesProbeTemplate":
      return "google_slides_probe_template";
    case "google.slidesCopyPresentation":
      return "google_slides_copy_presentation";
    case "google.slidesCreateSlide":
      return "google_slides_create_slide";
    case "google.slidesFillPlaceholders":
      return "google_slides_fill_placeholders";
    case "google.analyticsListProperties":
      return "google_analytics_list_properties";
    case "google.analyticsGetMetadata":
      return "google_analytics_get_metadata";
    case "google.analyticsRunReport":
      return "google_analytics_run_report";
    case "gmail.createDraft":
      return "gmail_create_draft";
    case "hubspot.getAuthenticatedUser":
      return "hubspot_get_authenticated_user";
    case "hubspot.searchContacts":
      return "hubspot_search_contacts";
    case "hubspot.searchCompanies":
      return "hubspot_search_companies";
    case "hubspot.searchDeals":
      return "hubspot_search_deals";
    case "hubspot.searchCrmObjects":
      return "hubspot_search_crm_objects";
    case "hubspot.listOwners":
      return "hubspot_list_owners";
    case "hubspot.listUsers":
      return "hubspot_list_users";
    case "hubspot.readApiResource":
      return "hubspot_read_api_resource";
    case "jira.getAuthenticatedUser":
      return "jira_get_authenticated_user";
    case "jira.listAccessibleResources":
      return "jira_list_accessible_resources";
    case "jira.listVisibleProjects":
      return "jira_list_visible_projects";
    case "jira.searchUsers":
      return "jira_search_users";
    case "jira.createIssue":
      return "jira_create_issue";
    case "jira.editIssue":
      return "jira_edit_issue";
    case "jira.getIssue":
      return "jira_get_issue";
    case "jira.updateIssue":
      return "jira_update_issue";
    case "jira.addComment":
      return "jira_add_comment";
    case "jira.transitionIssue":
      return "jira_transition_issue";
    case "jira.addLabels":
      return "jira_add_labels";
    case "jira.removeLabels":
      return "jira_remove_labels";
    case "jira.linkIssues":
      return "jira_link_issues";
    case "jira.createSubtask":
      return "jira_create_subtask";
    case "jira.listAssignedIssues":
      return "jira_list_assigned_issues";
    case "jira.searchIssues":
      return "jira_search_issues";
    case "slack.searchUsers":
      return "slack_search_users";
    case "slack.searchMessages":
      return "slack_search_messages";
    case "atlassian.listMcpTools":
      return "atlassian_list_mcp_tools";
    case "atlassian.callMcpTool":
      return "atlassian_call_mcp_tool";
    default:
      throw new Error(`Unsupported Burble MCP tool: ${toolName}`);
  }
}

function manifestToolNameToMcpToolName(
  toolName: string,
  request: RunRequest | undefined
): string | null {
  const tools = request?.runtime?.manifest?.tools;
  if (!tools) {
    return null;
  }

  const tool = tools.find(
    (entry) =>
      entry.enabled !== false &&
      (entry.name === toolName || entry.alias === toolName)
  );
  return tool?.name ?? null;
}

function toMcpToolArguments(
  toolName: string,
  body: unknown
): Record<string, unknown> {
  return withScheduledJobIdentity(
    toMcpToolArgumentsWithoutScheduledJobIdentity(toolName, body),
    readRecordKey(body, "input")
  );
}

function toMcpToolArgumentsWithoutScheduledJobIdentity(
  toolName: string,
  body: unknown
): Record<string, unknown> {
  if (toolName === "github.searchIssues") {
    const query = readNestedString(body, "input", "query");
    if (!query) {
      throw new Error("github.searchIssues requires input.query");
    }
    return { query };
  }

  if (toolName === "github.listMyPullRequests") {
    return compactToolInput(readRecordKey(body, "input"), [
      "limit",
      "state",
      "sort",
      "order",
      "owner",
      "repo"
    ]);
  }

  if (toolName === "github.createIssue") {
    const input = readRecordKey(body, "input");
    const repo = readNestedString(body, "input", "repo");
    const title = readNestedString(body, "input", "title");
    if (!repo) {
      throw new Error("github.createIssue requires input.repo");
    }
    if (!title) {
      throw new Error("github.createIssue requires input.title");
    }
    return {
      repo,
      title,
      ...compactToolInput(input, ["body", "labels", "assignees"])
    };
  }

  if (
    toolName === "github.getIssue" ||
    toolName === "github.getPullRequest" ||
    toolName === "github.closeIssue" ||
    toolName === "github.reopenIssue"
  ) {
    const input = readRecordKey(body, "input");
    const repo = readNestedString(body, "input", "repo");
    const number = readRecordNumber(input, "number");
    if (!repo) {
      throw new Error(`${toolName} requires input.repo`);
    }
    if (!number) {
      throw new Error(`${toolName} requires input.number`);
    }
    return { repo, number };
  }

  if (toolName === "github.updateIssue") {
    const input = readRecordKey(body, "input");
    const repo = readNestedString(body, "input", "repo");
    const number = readRecordNumber(input, "number");
    if (!repo) {
      throw new Error("github.updateIssue requires input.repo");
    }
    if (!number) {
      throw new Error("github.updateIssue requires input.number");
    }
    return {
      repo,
      number,
      ...compactToolInput(input, ["title", "body", "state", "labels", "assignees"])
    };
  }

  if (toolName === "github.commentOnIssueOrPullRequest") {
    const input = readRecordKey(body, "input");
    const repo = readNestedString(body, "input", "repo");
    const issueNumber = readRecordNumber(input, "number");
    const commentBody = readNestedString(body, "input", "body");
    if (!repo) {
      throw new Error("github.commentOnIssueOrPullRequest requires input.repo");
    }
    if (!issueNumber) {
      throw new Error("github.commentOnIssueOrPullRequest requires input.number");
    }
    if (!commentBody) {
      throw new Error("github.commentOnIssueOrPullRequest requires input.body");
    }
    return {
      repo,
      number: issueNumber,
      body: commentBody
    };
  }

  if (toolName === "github.createPullRequest") {
    const input = readRecordKey(body, "input");
    const repo = readNestedString(body, "input", "repo");
    const title = readNestedString(body, "input", "title");
    const head = readNestedString(body, "input", "head");
    const base = readNestedString(body, "input", "base");
    if (!repo) {
      throw new Error("github.createPullRequest requires input.repo");
    }
    if (!title) {
      throw new Error("github.createPullRequest requires input.title");
    }
    if (!head) {
      throw new Error("github.createPullRequest requires input.head");
    }
    if (!base) {
      throw new Error("github.createPullRequest requires input.base");
    }
    return {
      repo,
      title,
      head,
      base,
      ...compactToolInput(input, ["body", "draft"])
    };
  }

  if (toolName === "github.updatePullRequest") {
    const input = readRecordKey(body, "input");
    const repo = readNestedString(body, "input", "repo");
    const prNumber = readRecordNumber(input, "number");
    if (!repo) {
      throw new Error("github.updatePullRequest requires input.repo");
    }
    if (!prNumber) {
      throw new Error("github.updatePullRequest requires input.number");
    }
    return {
      repo,
      number: prNumber,
      ...compactToolInput(input, ["title", "body", "base", "draft"])
    };
  }

  if (toolName === "github.addLabels" || toolName === "github.removeLabels") {
    const input = readRecordKey(body, "input");
    const repo = readNestedString(body, "input", "repo");
    const issueNumber = readRecordNumber(input, "number");
    if (!repo) {
      throw new Error(`${toolName} requires input.repo`);
    }
    if (!issueNumber) {
      throw new Error(`${toolName} requires input.number`);
    }
    return {
      repo,
      number: issueNumber,
      ...compactToolInput(input, ["labels"])
    };
  }

  if (toolName === "github.requestReview") {
    const input = readRecordKey(body, "input");
    const repo = readNestedString(body, "input", "repo");
    const prNumber = readRecordNumber(input, "number");
    if (!repo) {
      throw new Error("github.requestReview requires input.repo");
    }
    if (!prNumber) {
      throw new Error("github.requestReview requires input.number");
    }
    return {
      repo,
      number: prNumber,
      ...compactToolInput(input, ["reviewers", "teamReviewers"])
    };
  }

  if (toolName === "github.getFile") {
    const input = readRecordKey(body, "input");
    const repo = readNestedString(body, "input", "repo");
    const path = readNestedString(body, "input", "path");
    if (!repo) {
      throw new Error("github.getFile requires input.repo");
    }
    if (!path) {
      throw new Error("github.getFile requires input.path");
    }
    return {
      repo,
      path,
      ...compactToolInput(input, ["ref"])
    };
  }

  if (toolName === "github.createOrUpdateFile") {
    const input = readRecordKey(body, "input");
    const repo = readNestedString(body, "input", "repo");
    const path = readNestedString(body, "input", "path");
    const content = readNestedValue(body, "input", "content");
    const message = readNestedString(body, "input", "message");
    if (!repo) {
      throw new Error("github.createOrUpdateFile requires input.repo");
    }
    if (!path) {
      throw new Error("github.createOrUpdateFile requires input.path");
    }
    if (typeof content !== "string") {
      throw new Error("github.createOrUpdateFile requires input.content");
    }
    if (!message) {
      throw new Error("github.createOrUpdateFile requires input.message");
    }
    return {
      repo,
      path,
      content,
      message,
      ...compactToolInput(input, ["branch", "sha"])
    };
  }

  if (toolName === "github.createBranch") {
    const input = readRecordKey(body, "input");
    const repo = readNestedString(body, "input", "repo");
    const branch = readNestedString(body, "input", "branch");
    if (!repo) {
      throw new Error("github.createBranch requires input.repo");
    }
    if (!branch) {
      throw new Error("github.createBranch requires input.branch");
    }
    return {
      repo,
      branch,
      ...compactToolInput(input, ["fromRef"])
    };
  }

  if (toolName === "jira.searchIssues") {
    const jql = readNestedString(body, "input", "jql");
    if (!jql) {
      throw new Error("jira.searchIssues requires input.jql");
    }
    return { jql };
  }

  if (toolName === "google.searchDriveFiles") {
    return compactToolInput(readRecordKey(body, "input"), [
      "query",
      "limit"
    ]);
  }

  if (toolName === "google.createDriveTextFile") {
    const name = readNestedString(body, "input", "name");
    const rawText = readNestedValue(body, "input", "text");
    const text = typeof rawText === "string" ? rawText : "";
    if (!name) {
      throw new Error("google.createDriveTextFile requires input.name");
    }
    return {
      name,
      text,
      ...compactToolInput(readRecordKey(body, "input"), ["mimeType"])
    };
  }

  if (toolName === "google.getDriveFile") {
    return compactToolInput(readRecordKey(body, "input"), [
      "fileId",
      "includeContent"
    ]);
  }

  if (
    toolName === "google.updateDriveTextFile" ||
    toolName === "google.appendToDriveTextFile"
  ) {
    return compactToolInput(readRecordKey(body, "input"), [
      "fileId",
      "text",
      "separator",
      "mimeType"
    ]);
  }

  if (toolName === "google.createDriveFolder") {
    return compactToolInput(readRecordKey(body, "input"), ["name", "parentId"]);
  }

  if (toolName === "google.moveDriveFile") {
    return compactToolInput(readRecordKey(body, "input"), [
      "fileId",
      "parentId",
      "removeParentIds"
    ]);
  }

  if (toolName === "google.searchCalendarEvents") {
    return compactToolInput(readRecordKey(body, "input"), [
      "query",
      "timeMin",
      "timeMax",
      "limit"
    ]);
  }

  if (
    toolName === "google.createCalendarEvent" ||
    toolName === "google.updateCalendarEvent"
  ) {
    return compactToolInput(readRecordKey(body, "input"), [
      "calendarId",
      "eventId",
      "summary",
      "start",
      "end",
      "description",
      "location",
      "timeZone"
    ]);
  }

  if (toolName === "google.searchMailMessages") {
    const query = readNestedString(body, "input", "query");
    if (!query) {
      throw new Error("google.searchMailMessages requires input.query");
    }
    return {
      query,
      ...compactToolInput(readRecordKey(body, "input"), ["limit"])
    };
  }

  if (toolName === "google.slidesSearchPresentations") {
    return compactToolInput(readRecordKey(body, "input"), [
      "query",
      "limit"
    ]);
  }

  if (toolName === "google.slidesGetPresentation") {
    return compactToolInput(readRecordKey(body, "input"), [
      "presentationId",
      "includeSlides"
    ]);
  }

  if (toolName === "google.slidesProbeTemplate") {
    return compactToolInput(readRecordKey(body, "input"), ["presentationId"]);
  }

  if (toolName === "google.slidesCopyPresentation") {
    return compactToolInput(readRecordKey(body, "input"), [
      "presentationId",
      "name"
    ]);
  }

  if (toolName === "google.slidesCreateSlide") {
    return compactToolInput(readRecordKey(body, "input"), [
      "presentationId",
      "presentation_id",
      "deckId",
      "deck_id",
      "objectId",
      "object_id",
      "slideObjectId",
      "slide_object_id",
      "slideId",
      "slide_id",
      "insertionIndex",
      "insertion_index",
      "index",
      "slideIndex",
      "slide_index",
      "layoutObjectId",
      "layout_object_id",
      "layoutId",
      "layout_id",
      "predefinedLayout",
      "predefined_layout",
      "layout",
      "layoutType",
      "layout_type",
      "replacements",
      "replacement",
      "updates",
      "update",
      "placeholders",
      "placeholder",
      "fills",
      "fill",
      "placeholderType",
      "placeholder_type",
      "type",
      "role",
      "text",
      "value",
      "content",
      "replacementText",
      "replacement_text",
      "title",
      "subtitle",
      "body"
    ]);
  }

  if (toolName === "google.slidesFillPlaceholders") {
    return compactToolInput(readRecordKey(body, "input"), [
      "presentationId",
      "presentation_id",
      "slideObjectId",
      "slide_object_id",
      "slideId",
      "slide_id",
      "pageObjectId",
      "page_object_id",
      "replacements",
      "replacement",
      "updates",
      "update",
      "placeholders",
      "placeholder",
      "fills",
      "fill",
      "placeholderType",
      "placeholder_type",
      "type",
      "role",
      "text",
      "value",
      "content",
      "replacementText",
      "replacement_text",
      "index",
      "placeholderIndex",
      "placeholder_index",
      "title",
      "subtitle",
      "body"
    ]);
  }

  if (toolName === "google.analyticsListProperties") {
    return compactToolInput(readRecordKey(body, "input"), ["limit"]);
  }

  if (toolName === "google.analyticsGetMetadata") {
    return compactToolInput(readRecordKey(body, "input"), [
      "propertyId",
      "dimensionQuery",
      "metricQuery",
      "limit"
    ]);
  }

  if (toolName === "google.analyticsRunReport") {
    return compactToolInput(readRecordKey(body, "input"), [
      "propertyId",
      "startDate",
      "endDate",
      "metrics",
      "dimensions",
      "limit"
    ]);
  }

  if (toolName === "gmail.createDraft") {
    return compactToolInput(readRecordKey(body, "input"), [
      "to",
      "subject",
      "body",
      "cc",
      "bcc"
    ]);
  }

  if (
    toolName === "hubspot.searchContacts" ||
    toolName === "hubspot.searchCompanies" ||
    toolName === "hubspot.searchDeals"
  ) {
    return compactToolInput(readRecordKey(body, "input"), [
      "query",
      "limit"
    ]);
  }

  if (toolName === "hubspot.searchCrmObjects") {
    return compactToolInput(readRecordKey(body, "input"), [
      "objectType",
      "query",
      "limit",
      "properties"
    ]);
  }

  if (toolName === "hubspot.listOwners" || toolName === "hubspot.listUsers") {
    return compactToolInput(readRecordKey(body, "input"), [
      "limit",
      "after"
    ]);
  }

  if (toolName === "hubspot.readApiResource") {
    const input = readRecordKey(body, "input");
    return {
      ...compactToolInput(input, ["path"]),
      ...(input ? compactRecordField(input, "query") : {})
    };
  }

  if (toolName === "jira.listVisibleProjects") {
    const input = readNestedRecord(body, "input", "input") ??
      readNestedRecord(body, "input", "arguments") ??
      readNestedRecord(body, "input", "params") ??
      readRecordKey(body, "input");
    if (!input) {
      return {};
    }

    return {
      ...(typeof input.query === "string" && input.query.trim()
        ? { query: input.query }
        : {}),
      ...(typeof input.action === "string" && input.action.trim()
        ? { action: input.action }
        : {}),
      ...(typeof input.expandIssueTypes === "boolean"
        ? { expandIssueTypes: input.expandIssueTypes }
        : {})
    };
  }

  if (toolName === "jira.searchUsers") {
    const query = readNestedString(body, "input", "query");
    if (!query) {
      throw new Error("jira.searchUsers requires input.query");
    }
    return { query };
  }

  if (toolName === "slack.searchUsers") {
    const query = readNestedString(body, "input", "query");
    if (!query) {
      throw new Error("slack.searchUsers requires input.query");
    }
    return { query };
  }

  if (toolName === "slack.searchMessages") {
    return compactToolInput(readRecordKey(body, "input"), [
      "query",
      "fromUserId",
      "inChannel",
      "limit"
    ]);
  }

  if (toolName === "jira.createIssue") {
    return compactToolInput(readRecordKey(body, "input"), [
      "projectKey",
      "issueTypeName",
      "issueTypeId",
      "summary",
      "description",
      "assigneeAccountId"
    ]);
  }

  if (toolName === "jira.editIssue") {
    return compactToolInput(readRecordKey(body, "input"), [
      "issueKey",
      "summary",
      "description",
      "assigneeAccountId"
    ]);
  }

  if (toolName === "jira.getIssue") {
    return compactToolInput(readRecordKey(body, "input"), ["issueKey"]);
  }

  if (toolName === "jira.updateIssue") {
    return compactToolInput(readRecordKey(body, "input"), [
      "issueKey",
      "summary",
      "description",
      "assigneeAccountId",
      "labels"
    ]);
  }

  if (toolName === "jira.addComment") {
    return compactToolInput(readRecordKey(body, "input"), ["issueKey", "body"]);
  }

  if (toolName === "jira.transitionIssue") {
    return compactToolInput(readRecordKey(body, "input"), [
      "issueKey",
      "transitionId",
      "transitionName"
    ]);
  }

  if (toolName === "jira.addLabels" || toolName === "jira.removeLabels") {
    return compactToolInput(readRecordKey(body, "input"), ["issueKey", "labels"]);
  }

  if (toolName === "jira.linkIssues") {
    return compactToolInput(readRecordKey(body, "input"), [
      "inwardIssueKey",
      "outwardIssueKey",
      "typeName",
      "comment"
    ]);
  }

  if (toolName === "jira.createSubtask") {
    return compactToolInput(readRecordKey(body, "input"), [
      "parentIssueKey",
      "summary",
      "projectKey",
      "issueTypeName",
      "issueTypeId",
      "description",
      "assigneeAccountId"
    ]);
  }

  if (toolName === "atlassian.callMcpTool") {
    const name = readNestedString(body, "input", "name");
    if (!name) {
      throw new Error("atlassian.callMcpTool requires input.name");
    }

    return {
      name,
      arguments: readNestedRecord(body, "input", "arguments") ?? {}
    };
  }

  return readRecordKey(body, "input") ?? {};
}

function withScheduledJobIdentity(
  args: Record<string, unknown>,
  input: Record<string, unknown> | null
): Record<string, unknown> {
  const jobId = readScheduledJobIdFromInput(input);
  return jobId ? { ...args, jobId } : args;
}

function readScheduledJobIdFromInput(
  input: Record<string, unknown> | null
): string | null {
  const raw = input?.jobId;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function readNestedString(
  value: unknown,
  outerKey: string,
  innerKey: string
): string | null {
  const inner = readNestedValue(value, outerKey, innerKey);
  return typeof inner === "string" && inner.trim() ? inner : null;
}

function readNestedText(
  value: unknown,
  outerKey: string,
  innerKey: string
): string | null {
  const inner = readNestedValue(value, outerKey, innerKey);
  return typeof inner === "string" &&
    inner.replace(/[\s\p{Default_Ignorable_Code_Point}]/gu, "").length > 0
    ? inner
    : null;
}

function readNestedValue(
  value: unknown,
  outerKey: string,
  innerKey: string
): unknown {
  if (!value || typeof value !== "object") {
    return null;
  }
  const outer = (value as Record<string, unknown>)[outerKey];
  if (!outer || typeof outer !== "object") {
    return null;
  }
  return (outer as Record<string, unknown>)[innerKey];
}

function readNestedAttachments(
  value: unknown,
  outerKey: string,
  innerKey: string
): ConversationAttachment[] | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const outer = (value as Record<string, unknown>)[outerKey];
  if (!outer || typeof outer !== "object") {
    return null;
  }
  const inner = (outer as Record<string, unknown>)[innerKey];
  return isConversationAttachmentArray(inner) ? inner : null;
}

function readNestedObject(
  value: unknown,
  outerKey: string
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const outer = (value as Record<string, unknown>)[outerKey];
  if (!outer || typeof outer !== "object" || Array.isArray(outer)) {
    return null;
  }
  return outer as Record<string, unknown>;
}

function isConversationAttachmentArray(
  value: unknown
): value is ConversationAttachment[] {
  return Array.isArray(value) && value.every(isConversationAttachment);
}

function isConversationAttachment(value: unknown): value is ConversationAttachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.trim().length > 0 &&
    (record.kind === "file" ||
      record.kind === "image" ||
      record.kind === "audio" ||
      record.kind === "video") &&
    typeof record.mimeType === "string" &&
    record.mimeType.trim().length > 0 &&
    (record.source === "slack" ||
      record.source === "burble" ||
      record.source === "agent") &&
    optionalString(record.name) &&
    (record.sizeBytes === undefined ||
      (typeof record.sizeBytes === "number" &&
        Number.isFinite(record.sizeBytes) &&
        record.sizeBytes >= 0)) &&
    optionalString(record.externalId)
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function readNestedRecord(
  value: unknown,
  outerKey: string,
  innerKey: string
): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const outer = (value as Record<string, unknown>)[outerKey];
  if (!outer || typeof outer !== "object") {
    return null;
  }
  const inner = (outer as Record<string, unknown>)[innerKey];
  return inner && typeof inner === "object" && !Array.isArray(inner)
    ? (inner as Record<string, unknown>)
    : null;
}

function readRecordKey(
  value: unknown,
  key: string
): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const inner = (value as Record<string, unknown>)[key];
  return inner && typeof inner === "object" && !Array.isArray(inner)
    ? (inner as Record<string, unknown>)
    : null;
}

function readRecordNumber(
  value: Record<string, unknown> | null,
  key: string
): number | null {
  const number = value?.[key];
  return typeof number === "number" && Number.isInteger(number) && number > 0
    ? number
    : null;
}

function compactToolInput(
  input: Record<string, unknown> | null,
  keys: string[]
): Record<string, unknown> {
  if (!input) {
    return {};
  }

  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const value = input[key];
    if (
      value === null ||
      (typeof value === "string" && value.trim()) ||
      typeof value === "boolean" ||
      typeof value === "number" ||
      Array.isArray(value)
    ) {
      output[key] = value;
    }
  }
  return output;
}

function compactRecordField(
  input: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const value = input[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? { [key]: value }
    : {};
}

async function readMcpToolResult(response: Response): Promise<ToolResult> {
  const body = await response.text();
  const payload = parseMcpResponsePayload(body);
  const error = payload.error;
  if (error && typeof error === "object" && "message" in error) {
    throw new Error(`Burble MCP tool failed: ${String(error.message)}`);
  }

  const content = payload.result?.content;
  if (!Array.isArray(content)) {
    throw new Error("Burble MCP gateway returned malformed tool result");
  }

  const text = content
    .map((item) =>
      item &&
      typeof item === "object" &&
      "type" in item &&
      item.type === "text" &&
      "text" in item &&
      typeof item.text === "string"
        ? item.text
        : null
    )
    .find((item): item is string => item !== null);
  if (!text) {
    throw new Error("Burble MCP gateway returned no text tool result");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      classification: "user_private",
      content: text
    };
  }

  if (!isToolResult(parsed)) {
    throw new Error("Burble MCP gateway returned invalid Burble tool result");
  }

  return parsed;
}

async function readMcpToolsListResult(response: Response): Promise<unknown[]> {
  const body = await response.text();
  const payload = parseMcpResponsePayload(body);
  const error = payload.error;
  if (error && typeof error === "object" && "message" in error) {
    throw new Error(`Burble MCP tools/list failed: ${String(error.message)}`);
  }

  const tools = payload.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error("Burble MCP tools/list returned malformed result");
  }

  return tools
    .filter((tool) => tool && typeof tool === "object" && !Array.isArray(tool))
    .map((tool) => sanitizeMcpToolMetadata(tool as Record<string, unknown>));
}

function sanitizeMcpToolMetadata(
  tool: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...(typeof tool.name === "string" ? { name: tool.name } : {}),
    ...(typeof tool.title === "string" ? { title: tool.title } : {}),
    ...(typeof tool.description === "string"
      ? { description: tool.description }
      : {}),
    ...(tool.inputSchema && typeof tool.inputSchema === "object"
      ? { inputSchema: tool.inputSchema }
      : {})
  };
}

function parseMcpResponsePayload(body: string): {
  result?: { content?: unknown; tools?: unknown };
  error?: unknown;
} {
  const eventData = body
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  const raw = eventData ?? body;

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new Error("Burble MCP gateway returned invalid JSON");
  }
}

async function readErrorDetail(response: Response): Promise<string> {
  const text = (await response.text()).trim().replace(/\s+/g, " ");
  return text ? `: ${text.slice(0, 300)}` : "";
}

async function readToolGatewayErrorResult(
  response: Response
): Promise<ToolResult | null> {
  try {
    const parsed = (await response.json()) as unknown;
    return isToolResult(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function summarizeLogObject(label: string, value: unknown): string {
  return ` ${label}=${JSON.stringify(sanitizeLogValue(value, 0))}`;
}

function sanitizeLogValue(value: unknown, depth: number): unknown {
  if (depth > 3) {
    return "[depth-limit]";
  }

  if (typeof value === "string") {
    return sanitizeLogString(value);
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => sanitizeLogValue(item, depth + 1));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 30)
        .map(([key, item]) => [
          key,
          shouldRedactLogKey(key) ? "[redacted]" : sanitizeLogValue(item, depth + 1)
        ])
    );
  }

  return String(value);
}

function sanitizeLogString(value: string): string {
  return truncateLogValue(
    value.replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      (email) => redactEmail(email)
    ),
    300
  );
}

function shouldRedactLogKey(key: string): boolean {
  return /(authorization|token|secret|password|credential|jwt|cookie)/i.test(key);
}

function redactEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) {
    return "[redacted-email]";
  }

  return `${local.slice(0, 2)}***@${domain}`;
}

function truncateLogValue(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 3)}...`;
}

function isToolResult(value: unknown): value is ToolResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.classification === "public" ||
      record.classification === "user_private" ||
      record.classification === "restricted") &&
    "content" in record
  );
}
