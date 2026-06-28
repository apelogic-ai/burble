import { z } from "zod";
import { runtimeEngines } from "./runtime-engines";

export const toolClassificationSchema = z.enum([
  "public",
  "user_private",
  "restricted"
]);

export function normalizeAgentRuntimeEngineInput(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "burble-direct" || normalized === "direct-provider") {
    return "burble-native";
  }
  return normalized;
}

export const agentRuntimeEngineSchema = z.preprocess(
  normalizeAgentRuntimeEngineInput,
  z.enum(runtimeEngines)
);

export const runtimeToolGroups = [
  "attachments",
  "conversation",
  "github",
  "google",
  "hubspot",
  "jira",
  "scheduler",
  "slack",
  "web"
] as const;

export const runtimeToolGroupSchema = z.enum(runtimeToolGroups);

export const runtimeToolGroupSelectionSchema = z
  .object({
    groups: z.array(runtimeToolGroupSchema),
    reasons: z.array(z.string())
  })
  .strict();

export const runtimePrincipalSchema = z
  .object({
    workspaceId: z.string().min(1),
    slackUserId: z.string().min(1)
  })
  .strict();

export const runtimeConversationAttachmentSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["file", "image", "audio", "video"]),
    mimeType: z.string().min(1),
    source: z.enum(["slack", "burble", "agent"]),
    name: z.string().optional(),
    sizeBytes: z.number().finite().nonnegative().optional(),
    externalId: z.string().optional()
  })
  .passthrough();

export const runtimeConnectionSummarySchema = z
  .object({
    connected: z.boolean(),
    email: z.preprocess(
      (value) => (typeof value === "string" ? value : undefined),
      z.string().optional()
    ),
    providerLogin: z.preprocess(
      (value) => (typeof value === "string" ? value : undefined),
      z.string().optional()
    )
  })
  .passthrough();

export const runtimeConversationSummarySchema = z
  .object({
    routeId: z.string().min(1).optional(),
    source: z.literal("slack"),
    workspaceId: z.string().min(1),
    channelId: z.string().min(1),
    rootId: z.string().min(1),
    isDirectMessage: z.boolean()
  })
  .strict();

export const runtimeRequestContextSchema = z
  .object({
    currentChannel: z
      .object({
        id: z.string().min(1),
        isDirectMessage: z.boolean(),
        historyAvailable: z.boolean(),
        historyError: z.string().optional()
      })
      .strict()
      .optional(),
    recentMessages: z.array(
      z
        .object({
          author: z.enum(["user", "assistant"]),
          speaker: z.string().optional(),
          text: z.string()
        })
        .strict()
    )
  })
  .strict();

export const runtimeMemoryContextEntrySchema = z
  .object({
    scope: z.enum(["user", "workspace", "job"]),
    ownerId: z.string().min(1),
    key: z.string().min(1),
    valuePreview: z.string(),
    updatedAt: z.string().min(1)
  })
  .strict();

export const runtimeManifestSkillSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    enabled: z.boolean()
  })
  .strict();

export const runtimeManifestToolInputSchema = z
  .object({
    name: z.string().min(1),
    type: z.string().min(1),
    required: z.boolean(),
    nullable: z.boolean().optional(),
    description: z.string().optional(),
    values: z.array(z.string()).optional(),
    aliases: z.array(z.string().min(1)).optional()
  })
  .strict();

export const runtimeManifestToolSchema = z
  .object({
    name: z.string().min(1),
    alias: z.string().min(1),
    provider: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    enabled: z.boolean(),
    risk: z.enum(["read", "low_write", "moderate_write", "high_write"]),
    routeRequired: z.boolean(),
    confirmation: z.enum(["none", "explicit", "strong"]),
    retrySafe: z.boolean().optional(),
    input: z.array(runtimeManifestToolInputSchema)
  })
  .strict();

export const runtimeManifestMemorySchema = z
  .object({
    userMemoryEnabled: z.boolean(),
    workspaceMemoryEnabled: z.boolean(),
    jobMemoryEnabled: z.boolean()
  })
  .strict();

