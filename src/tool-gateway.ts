import type { Config } from "./config";
import type { AgentRuntimeEngine, AgentRuntimeRecord, TokenStore } from "./db";
import type { ConversationAttachment } from "./conversation/types";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  addGitHubIssueLabels,
  commentOnGitHubIssueOrPullRequest,
  closeGitHubIssue,
  createGitHubBranch,
  createGitHubIssue,
  createGitHubPullRequest,
  createOrUpdateGitHubFile,
  getGitHubFile,
  getGitHubIssue,
  getGitHubPullRequest,
  getGitHubUser,
  listAssignedIssues,
  listMyPullRequests,
  removeGitHubIssueLabels,
  requestGitHubPullRequestReview,
  searchIssues,
  reopenGitHubIssue,
  updateGitHubIssue,
  updateGitHubPullRequest
} from "./providers/github/client";
import {
  appendGoogleDriveTextFile,
  createGmailDraft,
  createGoogleCalendarEvent,
  createGoogleDriveFolder,
  createGoogleDriveTextFile,
  getGoogleDriveFile,
  getGoogleUser,
  moveGoogleDriveFile,
  refreshGoogleAccessToken,
  searchGoogleCalendarEvents,
  searchGoogleDriveFiles,
  searchGoogleMailMessages,
  updateGoogleCalendarEvent,
  updateGoogleDriveTextFile
} from "./providers/google/client";
import {
  getHubSpotAccessTokenInfo,
  refreshHubSpotAccessToken,
  searchHubSpotCompanies,
  searchHubSpotContacts,
  searchHubSpotDeals
} from "./providers/hubspot/client";
import {
  addJiraIssueComment,
  addJiraIssueLabels,
  createJiraIssue,
  createJiraSubtask,
  editJiraIssue,
  getJiraIssue,
  getJiraUser,
  linkJiraIssues,
  listJiraAccessibleResources,
  listAssignedJiraIssues,
  listVisibleJiraProjects,
  refreshJiraAccessToken,
  removeJiraIssueLabels,
  searchJiraUsers,
  searchJiraIssues,
  transitionJiraIssue,
  updateJiraIssue
} from "./providers/jira/client";
import {
  callUpstreamMcpTool,
  listUpstreamMcpTools,
  type UpstreamMcpTool,
  type UpstreamMcpToolResult
} from "./mcp/upstream-http-client";
import { searchSlackMessages, searchSlackUsers } from "./providers/slack/client";
import {
  createGitHubTools,
  type GitHubPullRequestListInput
} from "./tools/github";
import { createGoogleTools, type GoogleToolDeps } from "./tools/google";
import { createHubSpotTools, type HubSpotToolDeps } from "./tools/hubspot";
import {
  createJiraTools,
  isJiraAuthErrorResult,
  type JiraToolDeps,
  withFreshJiraToken
} from "./tools/jira";
import { createSlackTools, type SlackToolDeps } from "./tools/slack";
import type { ToolResult } from "./tools/types";
import {
  logAtlassianMcpCallFailure,
  logAtlassianMcpCallFinish,
  logAtlassianMcpCallStart
} from "./mcp/atlassian-logging";
import { verifyJiraAuthForOpaqueAtlassianMcpError } from "./mcp/atlassian-auth";
import type { ObservabilitySink } from "./observability";
import { formatLogLine } from "./logging";
import { buildScheduledJobContext } from "./agent/scheduled-job-context";
import { assertScheduledJobCapabilityMatchesRuntime } from "./agent/scheduled-job-auth";
import {
  isScheduledJobToolAllowed,
  normalizeScheduledJobToolNames
} from "./agent/scheduled-job-tools";

type ToolGatewayDeps = Partial<Parameters<typeof createGitHubTools>[0]> &
  Partial<GoogleToolDeps> &
  Partial<HubSpotToolDeps> &
  Partial<JiraToolDeps> &
  Partial<SlackToolDeps> & {
    fetchConversationAttachment?: (input: {
      attachment: ConversationAttachment;
      maxBytes: number;
    }) => Promise<ConversationAttachmentContent>;
    postActiveConversationMessage?: (input: {
      transport: "slack";
      channelId: string;
      text: string;
      attachments?: ConversationAttachment[];
      threadTs?: string;
    }) => Promise<{
      transport: "slack";
      channelId: string;
      messageId?: string;
    }>;
    listAtlassianMcpTools?: (input: {
      url: string;
      accessToken: string;
    }) => Promise<UpstreamMcpTool[]>;
    callAtlassianMcpTool?: (input: {
      url: string;
      accessToken: string;
      name: string;
      arguments?: Record<string, unknown>;
    }) => Promise<UpstreamMcpToolResult>;
    observability?: ObservabilitySink;
  };

type ToolGatewayBody = {
  user?: {
    email?: unknown;
  };
  input?: unknown;
  conversation?: unknown;
  attachments?: unknown;
};

type ConversationAttachmentContent = {
  attachment: ConversationAttachment;
  contentBase64: string;
  text?: string;
};

const maxConversationAttachmentBytes = 5 * 1024 * 1024;
const maxConversationAttachmentTextChars = 64 * 1024;

const defaultDeps = {
  getGitHubUser,
  listAssignedIssues,
  searchIssues,
  listMyPullRequests,
  getIssue: getGitHubIssue,
  getPullRequest: getGitHubPullRequest,
  createIssue: createGitHubIssue,
  updateIssue: updateGitHubIssue,
  closeIssue: closeGitHubIssue,
  reopenIssue: reopenGitHubIssue,
  commentOnIssueOrPullRequest: commentOnGitHubIssueOrPullRequest,
  createPullRequest: createGitHubPullRequest,
  updatePullRequest: updateGitHubPullRequest,
  addLabels: addGitHubIssueLabels,
  removeLabels: removeGitHubIssueLabels,
  requestReview: requestGitHubPullRequestReview,
  getFile: getGitHubFile,
  createOrUpdateFile: createOrUpdateGitHubFile,
  createBranch: createGitHubBranch,
  getGoogleUser,
  searchGoogleDriveFiles,
  createGoogleDriveTextFile,
  getGoogleDriveFile,
  updateGoogleDriveTextFile,
  appendGoogleDriveTextFile,
  createGoogleDriveFolder,
  moveGoogleDriveFile,
  searchGoogleCalendarEvents,
  createGoogleCalendarEvent,
  updateGoogleCalendarEvent,
  searchGoogleMailMessages,
  createGmailDraft,
  getHubSpotAccessTokenInfo,
  searchHubSpotContacts,
  searchHubSpotCompanies,
  searchHubSpotDeals,
  getJiraUser,
  listJiraAccessibleResources,
  listAssignedJiraIssues,
  listVisibleJiraProjects,
  searchJiraUsers,
  createJiraIssue,
  editJiraIssue,
  getJiraIssue,
  updateJiraIssue,
  addJiraIssueComment,
  transitionJiraIssue,
  addJiraIssueLabels,
  removeJiraIssueLabels,
  linkJiraIssues,
  createJiraSubtask,
  searchJiraIssues,
  searchSlackMessages,
  searchSlackUsers
};

type ToolGatewayAuth =
  | { kind: "legacy" }
  | { kind: "runtime"; runtime: AgentRuntimeRecord };

type ToolGatewayObservabilityContext = {
  observability?: ObservabilitySink;
  startedAt: number;
  body: ToolGatewayBody | null;
};

