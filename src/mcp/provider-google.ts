import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config";
import type { AgentRuntimeRecord, ProviderConnection, TokenStore } from "../db";
import { googleProviderToolSpecs } from "../providers/google/tool-specs";
import { providerToolInputSchema } from "../providers/tool-specs";
import { createGoogleTools } from "../tools/google";
import type { ToolResult } from "../tools/types";
import { callMcpGwTool, McpGwUnauthorizedError } from "./mcp-gw-client";
import {
  adaptMcpGwGoogleToolCall,
  mcpGwGoogleToolResult
} from "./mcp-gw-google-adapter";
import {
  mcpToolResult,
  type ProviderMcpDeps,
  withConnection
} from "./provider-context";
import {
  isProviderMcpToolEnabled,
  type ProviderMcpToolPolicy
} from "./provider-policy";
import { resolveMcpUserAssertion } from "./user-assertion";

type GoogleTools = ReturnType<typeof createGoogleTools>;
type GoogleToolArgs = Record<string, unknown>;
type GoogleMcpHandler = (
  connection: ProviderConnection,
  args: GoogleToolArgs
) => Promise<ToolResult<unknown>>;

export function registerGoogleMcpTools(input: {
  server: McpServer;
  config: Config;
  store: TokenStore;
  runtime: AgentRuntimeRecord;
  deps: Parameters<typeof createGoogleTools>[0] & ProviderMcpDeps;
  policy?: ProviderMcpToolPolicy;
}): void {
  const googleTools = createGoogleTools(input.deps);
  const handlers = createGoogleMcpHandlers(googleTools);

  for (const spec of googleProviderToolSpecs) {
    if (!isProviderMcpToolEnabled(input.policy, spec.name)) {
      continue;
    }
    const handler = handlers[spec.implementation];
    if (!handler) {
      throw new Error(`Missing Google MCP handler for ${spec.implementation}`);
    }

    input.server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: providerToolInputSchema(spec)
      },
      async (args) => {
        if (input.config.googleViaMcpGw) {
          return mcpToolResult(
            await handleMcpGwGoogleToolRequest({
              config: input.config,
              runtime: input.runtime,
              deps: input.deps,
              toolName: spec.name,
              args: args as GoogleToolArgs
            })
          );
        }

        return mcpToolResult(
          await withConnection(
            input.store,
            input.runtime,
            "google",
            (connection) => handler(connection, args as GoogleToolArgs)
          )
        );
      }
    );
  }
}

