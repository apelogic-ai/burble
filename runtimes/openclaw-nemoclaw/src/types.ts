export type ToolClassification = "public" | "user_private" | "restricted";

export type ToolResult<TContent = unknown> = {
  classification: ToolClassification;
  content: TContent;
};

export type RunRequest = {
  runId?: string;
  runtime?: {
    id: string;
  };
  input: {
    text: string;
    conversation?: {
      source: "slack";
      workspaceId: string;
      channelId: string;
      rootId: string;
      isDirectMessage: boolean;
    };
    connections: {
      github: {
        connected: boolean;
        email?: string;
        providerLogin?: string;
      };
      jira?: {
        connected: boolean;
        email?: string;
        providerLogin?: string;
      };
    };
  };
};

export type RunResponse = {
  response: {
    classification: ToolClassification;
    text: string;
  };
};

export type RunEvent =
  | { type: "status"; text: string }
  | { type: "tool_call"; toolName: string; callId: string }
  | {
      type: "tool_result";
      toolName: string;
      callId: string;
      classification: ToolClassification;
    }
  | { type: "message_delta"; text: string }
  | { type: "final"; response: RunResponse["response"] }
  | { type: "error"; message: string };

export type ToolExecutor = (
  toolName: string,
  body: unknown
) => Promise<ToolResult>;