export async function handleToolGatewayRequest(
  config: Config,
  store: TokenStore,
  toolName: string,
  request: Request,
  deps: ToolGatewayDeps = {}
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const auth = authorizeToolGateway(config, store, request);
  if (!auth) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (auth.kind === "runtime") {
    store.touchAgentRuntime(auth.runtime.id);
  }

  if (!isKnownTool(toolName)) {
    return new Response("Unknown tool", { status: 404 });
  }

  let body = await readToolGatewayBody(request);
  const toolStartedAt = Date.now();

  if (toolName === "runtime.heartbeat") {
    if (auth.kind !== "runtime") {
      return new Response("Runtime auth required", { status: 403 });
    }

    emitRuntimeHeartbeat(deps.observability, auth, toolStartedAt);
    return jsonResponse({
      classification: "user_private",
      content: {
        ok: true,
        runtimeId: auth.runtime.id
      }
    });
  }

  emitToolGatewayStarted(deps.observability, auth, toolName, body);
  const respondWithAudit = (result: ToolResult<unknown>): Response =>
    jsonResponseWithAudit(store, auth, toolName, result, {
      observability: deps.observability,
      startedAt: toolStartedAt,
      body
    });

  if (toolName === "conversation.sendMessage") {
    if (auth.kind !== "runtime") {
      return new Response("Runtime auth required", { status: 403 });
    }
    if (!isConversationSendInput(body?.input)) {
      return new Response("Invalid tool input", { status: 400 });
    }
    const sendInput = body.input;
    const destination = sendInput.routeId
      ? resolveConversationRouteDestination(store, auth.runtime, sendInput.routeId)
      : resolveActiveConversationDestination(auth.runtime, body?.conversation);
    if (!destination.ok) {
      return new Response(destination.message, { status: destination.status });
    }

    const result = await (deps.postActiveConversationMessage ??
      ((input) => defaultPostActiveConversationMessage(config, input)))({
      transport: destination.transport,
      channelId: destination.channelId,
      text: sendInput.text,
      ...(sendInput.attachments ? { attachments: sendInput.attachments } : {}),
      ...(destination.threadTs ? { threadTs: destination.threadTs } : {})
    });

    return respondWithAudit({
      classification: "user_private",
      content: {
        ok: true,
        transport: result.transport,
        conversationId: result.channelId,
        ...(sendInput.routeId ? { routeId: sendInput.routeId } : {}),
        ...(result.messageId ? { messageId: result.messageId } : {})
      }
    });
  }

  if (toolName === "conversation.getAttachment") {
    if (auth.kind !== "runtime") {
      return new Response("Runtime auth required", { status: 403 });
    }
    if (!isConversationGetAttachmentInput(body?.input)) {
      return new Response("Invalid tool input", { status: 400 });
    }
    const getInput = body.input;
    const attachments = isConversationAttachmentArray(body?.attachments)
      ? body.attachments
      : [];
    const attachment = attachments.find(
      (candidate) => candidate.id === getInput.attachmentId
    );
    if (!attachment) {
      return new Response("Attachment not available for this run", { status: 404 });
    }

    const content = await (deps.fetchConversationAttachment ??
      ((input) => defaultFetchConversationAttachment(config, input)))({
      attachment,
      maxBytes: maxConversationAttachmentBytes
    });

    return respondWithAudit({
      classification: "user_private",
      content
    });
  }

  if (!body) {
    return new Response("Invalid tool input", { status: 400 });
  }

  if (toolName === "scheduledJob.registerCapability") {
    if (auth.kind !== "runtime") {
      return new Response("Runtime auth required", { status: 403 });
    }
    const inputError = describeScheduledJobRegisterCapabilityInputError(
      body.input
    );
    if (inputError) {
      const diagnostics = describeScheduledJobRegisterCapabilityInput(body.input);
      console.warn(
        formatLogLine(
          "warn",
          `scheduledJob.registerCapability invalid input runtimeId=${auth.runtime.id} message=${JSON.stringify(inputError)} diagnostics=${JSON.stringify(diagnostics)}`
        )
      );
      return jsonResponse(
        {
          classification: "user_private",
          content: {
            error: "invalid_scheduled_job_capability_input",
            message: inputError,
            diagnostics
          }
        },
        400
      );
    }
    const input = readScheduledJobRegisterCapabilityInput(body.input);
    if (!input) {
      return new Response("Invalid tool input", { status: 400 });
    }
    if (input.routeId) {
      const destination = resolveConversationRouteDestination(
        store,
        auth.runtime,
        input.routeId
      );
      if (!destination.ok) {
        return new Response(destination.message, { status: destination.status });
      }
    }
    const requiredTools = normalizeScheduledJobToolNames(input.requiredTools);
    const record = store.upsertAgentJobCapability({
      jobId: input.jobId,
      workspaceId: auth.runtime.workspaceId,
      slackUserId: auth.runtime.slackUserId,
      requiredTools,
      routeId: input.routeId ?? null,
      policyHash: auth.runtime.policyHash,
      capabilityProfile: input.capabilityProfile ?? "scheduled_job",
      runtimeType: input.runtimeType ?? auth.runtime.engine,
      stateRefs: input.stateRefs ?? [],
      visibilityPolicy: input.visibilityPolicy ?? {}
    });
    const scheduledJob = buildScheduledJobContext(record);
    return respondWithAudit({
      classification: "user_private",
      content: {
        ok: true,
        scheduledJob,
        scheduledPromptInstruction:
          buildScheduledJobPromptInstruction(scheduledJob)
      }
    });
  }

  const scheduledValidation = validateAndStripScheduledJobToolGatewayInput(
    store,
    auth,
    toolName,
    body
  );
  if (scheduledValidation.response) {
    return scheduledValidation.response;
  }
  body = scheduledValidation.body;

  const provider = readToolProvider(toolName);
  const connection = resolveToolGatewayConnection(store, auth, provider, body);
  if (!connection) {
    return jsonResponse({
      classification: "user_private",
      content: {
        error: `${provider}_not_connected`,
        message:
          provider === "github"
            ? "Connect GitHub first: `@Burble connect github`."
            : provider === "google"
              ? "Connect Google first: `/auth google`."
            : provider === "hubspot"
              ? "Connect HubSpot first: `/auth hubspot`."
            : provider === "jira"
              ? "Connect Jira first."
              : "Connect Slack search first: `/auth slack`."
      }
    });
  }
  if (auth.kind === "runtime" && connection.slackUserId !== auth.runtime.slackUserId) {
    return new Response("Runtime principal mismatch", { status: 403 });
  }

  const tools = createGitHubTools({ ...defaultDeps, ...deps });
  const googleTools = createGoogleTools({
    ...defaultDeps,
    refreshGoogleAccessToken: (refreshToken) =>
      refreshGoogleAccessToken(config, refreshToken),
    saveGoogleConnection: (connection) => store.upsertProviderConnection(connection),
    ...deps
  });
  const hubspotTools = createHubSpotTools({
    ...defaultDeps,
    refreshHubSpotAccessToken: (refreshToken) =>
      refreshHubSpotAccessToken(config, refreshToken),
    saveHubSpotConnection: (connection) =>
      store.upsertProviderConnection(connection),
    ...deps
  });
  const jiraTools = createJiraTools({
    ...defaultDeps,
    refreshJiraAccessToken: (refreshToken) =>
      refreshJiraAccessToken(config, refreshToken),
    saveJiraConnection: (connection) => store.upsertProviderConnection(connection),
    ...deps
  });
  const slackTools = createSlackTools({ ...defaultDeps, ...deps });

  switch (toolName) {
    case "github.getAuthenticatedUser":
      return respondWithAudit(
        await tools.getAuthenticatedUser.execute({ connection })
      );

    case "github.listAssignedIssues":
      return respondWithAudit(
        await tools.listAssignedIssues.execute({ connection })
      );

    case "github.searchIssues": {
      if (!isSearchIssuesInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await tools.searchIssues.execute({
          connection,
          input: { query: body.input.query }
        })
      );
    }

    case "github.listMyPullRequests": {
      if (!isListMyPullRequestsInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await tools.listMyPullRequests.execute({
          connection,
          input: body.input ?? undefined
        })
      );
    }

    case "github.getIssue": {
      if (!isGitHubIssueNumberInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await tools.getIssue.execute({
          connection,
          input: body.input
        })
      );
    }

    case "github.getPullRequest": {
      if (!isGitHubIssueNumberInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await tools.getPullRequest.execute({
          connection,
          input: body.input
        })
      );
    }

    case "github.createIssue": {
      if (!isCreateGitHubIssueInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await tools.createIssue.execute({
          connection,
          input: body.input
        })
      );
    }

    case "github.updateIssue": {
      if (!isUpdateGitHubIssueInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await tools.updateIssue.execute({
          connection,
          input: body.input
        })
      );
    }

    case "github.closeIssue": {
      if (!isGitHubIssueNumberInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await tools.closeIssue.execute({
          connection,
          input: body.input
        })
      );
    }

    case "github.reopenIssue": {
      if (!isGitHubIssueNumberInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await tools.reopenIssue.execute({
          connection,
          input: body.input
        })
      );
    }

    case "github.commentOnIssueOrPullRequest": {
      if (!isGitHubCommentInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await tools.commentOnIssueOrPullRequest.execute({
          connection,
          input: body.input
        })
      );
    }

    case "github.createPullRequest": {
      if (!isCreateGitHubPullRequestInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await tools.createPullRequest.execute({
          connection,
          input: body.input
        })
      );
    }

    case "github.updatePullRequest": {
      if (!isUpdateGitHubPullRequestInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await tools.updatePullRequest.execute({
          connection,
          input: body.input
        })
      );
    }

    case "github.addLabels": {
      if (!isGitHubLabelsInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await tools.addLabels.execute({
          connection,
          input: body.input
        })
      );
    }

    case "github.removeLabels": {
      if (!isGitHubLabelsInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await tools.removeLabels.execute({
          connection,
          input: body.input
        })
      );
    }

    case "github.requestReview": {
      if (!isGitHubRequestReviewInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await tools.requestReview.execute({
          connection,
          input: body.input
        })
      );
    }

    case "github.getFile": {
      if (!isGitHubGetFileInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await tools.getFile.execute({
          connection,
          input: body.input
        })
      );
    }

    case "github.createOrUpdateFile": {
      if (!isGitHubCreateOrUpdateFileInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await tools.createOrUpdateFile.execute({
          connection,
          input: body.input
        })
      );
    }

    case "github.createBranch": {
      if (!isGitHubCreateBranchInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await tools.createBranch.execute({
          connection,
          input: body.input
        })
      );
    }

    case "jira.getAuthenticatedUser":
      return respondWithAudit(
        await jiraTools.getAuthenticatedUser.execute({ connection })
      );

    case "jira.listAccessibleResources":
      return respondWithAudit(
        await jiraTools.listAccessibleResources.execute({ connection })
      );

    case "jira.listVisibleProjects": {
      if (!isListVisibleJiraProjectsInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await jiraTools.listVisibleProjects.execute({
          connection,
          input: body.input
        })
      );
    }

    case "jira.searchUsers": {
      if (!isSearchJiraUsersInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await jiraTools.searchUsers.execute({
          connection,
          input: { query: body.input.query }
        })
      );
    }

    case "jira.createIssue": {
      if (!isCreateJiraIssueInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await jiraTools.createIssue.execute({
          connection,
          input: body.input
        })
      );
    }

    case "jira.editIssue": {
      if (!isEditJiraIssueInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await jiraTools.editIssue.execute({
          connection,
          input: body.input
        })
      );
    }

    case "jira.listAssignedIssues":
      return respondWithAudit(
        await jiraTools.listAssignedIssues.execute({ connection })
      );

    case "jira.searchIssues": {
      if (!isSearchJiraIssuesInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await jiraTools.searchIssues.execute({
          connection,
          input: { jql: body.input.jql }
        })
      );
    }

    case "jira.getIssue": {
      if (!isJiraIssueKeyInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await jiraTools.getIssue.execute({
          connection,
          input: body.input
        })
      );
    }

    case "jira.updateIssue": {
      if (!isUpdateJiraIssueInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await jiraTools.updateIssue.execute({
          connection,
          input: body.input
        })
      );
    }

    case "jira.addComment": {
      if (!isJiraCommentInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await jiraTools.addComment.execute({
          connection,
          input: body.input
        })
      );
    }

    case "jira.transitionIssue": {
      if (!isJiraTransitionInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await jiraTools.transitionIssue.execute({
          connection,
          input: body.input
        })
      );
    }

    case "jira.addLabels": {
      if (!isJiraLabelsInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await jiraTools.addLabels.execute({
          connection,
          input: body.input
        })
      );
    }

    case "jira.removeLabels": {
      if (!isJiraLabelsInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await jiraTools.removeLabels.execute({
          connection,
          input: body.input
        })
      );
    }

    case "jira.linkIssues": {
      if (!isJiraLinkIssuesInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await jiraTools.linkIssues.execute({
          connection,
          input: body.input
        })
      );
    }

    case "jira.createSubtask": {
      if (!isCreateJiraSubtaskInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await jiraTools.createSubtask.execute({
          connection,
          input: body.input
        })
      );
    }

    case "slack.searchUsers": {
      if (!isSearchSlackUsersInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await slackTools.searchUsers.execute({
          connection,
          input: { query: body.input.query }
        })
      );
    }

    case "slack.searchMessages": {
      if (!isSearchSlackMessagesInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await slackTools.searchMessages.execute({
          connection,
          input: body.input
        })
      );
    }

    case "google.getAuthenticatedUser":
      return respondWithAudit(
        await googleTools.getAuthenticatedUser.execute({ connection })
      );

    case "google.searchDriveFiles": {
      if (!isSearchGoogleDriveFilesInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await googleTools.searchDriveFiles.execute({
          connection,
          input: body.input
        })
      );
    }

    case "google.getDriveFile": {
      if (!isGetGoogleDriveFileInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await googleTools.getDriveFile.execute({
          connection,
          input: body.input
        })
      );
    }

    case "google.createDriveTextFile": {
      if (!isCreateGoogleDriveTextFileInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await googleTools.createDriveTextFile.execute({
          connection,
          input: {
            ...body.input,
            text: body.input.text ?? ""
          }
        })
      );
    }

    case "google.updateDriveTextFile": {
      if (!isUpdateGoogleDriveTextFileInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await googleTools.updateDriveTextFile.execute({
          connection,
          input: body.input
        })
      );
    }

    case "google.appendToDriveTextFile": {
      if (!isAppendGoogleDriveTextFileInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await googleTools.appendDriveTextFile.execute({
          connection,
          input: body.input
        })
      );
    }

    case "google.createDriveFolder": {
      if (!isCreateGoogleDriveFolderInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await googleTools.createDriveFolder.execute({
          connection,
          input: body.input
        })
      );
    }

    case "google.moveDriveFile": {
      if (!isMoveGoogleDriveFileInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await googleTools.moveDriveFile.execute({
          connection,
          input: body.input
        })
      );
    }

    case "google.searchCalendarEvents": {
      if (!isSearchGoogleCalendarEventsInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await googleTools.searchCalendarEvents.execute({
          connection,
          input: body.input
        })
      );
    }

    case "google.createCalendarEvent": {
      if (!isCreateGoogleCalendarEventInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await googleTools.createCalendarEvent.execute({
          connection,
          input: body.input
        })
      );
    }

    case "google.updateCalendarEvent": {
      if (!isUpdateGoogleCalendarEventInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await googleTools.updateCalendarEvent.execute({
          connection,
          input: body.input
        })
      );
    }

    case "google.searchMailMessages": {
      if (!isSearchGoogleMailMessagesInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await googleTools.searchMailMessages.execute({
          connection,
          input: body.input
        })
      );
    }

    case "hubspot.getAuthenticatedUser":
      return respondWithAudit(
        await hubspotTools.getAuthenticatedUser.execute({ connection })
      );

    case "hubspot.searchContacts": {
      if (!isHubSpotSearchInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await hubspotTools.searchContacts.execute({
          connection,
          input: body.input
        })
      );
    }

    case "hubspot.searchCompanies": {
      if (!isHubSpotSearchInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await hubspotTools.searchCompanies.execute({
          connection,
          input: body.input
        })
      );
    }

    case "hubspot.searchDeals": {
      if (!isHubSpotSearchInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await hubspotTools.searchDeals.execute({
          connection,
          input: body.input
        })
      );
    }

    case "gmail.createDraft": {
      if (!isCreateGmailDraftInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }

      return respondWithAudit(
        await googleTools.createMailDraft.execute({
          connection,
          input: body.input
        })
      );
    }

    case "atlassian.listMcpTools": {
      const result = await withFreshJiraToken(
        {
          ...defaultDeps,
          refreshJiraAccessToken: (refreshToken) =>
            refreshJiraAccessToken(config, refreshToken),
          saveJiraConnection: (updatedConnection) =>
            store.upsertProviderConnection(updatedConnection),
          ...deps
        },
        connection,
        async (accessToken) => {
          const tools = await (deps.listAtlassianMcpTools ??
            defaultListAtlassianMcpTools)({
            url: config.atlassianMcpUrl,
            accessToken
          });

          return {
            classification: "user_private" as const,
            content: tools
              .filter((tool) => isAllowedAtlassianMcpToolName(tool.name))
              .slice(0, 50)
              .map((tool) => ({
                name: tool.name,
                ...(tool.title ? { title: tool.title } : {}),
                ...(tool.description ? { description: tool.description } : {}),
                ...("inputSchema" in tool
                  ? { inputSchema: sanitizeMcpInputSchema(tool.inputSchema) }
                  : {})
              }))
          };
        }
      );

      return respondWithAudit(
        isJiraAuthErrorResult(result) ? result : result
      );
    }

    case "atlassian.callMcpTool": {
      if (!isAtlassianMcpToolCallInput(body.input)) {
        return new Response("Invalid tool input", { status: 400 });
      }
      const atlassianInput = body.input;

      if (!isAllowedAtlassianMcpToolName(atlassianInput.name)) {
        return respondWithAudit({
          classification: "user_private",
          content: {
            error: "atlassian_mcp_tool_not_allowed",
            message: `Atlassian MCP tool \`${atlassianInput.name}\` is not enabled for use.`
          }
        });
      }

      const result = await withFreshJiraToken(
        {
          ...defaultDeps,
          refreshJiraAccessToken: (refreshToken) =>
            refreshJiraAccessToken(config, refreshToken),
          saveJiraConnection: (updatedConnection) =>
            store.upsertProviderConnection(updatedConnection),
          ...deps
        },
        connection,
        async (accessToken) => {
          logAtlassianMcpCallStart(
            "http",
            auth.kind === "runtime" ? auth.runtime.id : "legacy",
            atlassianInput.name,
            atlassianInput.arguments
          );
          let upstreamResult: UpstreamMcpToolResult;
          try {
            upstreamResult = await (deps.callAtlassianMcpTool ??
              defaultCallAtlassianMcpTool)({
              url: config.atlassianMcpUrl,
              accessToken,
              name: atlassianInput.name,
              arguments: atlassianInput.arguments
            });
          } catch (error) {
            logAtlassianMcpCallFailure(
              "http",
              auth.kind === "runtime" ? auth.runtime.id : "legacy",
              atlassianInput.name,
              error
            );
            throw error;
          }
          logAtlassianMcpCallFinish(
            "http",
            auth.kind === "runtime" ? auth.runtime.id : "legacy",
            atlassianInput.name,
            upstreamResult
          );
          await verifyJiraAuthForOpaqueAtlassianMcpError(
            upstreamResult,
            accessToken,
            { getJiraUser: deps.getJiraUser ?? defaultDeps.getJiraUser }
          );

          return {
            classification: "user_private" as const,
            content: {
              toolName: atlassianInput.name,
              result: sanitizeUpstreamMcpToolResult(upstreamResult)
            }
          };
        }
      );

      return respondWithAudit(
        isJiraAuthErrorResult(result) ? result : result
      );
    }
  }

  return new Response("Unknown tool", { status: 404 });
}

