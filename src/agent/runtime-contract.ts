import { z } from "zod";

export const toolClassificationSchema = z.enum([
  "public",
  "user_private",
  "restricted"
]);

export const agentRuntimeEngineSchema = z.enum([
  "deterministic",
  "openclaw",
  "openclaw-gateway",
  "burble-direct",
  "hermes"
]);

export const runtimeToolGroupSchema = z.enum([
  "attachments",
  "conversation",
  "github",
  "google",
  "hubspot",
  "jira",
  "scheduler",
  "slack"
]);

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
    sizeBytes: z.number().int().nonnegative().optional(),
    externalId: z.string().optional()
  })
  .strict();

export const runtimeConnectionSummarySchema = z
  .object({
    connected: z.boolean(),
    email: z.string().optional(),
    providerLogin: z.string().optional()
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

export const runtimeRequestManifestSchema = z
  .object({
    version: z.string().min(1),
    policyHash: z.string().min(1),
    skills: z.array(runtimeManifestSkillSchema),
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

export const runtimeRunRequestSchema = z
  .object({
    runId: z.string().min(1).optional(),
    executionMode: z
      .enum(["default", "native-runtime", "openclaw-native"])
      .optional(),
    principal: runtimePrincipalSchema,
    runtime: z
      .object({
        id: z.string().min(1),
        engine: agentRuntimeEngineSchema,
        policyHash: z.string().optional(),
        manifest: runtimeRequestManifestSchema.optional()
      })
      .strict(),
    input: z
      .object({
        text: z.string().trim().min(1),
        toolGroups: z
          .object({
            groups: z.array(runtimeToolGroupSchema),
            reasons: z.array(z.string())
          })
          .strict()
          .optional(),
        scheduledJob: scheduledJobContextSchema.optional(),
        attachments: z.array(runtimeConversationAttachmentSchema).optional(),
        conversation: z
          .object({
            routeId: z.string().optional(),
            source: z.literal("slack"),
            workspaceId: z.string().min(1),
            channelId: z.string().min(1),
            rootId: z.string().min(1),
            isDirectMessage: z.boolean()
          })
          .strict()
          .optional(),
        context: z
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
          .strict()
          .optional(),
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

export type RuntimeRunRequest = z.infer<typeof runtimeRunRequestSchema>;
export type RuntimeRunEvent = z.infer<typeof runtimeRunEventSchema>;
export type RuntimeFinalResponse = z.infer<typeof runtimeFinalResponseSchema>;
export type RuntimeUsage = z.infer<typeof runtimeUsageSchema>;
export type RuntimeCapabilityManifest = z.infer<
  typeof runtimeCapabilityManifestSchema
>;

export function parseRuntimeRunRequest(input: unknown): RuntimeRunRequest {
  return parseContract(runtimeRunRequestSchema, input, "Invalid runtime run request");
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