export const runtimeManifestStreamingSchema = z
  .object({
    messageDeltasEnabled: z.boolean()
  })
  .strict();

export const runtimeHandleStatusSchema = z.enum(["ready", "busy", "idle"]);

export const runtimeRequestManifestSchema = z
  .object({
    version: z.string().min(1),
    policyHash: z.string().min(1),
    skills: z.array(runtimeManifestSkillSchema),
    tools: z.array(runtimeManifestToolSchema).optional(),
    memory: runtimeManifestMemorySchema,
    streaming: runtimeManifestStreamingSchema.default({
      messageDeltasEnabled: true
    }),
    memoryContext: z.array(runtimeMemoryContextEntrySchema).optional()
  })
  .strict();

export const scheduledJobStateRefSchema = z
  .object({
    provider: z.string().min(1),
    kind: z.string().min(1),
    id: z.string().optional(),
    name: z.string().optional(),
    purpose: z.string().optional()
  })
  .strict();

export const scheduledJobVisibilityPolicySchema = z
  .object({
    maxOutputVisibility: toolClassificationSchema.optional(),
    allowPrivateToolDeclassification: z.boolean().optional()
  })
  .strict();

export const scheduledJobContextSchema = z
  .object({
    jobId: z.string().min(1),
    capabilityProfile: z.string().min(1),
    allowedTools: z.array(z.string().min(1)).min(1),
    routeId: z.string().min(1).optional(),
    runtimeType: agentRuntimeEngineSchema.optional(),
    stateRefs: z.array(scheduledJobStateRefSchema),
    visibilityPolicy: scheduledJobVisibilityPolicySchema
  })
  .strict();

const runtimeExecutionModeSchema = z.enum([
  "default",
  "native-runtime",
  "openclaw-native"
]);

export const runtimeRunRequestSchema = z
  .object({
    runId: z.string().min(1).optional(),
    executionMode: runtimeExecutionModeSchema.optional(),
    principal: runtimePrincipalSchema,
    runtime: z
      .object({
        id: z.string().min(1),
        engine: agentRuntimeEngineSchema,
        status: runtimeHandleStatusSchema.optional(),
        policyHash: z.string().optional(),
        manifest: runtimeRequestManifestSchema.optional()
      })
      .strict(),
    input: z
      .object({
        text: z.string().trim().min(1),
        toolGroups: runtimeToolGroupSelectionSchema.optional(),
        scheduledJob: scheduledJobContextSchema.optional(),
        attachments: z.array(runtimeConversationAttachmentSchema).optional(),
        conversation: runtimeConversationSummarySchema.optional(),
        context: runtimeRequestContextSchema.optional(),
        connections: z
          .object({
            github: runtimeConnectionSummarySchema.optional(),
            google: runtimeConnectionSummarySchema.optional(),
            hubspot: runtimeConnectionSummarySchema.optional(),
            jira: runtimeConnectionSummarySchema.optional(),
            slack: runtimeConnectionSummarySchema.optional()
          })
          .strict()
      })
      .strict()
  })
  .strict();

export const runtimeUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    usageSource: z.string().optional()
  })
  .strict();

export const runtimeFinalResponseSchema = z
  .object({
    classification: toolClassificationSchema,
    text: z.string(),
    blocks: z.array(z.unknown()).optional(),
    attachments: z.array(runtimeConversationAttachmentSchema).optional(),
    usage: runtimeUsageSchema.optional(),
    telemetry: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export const runtimeRunEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("status"),
      text: z.string()
    })
    .strict(),
  z
    .object({
      type: z.literal("message_delta"),
      text: z.string()
    })
    .strict(),
  z
    .object({
      type: z.literal("message_replace"),
      text: z.string()
    })
    .strict(),
  z
    .object({
      type: z.literal("tool_call"),
      toolName: z.string().min(1),
      callId: z.string().min(1),
      input: z.unknown().optional()
    })
    .strict(),
  z
    .object({
      type: z.literal("tool_result"),
      toolName: z.string().min(1),
      callId: z.string().min(1),
      classification: toolClassificationSchema,
      content: z.unknown().optional()
    })
    .strict(),
  z
    .object({
      type: z.literal("usage"),
      usage: runtimeUsageSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("heartbeat"),
      status: z.string().optional()
    })
    .strict(),
  z
    .object({
      type: z.literal("final"),
      response: runtimeFinalResponseSchema
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      message: z.string().min(1),
      code: z.string().optional()
    })
    .strict()
]);