function authorizeToolGateway(
  config: Config,
  store: TokenStore,
  request: Request
): ToolGatewayAuth | null {
  const bearerToken = readBearerToken(request);
  if (!config.internalApiToken && !bearerToken) {
    return { kind: "legacy" };
  }

  if (config.internalApiToken && bearerToken === config.internalApiToken) {
    return { kind: "legacy" };
  }

  const runtimeId = request.headers.get("x-burble-runtime-id")?.trim();
  if (!runtimeId || !bearerToken) {
    return null;
  }

  const runtime = store.getAgentRuntime(runtimeId);
  if (!runtime || !isRuntimeTokenValid(bearerToken, runtime.authTokenHash)) {
    return null;
  }

  return { kind: "runtime", runtime };
}

function readBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token ? token : null;
}

function isRuntimeTokenValid(token: string, tokenHash: string): boolean {
  const actual = createHash("sha256").update(token).digest("hex");
  if (actual.length !== tokenHash.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(actual), Buffer.from(tokenHash));
}

function isKnownTool(toolName: string): boolean {
  return (
    toolName === "github.getAuthenticatedUser" ||
    toolName === "github.listAssignedIssues" ||
    toolName === "github.searchIssues" ||
    toolName === "github.listMyPullRequests" ||
    toolName === "github.getIssue" ||
    toolName === "github.getPullRequest" ||
    toolName === "github.createIssue" ||
    toolName === "github.updateIssue" ||
    toolName === "github.closeIssue" ||
    toolName === "github.reopenIssue" ||
    toolName === "github.commentOnIssueOrPullRequest" ||
    toolName === "github.createPullRequest" ||
    toolName === "github.updatePullRequest" ||
    toolName === "github.addLabels" ||
    toolName === "github.removeLabels" ||
    toolName === "github.requestReview" ||
    toolName === "github.getFile" ||
    toolName === "github.createOrUpdateFile" ||
    toolName === "github.createBranch" ||
    toolName === "google.getAuthenticatedUser" ||
    toolName === "google.searchDriveFiles" ||
    toolName === "google.getDriveFile" ||
    toolName === "google.createDriveTextFile" ||
    toolName === "google.updateDriveTextFile" ||
    toolName === "google.appendToDriveTextFile" ||
    toolName === "google.createDriveFolder" ||
    toolName === "google.moveDriveFile" ||
    toolName === "google.searchCalendarEvents" ||
    toolName === "google.createCalendarEvent" ||
    toolName === "google.updateCalendarEvent" ||
    toolName === "google.searchMailMessages" ||
    toolName === "gmail.createDraft" ||
    toolName === "hubspot.getAuthenticatedUser" ||
    toolName === "hubspot.searchContacts" ||
    toolName === "hubspot.searchCompanies" ||
    toolName === "hubspot.searchDeals" ||
    toolName === "jira.getAuthenticatedUser" ||
    toolName === "jira.listAccessibleResources" ||
    toolName === "jira.listVisibleProjects" ||
    toolName === "jira.searchUsers" ||
    toolName === "jira.createIssue" ||
    toolName === "jira.editIssue" ||
    toolName === "jira.getIssue" ||
    toolName === "jira.updateIssue" ||
    toolName === "jira.addComment" ||
    toolName === "jira.transitionIssue" ||
    toolName === "jira.addLabels" ||
    toolName === "jira.removeLabels" ||
    toolName === "jira.linkIssues" ||
    toolName === "jira.createSubtask" ||
    toolName === "jira.listAssignedIssues" ||
    toolName === "jira.searchIssues" ||
    toolName === "slack.searchUsers" ||
    toolName === "slack.searchMessages" ||
    toolName === "conversation.sendMessage" ||
    toolName === "conversation.getAttachment" ||
    toolName === "scheduledJob.registerCapability" ||
    toolName === "runtime.heartbeat" ||
    toolName === "atlassian.listMcpTools" ||
    toolName === "atlassian.callMcpTool"
  );
}