async function handleMcpGwGoogleToolRequest(input: {
  config: Config;
  runtime: AgentRuntimeRecord;
  deps: ProviderMcpDeps;
  toolName: string;
  args: GoogleToolArgs;
}): Promise<ToolResult<unknown>> {
  const adaptedTool = adaptMcpGwGoogleToolCall(input.toolName, input.args);
  if (!adaptedTool.ok) {
    return {
      classification: "user_private",
      content: {
        error: "mcp_gw_tool_not_adapted",
        message: adaptedTool.message
      }
    };
  }

  if (
    !input.config.mcpGwMcpUrl ||
    !input.config.mcpGwAudience ||
    !input.deps.mcpIdentityIssuer
  ) {
    return {
      classification: "user_private",
      content: {
        error: "mcp_gw_not_configured",
        message:
          "Google via MCP-GW is enabled but MCP-GW URL, audience, or identity issuer is not configured."
      }
    };
  }

  if (!input.deps.getSlackEmail) {
    return {
      classification: "user_private",
      content: {
        error: "mcp_gw_identity_unavailable",
        message:
          "Google via MCP-GW requires a Slack email resolver or a runtime user email."
      }
    };
  }

  try {
    const assertion = await resolveMcpUserAssertion({
      workspaceId: input.runtime.workspaceId,
      slackUserId: input.runtime.slackUserId,
      audience: input.config.mcpGwAudience,
      issuer: input.deps.mcpIdentityIssuer,
      getSlackEmail: input.deps.getSlackEmail
    });
    const result = await (input.deps.callMcpGwTool ?? callMcpGwTool)(
      {
        url: input.config.mcpGwMcpUrl,
        bearerToken: assertion.token
      },
      {
        name: adaptedTool.name,
        arguments: adaptedTool.arguments
      }
    );

    return mcpGwGoogleToolResult(adaptedTool, result);
  } catch (error) {
    if (error instanceof McpGwUnauthorizedError) {
      return {
        classification: "user_private",
        content: {
          error: "mcp_gw_unauthorized",
          message: error.message,
          ...(error.protectedResourceMetadataUrl
            ? { protectedResourceMetadataUrl: error.protectedResourceMetadataUrl }
            : {})
        }
      };
    }

    return {
      classification: "user_private",
      content: {
        error: "mcp_gw_call_failed",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function createGoogleMcpHandlers(
  googleTools: GoogleTools
): Record<string, GoogleMcpHandler> {
  return {
    getAuthenticatedUser: (connection) =>
      googleTools.getAuthenticatedUser.execute({ connection }),

    searchDriveFiles: (connection, args) =>
      googleTools.searchDriveFiles.execute({
        connection,
        input: {
          ...optionalTruthyStringField(args, "query"),
          ...optionalTruthyStringField(args, "scope"),
          ...optionalTruthyStringField(args, "sharedDriveId"),
          ...optionalTruthyStringField(args, "sharedDriveName"),
          ...optionalTruthyStringField(args, "parentId"),
          ...optionalTruthyStringField(args, "mimeType"),
          ...optionalBooleanField(args, "sharedWithMe"),
          ...optionalTruthyNumberField(args, "limit")
        }
      }),

    listSharedDrives: (connection, args) =>
      googleTools.listSharedDrives.execute({
        connection,
        input: {
          ...optionalTruthyStringField(args, "query"),
          ...optionalTruthyNumberField(args, "limit")
        }
      }),

    createDriveTextFile: (connection, args) =>
      googleTools.createDriveTextFile.execute({
        connection,
        input: {
          name: stringArg(args, "name"),
          text: optionalStringArg(args, "text") ?? "",
          ...optionalTruthyStringField(args, "mimeType")
        }
      }),

    createDocsDocument: (connection, args) =>
      googleTools.createDocsDocument.execute({
        connection,
        input: {
          name: stringArg(args, "name"),
          text: optionalStringArg(args, "text") ?? "",
          ...optionalTruthyStringValueField(
            "sourceMimeType",
            optionalStringArg(args, "sourceMimeType") ??
              optionalStringArg(args, "mimeType") ??
              optionalStringArg(args, "source_mime_type")
          ),
          ...optionalTruthyStringField(args, "parentId")
        }
      }),

    getDriveFile: (connection, args) =>
      googleTools.getDriveFile.execute({
        connection,
        input: {
          fileId: stringArg(args, "fileId"),
          ...optionalBooleanField(args, "includeContent")
        }
      }),

    updateDriveTextFile: (connection, args) =>
      googleTools.updateDriveTextFile.execute({
        connection,
        input: {
          fileId: stringArg(args, "fileId"),
          text: stringArg(args, "text"),
          ...optionalTruthyStringField(args, "mimeType")
        }
      }),

    appendDriveTextFile: (connection, args) =>
      googleTools.appendDriveTextFile.execute({
        connection,
        input: {
          fileId: stringArg(args, "fileId"),
          text: stringArg(args, "text"),
          ...optionalStringField(args, "separator"),
          ...optionalTruthyStringField(args, "mimeType")
        }
      }),

    createDriveFolder: (connection, args) =>
      googleTools.createDriveFolder.execute({
        connection,
        input: {
          name: stringArg(args, "name"),
          ...optionalTruthyStringField(args, "parentId")
        }
      }),

    moveDriveFile: (connection, args) =>
      googleTools.moveDriveFile.execute({
        connection,
        input: {
          fileId: stringArg(args, "fileId"),
          parentId: stringArg(args, "parentId"),
          ...optionalStringArrayField(args, "removeParentIds")
        }
      }),

    searchCalendarEvents: (connection, args) =>
      googleTools.searchCalendarEvents.execute({
        connection,
        input: {
          ...optionalTruthyStringField(args, "query"),
          ...optionalTruthyStringField(args, "timeMin"),
          ...optionalTruthyStringField(args, "timeMax"),
          ...optionalTruthyNumberField(args, "limit")
        }
      }),

    createCalendarEvent: (connection, args) =>
      googleTools.createCalendarEvent.execute({
        connection,
        input: {
          ...optionalTruthyStringField(args, "calendarId"),
          summary: stringArg(args, "summary"),
          start: stringArg(args, "start"),
          end: stringArg(args, "end"),
          ...optionalStringField(args, "description"),
          ...optionalStringField(args, "location"),
          ...optionalTruthyStringField(args, "timeZone")
        }
      }),

    updateCalendarEvent: (connection, args) =>
      googleTools.updateCalendarEvent.execute({
        connection,
        input: {
          ...optionalTruthyStringField(args, "calendarId"),
          eventId: stringArg(args, "eventId"),
          ...optionalStringField(args, "summary"),
          ...optionalStringField(args, "start"),
          ...optionalStringField(args, "end"),
          ...optionalStringField(args, "description"),
          ...optionalStringField(args, "location"),
          ...optionalTruthyStringField(args, "timeZone")
        }
      }),

    searchMailMessages: (connection, args) =>
      googleTools.searchMailMessages.execute({
        connection,
        input: {
          query: stringArg(args, "query"),
          ...optionalTruthyNumberField(args, "limit")
        }
      }),

    searchSlidesPresentations: (connection, args) =>
      googleTools.searchSlidesPresentations.execute({
        connection,
        input: {
          ...optionalStringField(args, "query"),
          ...optionalTruthyNumberField(args, "limit")
        }
      }),

    getSlidesPresentation: (connection, args) =>
      googleTools.getSlidesPresentation.execute({
        connection,
        input: {
          presentationId: stringArg(args, "presentationId"),
          ...optionalBooleanField(args, "includeSlides")
        }
      }),

    probeSlidesTemplate: (connection, args) =>
      googleTools.probeSlidesTemplate.execute({
        connection,
        input: {
          presentationId: stringArg(args, "presentationId")
        }
      }),

    copySlidesPresentation: (connection, args) =>
      googleTools.copySlidesPresentation.execute({
        connection,
        input: {
          presentationId: stringArg(args, "presentationId"),
          name: stringArg(args, "name")
        }
      }),

    createSlidesSlide: (connection, args) =>
      googleTools.createSlidesSlide.execute({
        connection,
        input: {
          presentationId: stringArg(args, "presentationId"),
          ...(optionalStringArg(args, "objectId")
            ? { objectId: optionalStringArg(args, "objectId") }
            : {}),
          ...(optionalNumberArg(args, "insertionIndex") !== undefined
            ? { insertionIndex: optionalNumberArg(args, "insertionIndex") }
            : {}),
          ...(optionalStringArg(args, "layoutObjectId")
            ? { layoutObjectId: optionalStringArg(args, "layoutObjectId") }
            : {}),
          ...(optionalStringArg(args, "predefinedLayout")
            ? { predefinedLayout: optionalStringArg(args, "predefinedLayout") }
            : {}),
          ...(Array.isArray(args.replacements)
            ? {
                replacements: arrayArg(args, "replacements").map((replacement) => ({
                  placeholderType: stringArg(replacement, "placeholderType"),
                  text: stringArg(replacement, "text"),
                  ...(optionalNumberArg(replacement, "index") !== undefined
                    ? { index: optionalNumberArg(replacement, "index") }
                    : {})
                }))
              }
            : {})
        }
      }),

    fillSlidesPlaceholders: (connection, args) =>
      googleTools.fillSlidesPlaceholders.execute({
        connection,
        input: {
          presentationId: stringArg(args, "presentationId"),
          ...(optionalStringArg(args, "slideObjectId")
            ? { slideObjectId: optionalStringArg(args, "slideObjectId") }
            : {}),
          replacements: arrayArg(args, "replacements").map((replacement) => ({
            placeholderType: stringArg(replacement, "placeholderType"),
            text: stringArg(replacement, "text"),
            ...(optionalNumberArg(replacement, "index") !== undefined
              ? { index: optionalNumberArg(replacement, "index") }
              : {})
          }))
        }
      }),

    listAnalyticsProperties: (connection, args) =>
      googleTools.listAnalyticsProperties.execute({
        connection,
        input: {
          ...optionalTruthyNumberField(args, "limit")
        }
      }),

    getAnalyticsMetadata: (connection, args) =>
      googleTools.getAnalyticsMetadata.execute({
        connection,
        input: {
          propertyId: stringArg(args, "propertyId"),
          ...optionalTruthyStringField(args, "dimensionQuery"),
          ...optionalTruthyStringField(args, "metricQuery"),
          ...optionalTruthyNumberField(args, "limit")
        }
      }),

    runAnalyticsReport: (connection, args) =>
      googleTools.runAnalyticsReport.execute({
        connection,
        input: {
          propertyId: stringArg(args, "propertyId"),
          startDate: stringArg(args, "startDate"),
          endDate: stringArg(args, "endDate"),
          metrics: stringArrayArg(args, "metrics"),
          ...optionalStringArrayField(args, "dimensions"),
          ...optionalTruthyNumberField(args, "limit")
        }
      }),

    createMailDraft: (connection, args) =>
      googleTools.createMailDraft.execute({
        connection,
        input: {
          to: stringArrayArg(args, "to"),
          subject: stringArg(args, "subject"),
          body: stringArg(args, "body"),
          ...optionalStringArrayField(args, "cc"),
          ...optionalStringArrayField(args, "bcc")
        }
      })
  };
}

function stringArg(args: GoogleToolArgs, key: string): string {
  return args[key] as string;
}

function optionalStringArg(args: GoogleToolArgs, key: string): string | undefined {
  return typeof args[key] === "string" ? (args[key] as string) : undefined;
}

function optionalNumberArg(args: GoogleToolArgs, key: string): number | undefined {
  return typeof args[key] === "number" ? (args[key] as number) : undefined;
}

function stringArrayArg(args: GoogleToolArgs, key: string): string[] {
  return args[key] as string[];
}

function arrayArg(args: GoogleToolArgs, key: string): GoogleToolArgs[] {
  return args[key] as GoogleToolArgs[];
}

function optionalStringField(
  args: GoogleToolArgs,
  key: string
): Partial<Record<string, string>> {
  return args[key] !== undefined ? { [key]: args[key] as string } : {};
}

function optionalTruthyStringField(
  args: GoogleToolArgs,
  key: string
): Partial<Record<string, string>> {
  return args[key] ? { [key]: args[key] as string } : {};
}

function optionalTruthyStringValueField(
  key: string,
  value: string | undefined
): Partial<Record<string, string>> {
  return value ? { [key]: value } : {};
}

function optionalTruthyNumberField(
  args: GoogleToolArgs,
  key: string
): Partial<Record<string, number>> {
  return args[key] ? { [key]: args[key] as number } : {};
}

function optionalBooleanField(
  args: GoogleToolArgs,
  key: string
): Partial<Record<string, boolean>> {
  return args[key] !== undefined ? { [key]: args[key] as boolean } : {};
}

function optionalStringArrayField(
  args: GoogleToolArgs,
  key: string
): Partial<Record<string, string[]>> {
  return args[key] ? { [key]: args[key] as string[] } : {};
}