export const runtimeTransportSchema = z.enum([
  "http",
  "sse",
  "ndjson",
  "websocket"
]);

export const runtimeToolBridgeModeSchema = z.enum(["tool_gateway", "mcp"]);

export const runtimeUsageReportingSchema = z.enum([
  "exact",
  "estimated",
  "none"
]);

export const runtimeCapabilityManifestSchema = z
  .object({
    runtimeType: agentRuntimeEngineSchema,
    version: z.string().min(1),
    transports: z.array(runtimeTransportSchema).min(1),
    streaming: z.boolean(),
    cancellation: z.boolean(),
    nativeScheduler: z.boolean(),
    scheduledProviderCalls: z.boolean(),
    toolCalls: z.boolean(),
    toolBridgeModes: z.array(runtimeToolBridgeModeSchema),
    usageReporting: runtimeUsageReportingSchema,
    multimodalInput: z.boolean(),
    multimodalOutput: z.boolean(),
    memory: z.boolean(),
    durableWorkflowState: z.boolean(),
    attachments: z.boolean(),
    conversationSend: z.boolean(),
    jobScopedAuth: z.boolean()
  })
  .passthrough();

type ParsedRuntimeRunRequest = z.infer<typeof runtimeRunRequestSchema>;

export type RuntimeToolGroup = z.infer<typeof runtimeToolGroupSchema>;
export type RuntimeToolGroupSelection = z.infer<
  typeof runtimeToolGroupSelectionSchema
>;
export type ToolClassification = z.infer<typeof toolClassificationSchema>;
export type RuntimeConversationAttachment = z.infer<
  typeof runtimeConversationAttachmentSchema
>;
export type RuntimeConnectionSummary = z.infer<
  typeof runtimeConnectionSummarySchema
>;
export type RuntimeConversationSummary = z.infer<
  typeof runtimeConversationSummarySchema
>;
export type RuntimeRequestContext = z.infer<
  typeof runtimeRequestContextSchema
>;
export type RuntimeRunRequest = Omit<
  ParsedRuntimeRunRequest,
  "executionMode"
> & {
  executionMode?: "default" | "native-runtime";
};
export type RuntimeRunEvent = z.infer<typeof runtimeRunEventSchema>;
export type RuntimeFinalResponse = z.infer<typeof runtimeFinalResponseSchema>;
export type RuntimeUsage = z.infer<typeof runtimeUsageSchema>;
export type RuntimeCapabilityManifest = z.infer<
  typeof runtimeCapabilityManifestSchema
>;

export function parseRuntimeRunRequest(input: unknown): RuntimeRunRequest {
  const request = parseContract(
    runtimeRunRequestSchema,
    input,
    "Invalid runtime run request"
  );
  const executionMode =
    request.executionMode === "openclaw-native"
      ? "native-runtime"
      : request.executionMode;
  return { ...request, executionMode };
}

export function parseRuntimeRunEvent(input: unknown): RuntimeRunEvent {
  return parseContract(runtimeRunEventSchema, input, "Invalid runtime run event");
}

export function parseRuntimeCapabilityManifest(
  input: unknown
): RuntimeCapabilityManifest {
  return parseContract(
    runtimeCapabilityManifestSchema,
    input,
    "Invalid runtime capability manifest"
  );
}

function parseContract<T>(
  schema: z.ZodType<T>,
  input: unknown,
  message: string
): T {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  throw new Error(`${message}: ${z.prettifyError(result.error)}`);
}