function readToolProvider(
  toolName: string
): "github" | "google" | "hubspot" | "jira" | "slack" {
  return toolName.startsWith("slack.")
    ? "slack"
    : toolName.startsWith("hubspot.")
    ? "hubspot"
    : toolName.startsWith("google.") || toolName.startsWith("gmail.")
    ? "google"
    : toolName.startsWith("jira.") || toolName.startsWith("atlassian.")
    ? "jira"
    : "github";
}

function resolveToolGatewayConnection(
  store: TokenStore,
  auth: ToolGatewayAuth,
  provider: "github" | "google" | "hubspot" | "jira" | "slack",
  body: ToolGatewayBody
) {
  if (auth.kind === "runtime") {
    if (typeof body.user?.email === "string" && body.user.email.trim()) {
      return store.getConnection(provider, body.user.email);
    }
    return store.getConnectionForSlackUser(provider, auth.runtime.slackUserId);
  }

  if (typeof body.user?.email !== "string" || !body.user.email.trim()) {
    return null;
  }
  return store.getConnection(provider, body.user.email);
}

function validateAndStripScheduledJobToolGatewayInput(
  store: TokenStore,
  auth: ToolGatewayAuth,
  toolName: string,
  body: ToolGatewayBody
): { body: ToolGatewayBody; response: Response | null } {
  const jobId = readScheduledJobId(body.input);
  if (!jobId) {
    return { body, response: null };
  }
  if (auth.kind !== "runtime") {
    return {
      body,
      response: jsonResponse(
        {
          classification: "user_private",
          content: {
            error: "scheduled_job_runtime_required",
            message: "Scheduled job provider calls require runtime auth."
          }
        },
        403
      )
    };
  }

  const capability = store.getAgentJobCapability(jobId);
  if (!capability) {
    return {
      body,
      response: jsonResponse(
        {
          classification: "user_private",
          content: {
            error: "scheduled_job_not_found",
            message: `Scheduled job capability ${jobId} was not found.`
          }
        },
        403
      )
    };
  }

  try {
    assertScheduledJobCapabilityMatchesRuntime(auth.runtime, capability);
  } catch {
    return {
      body,
      response: jsonResponse(
        {
          classification: "user_private",
          content: {
            error: "scheduled_job_principal_mismatch",
            message: `Scheduled job capability ${jobId} does not belong to this runtime.`
          }
        },
        403
      )
    };
  }

  if (
    !isScheduledJobToolAllowed({
      requiredTools: capability.requiredTools,
      toolName
    })
  ) {
    return {
      body,
      response: jsonResponse(
        {
          classification: "user_private",
          content: {
            error: "scheduled_job_tool_denied",
            message: `Tool ${toolName} is not available to scheduled job ${jobId}.`
          }
        },
        403
      )
    };
  }

  return {
    body: {
      ...body,
      input: stripScheduledJobIds(body.input)
    },
    response: null
  };
}

function readScheduledJobId(input: unknown): string | null {
  if (!isOptionalObject(input)) {
    return null;
  }
  return readStringAlias(input, [
    "jobId",
    "scheduledJobId",
    "job_id",
    "scheduled_job_id"
  ]);
}

function stripScheduledJobIds(input: unknown): unknown {
  if (!isOptionalObject(input)) {
    return input;
  }
  const {
    jobId: _jobId,
    scheduledJobId: _scheduledJobId,
    job_id: _job_id,
    scheduled_job_id: _scheduled_job_id,
    ...rest
  } = input;
  return rest;
}

function readScheduledJobRegisterCapabilityInput(input: unknown):
  | {
      jobId: string;
      requiredTools: string[];
      routeId?: string;
      capabilityProfile?: string;
      runtimeType?: AgentRuntimeEngine;
      stateRefs?: unknown[];
      visibilityPolicy?: unknown;
    }
  | null {
  const normalized = normalizeScheduledJobRegistrationInput(input);
  if (!normalized) {
    return null;
  }
  const jobId = readScheduledJobRegistrationId(normalized);
  const requiredTools = readScheduledJobRegistrationTools(normalized);
  if (
    !jobId ||
    !requiredTools
  ) {
    return null;
  }
  if (
    (normalized.routeId !== undefined &&
      normalized.routeId !== null &&
      !isNonEmptyString(normalized.routeId)) ||
    (normalized.capabilityProfile !== undefined &&
      normalized.capabilityProfile !== null &&
      !isNonEmptyString(normalized.capabilityProfile)) ||
    (normalized.runtimeType !== undefined &&
      normalized.runtimeType !== null &&
      !isAgentRuntimeEngine(normalized.runtimeType)) ||
    (normalized.stateRefs !== undefined &&
      normalized.stateRefs !== null &&
      !isScheduledJobStateRefArray(normalized.stateRefs))
  ) {
    return null;
  }

  return {
    jobId,
    requiredTools,
    ...(typeof normalized.routeId === "string" ? { routeId: normalized.routeId } : {}),
    ...(typeof normalized.capabilityProfile === "string"
      ? { capabilityProfile: normalized.capabilityProfile }
      : {}),
    ...(isAgentRuntimeEngine(normalized.runtimeType)
      ? { runtimeType: normalized.runtimeType }
      : {}),
    ...(isScheduledJobStateRefArray(normalized.stateRefs)
      ? { stateRefs: normalized.stateRefs }
      : {}),
    ...(normalized.visibilityPolicy !== undefined
      ? { visibilityPolicy: normalized.visibilityPolicy }
      : {})
  };
}

function describeScheduledJobRegisterCapabilityInputError(
  input: unknown
): string | null {
  if (!isOptionalObject(input)) {
    return "scheduledJob.registerCapability requires an object input.";
  }

  const normalized = normalizeScheduledJobRegistrationInput(input);
  if (!normalized) {
    return "scheduledJob.registerCapability requires an object input.";
  }

  if (!readScheduledJobRegistrationId(normalized)) {
    return "scheduledJob.registerCapability requires jobId, scheduledJobId, job_id, or scheduled_job_id to be a non-empty string.";
  }

  if (!readScheduledJobRegistrationTools(normalized)) {
    return "scheduledJob.registerCapability requires requiredTools, allowedTools, required_tools, allowed_tools, or tools to be a non-empty string, string array, or tool descriptor array.";
  }

  if (
    normalized.routeId !== undefined &&
    normalized.routeId !== null &&
    !isNonEmptyString(normalized.routeId)
  ) {
    return "scheduledJob.registerCapability requires routeId to be a non-empty string when provided.";
  }

  if (
    normalized.capabilityProfile !== undefined &&
    normalized.capabilityProfile !== null &&
    !isNonEmptyString(normalized.capabilityProfile)
  ) {
    return "scheduledJob.registerCapability requires capabilityProfile to be a non-empty string when provided.";
  }

  if (
    normalized.runtimeType !== undefined &&
    normalized.runtimeType !== null &&
    !isAgentRuntimeEngine(normalized.runtimeType)
  ) {
    return "scheduledJob.registerCapability requires runtimeType to be a supported runtime engine when provided.";
  }

  if (
    normalized.stateRefs !== undefined &&
    normalized.stateRefs !== null &&
    !Array.isArray(normalized.stateRefs)
  ) {
    return "scheduledJob.registerCapability requires stateRefs to be an object or array of objects when provided.";
  }

  if (
    Array.isArray(normalized.stateRefs) &&
    !isScheduledJobStateRefArray(normalized.stateRefs)
  ) {
    return "scheduledJob.registerCapability requires every stateRefs entry to include provider and kind strings.";
  }

  return null;
}

function describeScheduledJobRegisterCapabilityInput(
  input: unknown
): { receivedKeys: string[]; nestedKeys: string[]; normalizedKeys: string[] } {
  const receivedKeys = isOptionalObject(input)
    ? Object.keys(input).sort()
    : [];
  const nested =
    isOptionalObject(input)
      ? readObjectAlias(input, ["scheduledJob", "scheduled_job", "capability"])
      : null;
  const nestedKeys = nested ? Object.keys(nested).sort() : [];
  const normalized = normalizeScheduledJobRegistrationInput(input);
  const normalizedKeys = normalized
    ? Object.entries(normalized)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
        .sort()
    : [];
  return { receivedKeys, nestedKeys, normalizedKeys };
}

type ScheduledJobRegistrationInput = {
  jobId?: unknown;
  requiredTools?: unknown;
  routeId?: unknown;
  capabilityProfile?: unknown;
  runtimeType?: unknown;
  stateRefs?: unknown;
  visibilityPolicy?: unknown;
};

function normalizeScheduledJobRegistrationInput(
  input: unknown
): ScheduledJobRegistrationInput | null {
  if (!isOptionalObject(input)) {
    return null;
  }

  const source =
    readObjectAlias(input, ["scheduledJob", "scheduled_job", "capability"]) ??
    input;

  return {
    jobId: readUnknownAlias(source, [
      "jobId",
      "scheduledJobId",
      "job_id",
      "scheduled_job_id"
    ]),
    requiredTools: readUnknownAlias(source, [
      "requiredTools",
      "allowedTools",
      "required_tools",
      "allowed_tools",
      "tools"
    ]),
    routeId: readUnknownAlias(source, ["routeId", "route_id"]),
    capabilityProfile: readUnknownAlias(source, [
      "capabilityProfile",
      "capability_profile"
    ]),
    runtimeType: normalizeScheduledJobRuntimeType(
      readUnknownAlias(source, ["runtimeType", "runtime_type"])
    ),
    stateRefs: normalizeScheduledJobStateRefs(
      readUnknownAlias(source, ["stateRefs", "state_refs"])
    ),
    visibilityPolicy: readUnknownAlias(source, [
      "visibilityPolicy",
      "visibility_policy"
    ])
  };
}

function readScheduledJobRegistrationId(
  input: ScheduledJobRegistrationInput
): string | null {
  const jobId = input.jobId;
  return typeof jobId === "string" && jobId.trim() ? jobId.trim() : null;
}

function readScheduledJobRegistrationTools(
  input: ScheduledJobRegistrationInput
): string[] | null {
  return normalizeScheduledJobRegistrationTools(input.requiredTools);
}

function normalizeScheduledJobRegistrationTools(value: unknown): string[] | null {
  if (typeof value === "string") {
    const tools = value
      .split(/[,\s]+/)
      .map((toolName) => toolName.trim())
      .filter(Boolean);
    return tools.length ? tools.slice(0, 100) : null;
  }
  if (Array.isArray(value)) {
    const tools = value
      .map((item) => {
        if (typeof item === "string") {
          return item.trim();
        }
        if (isOptionalObject(item)) {
          return readStringAlias(item, [
            "name",
            "toolName",
            "tool_name",
            "tool"
          ]) ?? "";
        }
        return "";
      })
      .filter(Boolean);
    return tools.length ? tools.slice(0, 100) : null;
  }
  if (isOptionalObject(value)) {
    const tools = Object.entries(value)
      .filter(([, enabled]) => enabled !== false && enabled !== null)
      .map(([toolName, descriptor]) => {
        if (isOptionalObject(descriptor)) {
          return (
            readStringAlias(descriptor, [
              "name",
              "toolName",
              "tool_name",
              "tool"
            ]) ?? toolName
          );
        }
        return toolName;
      })
      .map((toolName) => toolName.trim())
      .filter(Boolean);
    return tools.length ? tools.slice(0, 100) : null;
  }
  return null;
}

function normalizeScheduledJobStateRefs(value: unknown): unknown[] | unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (isOptionalObject(value)) {
    return [value];
  }
  return value;
}

function isScheduledJobStateRefArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.every(isScheduledJobStateRefInput);
}

function isScheduledJobStateRefInput(value: unknown): boolean {
  if (!isOptionalObject(value)) {
    return false;
  }
  return (
    typeof value.provider === "string" &&
    value.provider.trim().length > 0 &&
    typeof value.kind === "string" &&
    value.kind.trim().length > 0
  );
}

function normalizeScheduledJobRuntimeType(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "nemo-hermes" || normalized === "nemo_hermes") {
    return "hermes";
  }
  if (
    normalized === "openclaw-nemoclaw" ||
    normalized === "openclaw_nemoclaw"
  ) {
    return "openclaw";
  }
  return value;
}

function readUnknownAlias(
  input: Record<string, unknown>,
  names: string[]
): unknown {
  for (const name of names) {
    if (name in input) {
      return input[name];
    }
  }
  return undefined;
}

function readStringAlias(
  input: Record<string, unknown>,
  names: string[]
): string | null {
  const value = readUnknownAlias(input, names);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readObjectAlias(
  input: Record<string, unknown>,
  names: string[]
): Record<string, unknown> | null {
  const value = readUnknownAlias(input, names);
  return isOptionalObject(value) ? value : null;
}

function isAgentRuntimeEngine(value: unknown): value is AgentRuntimeEngine {
  return (
    value === "deterministic" ||
    value === "openclaw" ||
    value === "openclaw-gateway" ||
    value === "burble-direct" ||
    value === "hermes"
  );
}

function buildScheduledJobPromptInstruction(
  scheduledJob: ReturnType<typeof buildScheduledJobContext>
): string {
  const bridgeExamples = scheduledJob.allowedTools.map((toolName) => {
    const input = {
      jobId: scheduledJob.jobId
    };
    return `- burble_provider_call with ${JSON.stringify({
      toolName,
      input
    })}`;
  });
  const lines = [
    "Use Burble provider calls with this jobId for this scheduled job.",
    `jobId=${scheduledJob.jobId}`,
    `allowedTools=${scheduledJob.allowedTools.join(",")}`,
    `capabilityProfile=${scheduledJob.capabilityProfile}`,
    ...(scheduledJob.routeId ? [`routeId=${scheduledJob.routeId}`] : []),
    `maxOutputVisibility=${scheduledJob.visibilityPolicy.maxOutputVisibility ?? "user_private"}`,
    `allowPrivateToolDeclassification=${scheduledJob.visibilityPolicy.allowPrivateToolDeclassification === true ? "true" : "false"}`
  ];
  if (scheduledJob.stateRefs.length) {
    lines.push(`stateRefs=${JSON.stringify(scheduledJob.stateRefs)}`);
  }
  lines.push(
    "These allowedTools are Burble provider tool names, not necessarily native runtime tool names.",
    "Use the runtime's Burble provider bridge tool burble_provider_call for these tools.",
    "Provider bridge call examples:",
    ...bridgeExamples,
    "Do not call these provider tool names as native tools unless the runtime explicitly exposes equivalent direct aliases.",
    "Do not use direct web/browser access to provider URLs such as Google Drive, GitHub, Jira, Gmail, Calendar, or Slack URLs for this state.",
    "For every scheduled provider call, include this jobId in the tool input and use only the listed allowedTools."
  );
  return lines.join("\n");
}

async function readToolGatewayBody(
  request: Request
): Promise<ToolGatewayBody | null> {
  try {
    return (await request.json()) as ToolGatewayBody;
  } catch {
    return null;
  }
}

function isSearchIssuesInput(input: unknown): input is { query: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    "query" in input &&
    typeof input.query === "string" &&
    input.query.trim().length > 0
  );
}

function isListMyPullRequestsInput(
  input: unknown
): input is GitHubPullRequestListInput {
  if (input === undefined || input === null) {
    return true;
  }
  if (typeof input !== "object") {
    return false;
  }
  const candidate = input as GitHubPullRequestListInput;
  return (
    (candidate.limit === undefined ||
      (Number.isInteger(candidate.limit) &&
        candidate.limit >= 1 &&
        candidate.limit <= 20)) &&
    (candidate.state === undefined ||
      candidate.state === "open" ||
      candidate.state === "closed" ||
      candidate.state === "all") &&
    (candidate.sort === undefined ||
      candidate.sort === "updated" ||
      candidate.sort === "created" ||
      candidate.sort === "comments") &&
    (candidate.order === undefined ||
      candidate.order === "desc" ||
      candidate.order === "asc") &&
    (candidate.owner === undefined ||
      isGitHubOwner(candidate.owner)) &&
    (candidate.repo === undefined ||
      isGitHubRepo(candidate.repo))
  );
}

function isGitHubOwner(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+$/.test(value.trim());
}

function isGitHubRepo(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.trim())
  );
}

function isCreateGitHubIssueInput(input: unknown): input is {
  repo: string;
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
} {
  return (
    isOptionalObject(input) &&
    isNonEmptyString(input.repo) &&
    isNonEmptyString(input.title) &&
    optionalString(input.body) &&
    optionalStringArray(input.labels, 20) &&
    optionalStringArray(input.assignees, 20)
  );
}

function isGitHubIssueNumberInput(input: unknown): input is {
  repo: string;
  number: number;
} {
  return (
    isOptionalObject(input) &&
    isGitHubRepo(input.repo) &&
    isPositiveInteger(input.number)
  );
}

function isUpdateGitHubIssueInput(input: unknown): input is {
  repo: string;
  number: number;
  title?: string;
  body?: string;
  state?: "open" | "closed";
  labels?: string[];
  assignees?: string[];
} {
  return (
    isOptionalObject(input) &&
    isGitHubRepo(input.repo) &&
    isPositiveInteger(input.number) &&
    optionalString(input.title) &&
    optionalString(input.body) &&
    (input.state === undefined ||
      input.state === "open" ||
      input.state === "closed") &&
    optionalStringArray(input.labels, 20) &&
    optionalStringArray(input.assignees, 20) &&
    (isNonEmptyString(input.title) ||
      typeof input.body === "string" ||
      input.state === "open" ||
      input.state === "closed" ||
      stringArray(input.labels, 20) ||
      stringArray(input.assignees, 20))
  );
}

function isGitHubCommentInput(input: unknown): input is {
  repo: string;
  number: number;
  body: string;
} {
  return (
    isOptionalObject(input) &&
    isNonEmptyString(input.repo) &&
    isPositiveInteger(input.number) &&
    isNonEmptyString(input.body)
  );
}

function isCreateGitHubPullRequestInput(input: unknown): input is {
  repo: string;
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
} {
  return (
    isOptionalObject(input) &&
    isNonEmptyString(input.repo) &&
    isNonEmptyString(input.title) &&
    isNonEmptyString(input.head) &&
    isNonEmptyString(input.base) &&
    optionalString(input.body) &&
    optionalBoolean(input.draft)
  );
}

function isUpdateGitHubPullRequestInput(input: unknown): input is {
  repo: string;
  number: number;
  title?: string;
  body?: string;
  base?: string;
  draft?: boolean;
} {
  return (
    isOptionalObject(input) &&
    isNonEmptyString(input.repo) &&
    isPositiveInteger(input.number) &&
    optionalString(input.title) &&
    optionalString(input.body) &&
    optionalString(input.base) &&
    optionalBoolean(input.draft) &&
    (isNonEmptyString(input.title) ||
      typeof input.body === "string" ||
      isNonEmptyString(input.base) ||
      typeof input.draft === "boolean")
  );
}

function isGitHubLabelsInput(input: unknown): input is {
  repo: string;
  number: number;
  labels: string[];
} {
  return (
    isOptionalObject(input) &&
    isNonEmptyString(input.repo) &&
    isPositiveInteger(input.number) &&
    stringArray(input.labels, 20)
  );
}

function isGitHubRequestReviewInput(input: unknown): input is {
  repo: string;
  number: number;
  reviewers?: string[];
  teamReviewers?: string[];
} {
  return (
    isOptionalObject(input) &&
    isNonEmptyString(input.repo) &&
    isPositiveInteger(input.number) &&
    optionalStringArray(input.reviewers, 20) &&
    optionalStringArray(input.teamReviewers, 20) &&
    (stringArray(input.reviewers, 20) || stringArray(input.teamReviewers, 20))
  );
}

function isGitHubGetFileInput(input: unknown): input is {
  repo: string;
  path: string;
  ref?: string;
} {
  return (
    isOptionalObject(input) &&
    isGitHubRepo(input.repo) &&
    isNonEmptyString(input.path) &&
    optionalString(input.ref)
  );
}

function isGitHubCreateOrUpdateFileInput(input: unknown): input is {
  repo: string;
  path: string;
  content: string;
  message: string;
  branch?: string;
  sha?: string;
} {
  return (
    isOptionalObject(input) &&
    isGitHubRepo(input.repo) &&
    isNonEmptyString(input.path) &&
    typeof input.content === "string" &&
    input.content.length <= 1_000_000 &&
    isNonEmptyString(input.message) &&
    optionalString(input.branch) &&
    optionalString(input.sha)
  );
}

function isGitHubCreateBranchInput(input: unknown): input is {
  repo: string;
  branch: string;
  fromRef?: string;
} {
  return (
    isOptionalObject(input) &&
    isGitHubRepo(input.repo) &&
    isNonEmptyString(input.branch) &&
    optionalString(input.fromRef)
  );
}

function isSearchGoogleDriveFilesInput(input: unknown): input is {
  query?: string;
  limit?: number;
} {
  return isOptionalObject(input) && optionalString(input.query) && optionalLimit(input.limit, 20);
}

function isGetGoogleDriveFileInput(input: unknown): input is {
  fileId: string;
  includeContent?: boolean;
} {
  return (
    isOptionalObject(input) &&
    isNonEmptyString(input.fileId) &&
    optionalBoolean(input.includeContent)
  );
}

function isCreateGoogleDriveTextFileInput(input: unknown): input is {
  name: string;
  text?: string;
  mimeType?: string;
} {
  if (!isOptionalObject(input)) {
    return false;
  }
  const text = input.text;
  return (
    typeof input.name === "string" &&
    input.name.trim().length > 0 &&
    input.name.length <= 200 &&
    (text === undefined ||
      (typeof text === "string" && text.length <= 200_000)) &&
    optionalString(input.mimeType)
  );
}

function isUpdateGoogleDriveTextFileInput(input: unknown): input is {
  fileId: string;
  text: string;
  mimeType?: string;
} {
  return (
    isOptionalObject(input) &&
    isNonEmptyString(input.fileId) &&
    typeof input.text === "string" &&
    input.text.length <= 200_000 &&
    optionalString(input.mimeType)
  );
}

function isAppendGoogleDriveTextFileInput(input: unknown): input is {
  fileId: string;
  text: string;
  separator?: string;
  mimeType?: string;
} {
  return (
    isOptionalObject(input) &&
    isNonEmptyString(input.fileId) &&
    typeof input.text === "string" &&
    input.text.length <= 200_000 &&
    optionalString(input.separator) &&
    optionalString(input.mimeType)
  );
}

function isCreateGoogleDriveFolderInput(input: unknown): input is {
  name: string;
  parentId?: string;
} {
  return (
    isOptionalObject(input) &&
    isNonEmptyString(input.name) &&
    input.name.length <= 200 &&
    optionalString(input.parentId)
  );
}

function isMoveGoogleDriveFileInput(input: unknown): input is {
  fileId: string;
  parentId: string;
  removeParentIds?: string[];
} {
  return (
    isOptionalObject(input) &&
    isNonEmptyString(input.fileId) &&
    isNonEmptyString(input.parentId) &&
    optionalStringArray(input.removeParentIds, 20)
  );
}

function isSearchGoogleCalendarEventsInput(input: unknown): input is {
  query?: string;
  timeMin?: string;
  timeMax?: string;
  limit?: number;
} {
  return (
    isOptionalObject(input) &&
    optionalString(input.query) &&
    optionalString(input.timeMin) &&
    optionalString(input.timeMax) &&
    optionalLimit(input.limit, 20)
  );
}

function isCreateGoogleCalendarEventInput(input: unknown): input is {
  calendarId?: string;
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  timeZone?: string;
  attendees?: string[];
} {
  return (
    isOptionalObject(input) &&
    optionalString(input.calendarId) &&
    isNonEmptyString(input.summary) &&
    optionalString(input.description) &&
    optionalString(input.location) &&
    isNonEmptyString(input.start) &&
    isNonEmptyString(input.end) &&
    optionalString(input.timeZone) &&
    optionalStringArray(input.attendees, 50)
  );
}

function isUpdateGoogleCalendarEventInput(input: unknown): input is {
  calendarId?: string;
  eventId: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  attendees?: string[];
} {
  return (
    isOptionalObject(input) &&
    optionalString(input.calendarId) &&
    isNonEmptyString(input.eventId) &&
    optionalString(input.summary) &&
    optionalString(input.description) &&
    optionalString(input.location) &&
    optionalString(input.start) &&
    optionalString(input.end) &&
    optionalString(input.timeZone) &&
    optionalStringArray(input.attendees, 50) &&
    (isNonEmptyString(input.summary) ||
      typeof input.description === "string" ||
      typeof input.location === "string" ||
      isNonEmptyString(input.start) ||
      isNonEmptyString(input.end) ||
      typeof input.timeZone === "string" ||
      stringArray(input.attendees, 50))
  );
}

function isSearchGoogleMailMessagesInput(input: unknown): input is {
  query: string;
  limit?: number;
} {
  return (
    isOptionalObject(input) &&
    typeof input.query === "string" &&
    input.query.trim().length > 0 &&
    optionalLimit(input.limit, 10)
  );
}

function isCreateGmailDraftInput(input: unknown): input is {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
} {
  return (
    isOptionalObject(input) &&
    stringArray(input.to, 50) &&
    isNonEmptyString(input.subject) &&
    typeof input.body === "string" &&
    input.body.length <= 200_000 &&
    optionalStringArray(input.cc, 50) &&
    optionalStringArray(input.bcc, 50)
  );
}

function isHubSpotSearchInput(input: unknown): input is {
  query: string;
  limit?: number;
} {
  return (
    isOptionalObject(input) &&
    isNonEmptyString(input.query) &&
    input.query.length <= 200 &&
    (input.limit === undefined ||
      (isPositiveInteger(input.limit) && input.limit <= 20))
  );
}

function isSearchJiraIssuesInput(input: unknown): input is { jql: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    "jql" in input &&
    typeof input.jql === "string" &&
    input.jql.trim().length > 0
  );
}

function isOptionalObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function optionalLimit(value: unknown, max: number): boolean {
  return (
    value === undefined ||
    (typeof value === "number" &&
      Number.isInteger(value) &&
      value > 0 &&
      value <= max)
  );
}

function isSearchJiraUsersInput(input: unknown): input is { query: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    "query" in input &&
    typeof input.query === "string" &&
    input.query.trim().length > 0
  );
}

function isSearchSlackUsersInput(input: unknown): input is { query: string } {
  return isSearchJiraUsersInput(input);
}

function isSearchSlackMessagesInput(input: unknown): input is {
  query: string;
  fromUserId?: string;
  inChannel?: string;
  limit?: number;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const record = input as Record<string, unknown>;
  return (
    typeof record.query === "string" &&
    record.query.trim().length > 0 &&
    optionalString(record.fromUserId) &&
    optionalString(record.inChannel) &&
    (record.limit === undefined ||
      (typeof record.limit === "number" &&
        Number.isInteger(record.limit) &&
        record.limit > 0 &&
        record.limit <= 20))
  );
}

function isCreateJiraIssueInput(input: unknown): input is {
  projectKey: string;
  issueTypeName?: string;
  issueTypeId?: string;
  summary: string;
  description?: string;
  assigneeAccountId?: string;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const record = input as Record<string, unknown>;
  return (
    typeof record.projectKey === "string" &&
    record.projectKey.trim().length > 0 &&
    ((typeof record.issueTypeName === "string" &&
      record.issueTypeName.trim().length > 0) ||
      (typeof record.issueTypeId === "string" &&
        record.issueTypeId.trim().length > 0)) &&
    typeof record.summary === "string" &&
    record.summary.trim().length > 0 &&
    optionalString(record.description) &&
    optionalString(record.assigneeAccountId)
  );
}

function isEditJiraIssueInput(input: unknown): input is {
  issueKey: string;
  summary?: string;
  description?: string;
  assigneeAccountId?: string | null;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const record = input as Record<string, unknown>;
  return (
    typeof record.issueKey === "string" &&
    record.issueKey.trim().length > 0 &&
    optionalString(record.summary) &&
    optionalString(record.description) &&
    (record.assigneeAccountId === undefined ||
      record.assigneeAccountId === null ||
      typeof record.assigneeAccountId === "string") &&
    (typeof record.summary === "string" ||
      typeof record.description === "string" ||
      typeof record.assigneeAccountId === "string" ||
      record.assigneeAccountId === null)
  );
}

function isJiraIssueKeyInput(input: unknown): input is { issueKey: string } {
  return isOptionalObject(input) && isNonEmptyString(input.issueKey);
}

function isUpdateJiraIssueInput(input: unknown): input is {
  issueKey: string;
  summary?: string;
  description?: string;
  assigneeAccountId?: string | null;
  labels?: string[];
} {
  return (
    isOptionalObject(input) &&
    isNonEmptyString(input.issueKey) &&
    optionalString(input.summary) &&
    optionalString(input.description) &&
    (input.assigneeAccountId === undefined ||
      input.assigneeAccountId === null ||
      typeof input.assigneeAccountId === "string") &&
    optionalStringArray(input.labels, 50) &&
    (isNonEmptyString(input.summary) ||
      typeof input.description === "string" ||
      typeof input.assigneeAccountId === "string" ||
      input.assigneeAccountId === null ||
      stringArray(input.labels, 50))
  );
}

function isJiraCommentInput(input: unknown): input is {
  issueKey: string;
  body: string;
} {
  return (
    isOptionalObject(input) &&
    isNonEmptyString(input.issueKey) &&
    isNonEmptyString(input.body)
  );
}

function isJiraTransitionInput(input: unknown): input is {
  issueKey: string;
  transitionId?: string;
  transitionName?: string;
} {
  return (
    isOptionalObject(input) &&
    isNonEmptyString(input.issueKey) &&
    optionalString(input.transitionId) &&
    optionalString(input.transitionName) &&
    (isNonEmptyString(input.transitionId) ||
      isNonEmptyString(input.transitionName))
  );
}

function isJiraLabelsInput(input: unknown): input is {
  issueKey: string;
  labels: string[];
} {
  return (
    isOptionalObject(input) &&
    isNonEmptyString(input.issueKey) &&
    stringArray(input.labels, 50)
  );
}

function isJiraLinkIssuesInput(input: unknown): input is {
  inwardIssueKey: string;
  outwardIssueKey: string;
  typeName?: string;
  comment?: string;
} {
  return (
    isOptionalObject(input) &&
    isNonEmptyString(input.inwardIssueKey) &&
    isNonEmptyString(input.outwardIssueKey) &&
    optionalString(input.typeName) &&
    optionalString(input.comment)
  );
}

function isCreateJiraSubtaskInput(input: unknown): input is {
  parentIssueKey: string;
  summary: string;
  projectKey?: string;
  issueTypeName?: string;
  issueTypeId?: string;
  description?: string;
  assigneeAccountId?: string;
} {
  return (
    isOptionalObject(input) &&
    isNonEmptyString(input.parentIssueKey) &&
    isNonEmptyString(input.summary) &&
    optionalString(input.projectKey) &&
    optionalString(input.issueTypeName) &&
    optionalString(input.issueTypeId) &&
    optionalString(input.description) &&
    optionalString(input.assigneeAccountId)
  );
}

function isListVisibleJiraProjectsInput(
  input: unknown
): input is {
  query?: string;
  action?: "view" | "browse" | "edit" | "create";
  expandIssueTypes?: boolean;
} {
  if (input === undefined) {
    return true;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }

  const record = input as Record<string, unknown>;
  return (
    (!("query" in record) ||
      record.query === undefined ||
      typeof record.query === "string") &&
    (!("action" in record) ||
      record.action === undefined ||
      record.action === "view" ||
      record.action === "browse" ||
      record.action === "edit" ||
      record.action === "create") &&
    (!("expandIssueTypes" in record) ||
      record.expandIssueTypes === undefined ||
      typeof record.expandIssueTypes === "boolean")
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function optionalStringArray(value: unknown, max: number): boolean {
  return value === undefined || stringArray(value, max);
}

function stringArray(value: unknown, max: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= max &&
    value.every(isNonEmptyString)
  );
}

function isConversationSendInput(
  input: unknown
): input is {
  text: string;
  routeId?: string;
  attachments?: ConversationAttachment[];
} {
  const attachments =
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    isConversationAttachmentArray((input as { attachments?: unknown }).attachments)
      ? (input as { attachments: ConversationAttachment[] }).attachments
      : undefined;

  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "text" in input &&
    typeof input.text === "string" &&
    (hasVisibleText(input.text) || Boolean(attachments?.length)) &&
    input.text.length <= 4000 &&
    (!("attachments" in input) ||
      input.attachments === undefined ||
      isConversationAttachmentArray(input.attachments)) &&
    (!("routeId" in input) ||
      input.routeId === undefined ||
      (typeof input.routeId === "string" && input.routeId.trim().length > 0))
  );
}

function isConversationGetAttachmentInput(
  input: unknown
): input is { attachmentId: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "attachmentId" in input &&
    typeof input.attachmentId === "string" &&
    input.attachmentId.trim().length > 0
  );
}

function hasVisibleText(value: string): boolean {
  return value.replace(/[\s\p{Default_Ignorable_Code_Point}]/gu, "").length > 0;
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

function isActiveConversation(conversation: unknown): conversation is {
  source: "slack";
  workspaceId: string;
  channelId: string;
  rootId: string;
  isDirectMessage: boolean;
} {
  if (
    typeof conversation !== "object" ||
    conversation === null ||
    Array.isArray(conversation)
  ) {
    return false;
  }

  const record = conversation as Record<string, unknown>;
  return (
    record.source === "slack" &&
    typeof record.workspaceId === "string" &&
    record.workspaceId.trim().length > 0 &&
    typeof record.channelId === "string" &&
    record.channelId.trim().length > 0 &&
    typeof record.rootId === "string" &&
    record.rootId.trim().length > 0 &&
    typeof record.isDirectMessage === "boolean"
  );
}

function readConversationThread(conversation: {
  rootId: string;
}): { threadTs?: string } {
  const match = conversation.rootId.match(/^(?:channel|dm):[^:]+:thread:(.+)$/);
  const threadTs = match?.[1]?.trim();
  return threadTs ? { threadTs } : {};
}

function resolveActiveConversationDestination(
  runtime: AgentRuntimeRecord,
  conversation: unknown
):
  | {
      ok: true;
      transport: "slack";
      channelId: string;
      threadTs?: string;
    }
  | { ok: false; status: number; message: string } {
  if (!isActiveConversation(conversation)) {
    return { ok: false, status: 400, message: "Invalid tool input" };
  }
  if (conversation.workspaceId !== runtime.workspaceId) {
    return {
      ok: false,
      status: 403,
      message: "Runtime principal mismatch"
    };
  }

  return {
    ok: true,
    transport: conversation.source,
    channelId: conversation.channelId,
    ...readConversationThread(conversation)
  };
}

function resolveConversationRouteDestination(
  store: TokenStore,
  runtime: AgentRuntimeRecord,
  routeId: string
):
  | {
      ok: true;
      transport: "slack";
      channelId: string;
      threadTs?: string;
    }
  | { ok: false; status: number; message: string } {
  const route = store.getConversationRoute(routeId);
  if (!route) {
    return { ok: false, status: 404, message: "Conversation route not found" };
  }
  if (route.revokedAt) {
    return { ok: false, status: 410, message: "Conversation route revoked" };
  }
  if (
    route.workspaceId !== runtime.workspaceId ||
    route.slackUserId !== runtime.slackUserId
  ) {
    return {
      ok: false,
      status: 403,
      message: "Runtime principal mismatch"
    };
  }
  if (route.transport !== "slack") {
    return {
      ok: false,
      status: 400,
      message: "Unsupported conversation transport"
    };
  }

  const destination = readSlackRouteDestination(route.destinationJson);
  if (!destination) {
    return {
      ok: false,
      status: 400,
      message: "Invalid conversation route"
    };
  }
  if (destination.runtimeId && destination.runtimeId !== runtime.id) {
    return {
      ok: false,
      status: 403,
      message: "Runtime route mismatch"
    };
  }

  return {
    ok: true,
    transport: "slack",
    ...destination
  };
}

function readSlackRouteDestination(
  destinationJson: string
): { channelId: string; threadTs?: string; runtimeId?: string } | null {
  try {
    const parsed = JSON.parse(destinationJson) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    if (
      typeof record.channelId !== "string" ||
      record.channelId.trim().length === 0
    ) {
      return null;
    }
    if (
      "threadTs" in record &&
      record.threadTs !== undefined &&
      typeof record.threadTs !== "string"
    ) {
      return null;
    }
    if (
      "runtimeId" in record &&
      record.runtimeId !== undefined &&
      typeof record.runtimeId !== "string"
    ) {
      return null;
    }

    return {
      channelId: record.channelId,
      ...(typeof record.threadTs === "string" && record.threadTs.trim()
        ? { threadTs: record.threadTs }
        : {}),
      ...(typeof record.runtimeId === "string" && record.runtimeId.trim()
        ? { runtimeId: record.runtimeId }
        : {})
    };
  } catch {
    return null;
  }
}

function isAtlassianMcpToolCallInput(
  input: unknown
): input is { name: string; arguments?: Record<string, unknown> } {
  if (
    typeof input !== "object" ||
    input === null ||
    !("name" in input) ||
    typeof input.name !== "string" ||
    input.name.trim().length === 0
  ) {
    return false;
  }

  return (
    !("arguments" in input) ||
    input.arguments === undefined ||
    (typeof input.arguments === "object" &&
      input.arguments !== null &&
      !Array.isArray(input.arguments))
  );
}

function defaultListAtlassianMcpTools(input: {
  url: string;
  accessToken: string;
}): Promise<UpstreamMcpTool[]> {
  return listUpstreamMcpTools({
    url: input.url,
    authorization: `Bearer ${input.accessToken}`,
    clientName: "burble-atlassian-mcp-facade",
    clientVersion: "0.1.0"
  });
}

function defaultCallAtlassianMcpTool(input: {
  url: string;
  accessToken: string;
  name: string;
  arguments?: Record<string, unknown>;
}): Promise<UpstreamMcpToolResult> {
  return callUpstreamMcpTool(
    {
      url: input.url,
      authorization: `Bearer ${input.accessToken}`,
      clientName: "burble-atlassian-mcp-facade",
      clientVersion: "0.1.0"
    },
    {
      name: input.name,
      arguments: input.arguments
    }
  );
}

async function defaultPostActiveConversationMessage(
  config: Config,
  input: {
    transport: "slack";
    channelId: string;
    text: string;
    attachments?: ConversationAttachment[];
    threadTs?: string;
  }
): Promise<{ transport: "slack"; channelId: string; messageId?: string }> {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.slackBotToken}`,
      "content-type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      channel: input.channelId,
      text: renderTextWithAttachments(input.text, input.attachments),
      ...(input.threadTs ? { thread_ts: input.threadTs } : {})
    })
  });

  const body = (await response.json()) as {
    ok?: boolean;
    error?: string;
    channel?: string;
    ts?: string;
  };
  if (!response.ok || !body.ok) {
    throw new Error(
      `Slack message send failed: ${body.error ?? `HTTP ${response.status}`}`
    );
  }

  return {
    transport: "slack",
    channelId: body.channel ?? input.channelId,
    ...(body.ts ? { messageId: body.ts } : {})
  };
}

async function defaultFetchConversationAttachment(
  config: Config,
  input: {
    attachment: ConversationAttachment;
    maxBytes: number;
  }
): Promise<ConversationAttachmentContent> {
  if (input.attachment.source !== "slack" || !input.attachment.externalId) {
    throw new Error("Only Slack attachments can be fetched");
  }

  const infoUrl = new URL("https://slack.com/api/files.info");
  infoUrl.searchParams.set("file", input.attachment.externalId);
  const infoResponse = await fetch(infoUrl, {
    headers: {
      authorization: `Bearer ${config.slackBotToken}`
    }
  });
  const infoBody = (await infoResponse.json()) as {
    ok?: boolean;
    error?: string;
    file?: {
      name?: string;
      title?: string;
      mimetype?: string;
      size?: number;
      url_private?: string;
      url_private_download?: string;
    };
  };
  if (!infoResponse.ok || !infoBody.ok || !infoBody.file) {
    throw new Error(
      `Slack file lookup failed: ${infoBody.error ?? `HTTP ${infoResponse.status}`}`
    );
  }

  const fileSize = infoBody.file.size ?? input.attachment.sizeBytes;
  if (typeof fileSize === "number" && fileSize > input.maxBytes) {
    throw new Error("Slack file is too large to fetch");
  }

  const fileUrl = infoBody.file.url_private_download ?? infoBody.file.url_private;
  if (!fileUrl) {
    throw new Error("Slack file has no private download URL");
  }

  const fileResponse = await fetch(fileUrl, {
    headers: {
      authorization: `Bearer ${config.slackBotToken}`
    }
  });
  if (!fileResponse.ok) {
    throw new Error(`Slack file download failed: HTTP ${fileResponse.status}`);
  }

  const buffer = Buffer.from(await fileResponse.arrayBuffer());
  if (buffer.byteLength > input.maxBytes) {
    throw new Error("Slack file is too large to fetch");
  }

  const mimeType =
    infoBody.file.mimetype?.trim() || input.attachment.mimeType || "application/octet-stream";
  const attachment: ConversationAttachment = {
    ...input.attachment,
    mimeType,
    ...(infoBody.file.name || infoBody.file.title
      ? { name: infoBody.file.name ?? infoBody.file.title }
      : {}),
    sizeBytes: buffer.byteLength
  };
  const text = renderAttachmentTextPreview(mimeType, buffer);
  return {
    attachment,
    contentBase64: buffer.toString("base64"),
    ...(text ? { text } : {})
  };
}

function renderAttachmentTextPreview(
  mimeType: string,
  buffer: Buffer
): string | undefined {
  if (
    !/^text\//i.test(mimeType) &&
    !/(json|xml|yaml|markdown|javascript|typescript)$/i.test(mimeType)
  ) {
    return undefined;
  }

  return buffer.toString("utf8").slice(0, maxConversationAttachmentTextChars);
}

function renderTextWithAttachments(
  text: string,
  attachments?: ConversationAttachment[]
): string {
  if (!attachments || attachments.length === 0) {
    return text;
  }

  return [
    text,
    "",
    "*Attachments:*",
    ...attachments.map((attachment) => {
      const label = attachment.name ?? attachment.id;
      return `- ${label} (${attachment.kind}, ${attachment.mimeType})`;
    })
  ].join("\n");
}

const allowedMutatingAtlassianMcpTools = new Set([
  "addcommenttojiraissue",
  "addworklogtojiraissue",
  "createjiraissue",
  "editjiraissue",
  "transitionjiraissue"
]);

function isAllowedAtlassianMcpToolName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (allowedMutatingAtlassianMcpTools.has(normalized)) {
    return true;
  }

  if (
    /(create|update|delete|remove|transition|assign|comment|attach|add|set|edit|move|link)/.test(
      normalized
    )
  ) {
    return false;
  }

  return /^(get|list|search|find|read|lookup|fetch|describe)/.test(normalized);
}

function sanitizeUpstreamMcpToolResult(
  result: UpstreamMcpToolResult
): UpstreamMcpToolResult {
  return {
    ...(Array.isArray(result.content)
      ? { content: result.content.slice(0, 20).map(sanitizeMcpContentItem) }
      : {}),
    ...(typeof result.isError === "boolean" ? { isError: result.isError } : {})
  };
}

function sanitizeMcpInputSchema(schema: unknown): unknown {
  if (schema === undefined) {
    return undefined;
  }

  try {
    const text = JSON.stringify(schema);
    return text.length <= 12_000 ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeMcpContentItem(item: unknown): unknown {
  if (!item || typeof item !== "object") {
    return item;
  }

  const record = item as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") {
    return {
      type: "text",
      text: record.text.slice(0, 12_000)
    };
  }

  return record;
}

function jsonResponse(result: ToolResult<unknown>, status = 200): Response {
  return Response.json(result, {
    status,
    headers: {
      "cache-control": "no-store"
    }
  });
}

function jsonResponseWithAudit(
  store: TokenStore,
  auth: ToolGatewayAuth,
  toolName: string,
  result: ToolResult<unknown>,
  observabilityContext?: ToolGatewayObservabilityContext
): Response {
  if (auth.kind === "runtime") {
    store.recordAgentRuntimeEvent({
      runtimeId: auth.runtime.id,
      eventType: "runtime_tool_called",
      summary: {
        toolName,
        classification: result.classification,
        itemCount: Array.isArray(result.content) ? result.content.length : null
      }
    });
  }
  emitToolGatewayCompleted(observabilityContext, auth, toolName, result);

  return jsonResponse(result);
}

function emitToolGatewayStarted(
  observability: ObservabilitySink | undefined,
  auth: ToolGatewayAuth,
  toolName: string,
  body: ToolGatewayBody | null
): void {
  observability?.emit({
    name: "tool.gateway.started",
    ...toolGatewayIdentityFields(auth),
    toolName,
    attributes: {
      authKind: auth.kind,
      provider: readToolProviderForTelemetry(toolName),
      hasUserEmail: typeof body?.user?.email === "string"
    }
  });
}

function emitToolGatewayCompleted(
  context: ToolGatewayObservabilityContext | undefined,
  auth: ToolGatewayAuth,
  toolName: string,
  result: ToolResult<unknown>
): void {
  context?.observability?.emit({
    name: "tool.gateway.completed",
    ...toolGatewayIdentityFields(auth),
    toolName,
    classification: result.classification,
    durationMs: Date.now() - context.startedAt,
    status: "ok",
    attributes: {
      authKind: auth.kind,
      provider: readToolProviderForTelemetry(toolName),
      itemCount: Array.isArray(result.content) ? result.content.length : null
    }
  });
}

function emitRuntimeHeartbeat(
  observability: ObservabilitySink | undefined,
  auth: Extract<ToolGatewayAuth, { kind: "runtime" }>,
  startedAt: number
): void {
  observability?.emit({
    name: "runtime.heartbeat",
    ...toolGatewayIdentityFields(auth),
    durationMs: Date.now() - startedAt,
    status: "ok",
    attributes: {
      authKind: auth.kind
    }
  });
}

function toolGatewayIdentityFields(auth: ToolGatewayAuth): {
  workspaceId?: string;
  principalId?: string;
  runtimeId?: string;
  runtimeType?: string;
} {
  if (auth.kind !== "runtime") {
    return {};
  }

  return {
    workspaceId: auth.runtime.workspaceId,
    principalId: `${auth.runtime.workspaceId}:${auth.runtime.slackUserId}`,
    runtimeId: auth.runtime.id,
    runtimeType: auth.runtime.engine
  };
}

function readToolProviderForTelemetry(toolName: string): string {
  if (toolName.startsWith("conversation.")) {
    return "conversation";
  }
  if (toolName.startsWith("runtime.")) {
    return "runtime";
  }
  if (toolName.startsWith("scheduledJob.")) {
    return "scheduled_job";
  }
  return readToolProvider(toolName);
}
