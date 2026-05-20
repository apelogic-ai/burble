export type ToolClassification = "public" | "user_private" | "restricted";

export type ToolResult<TContent = unknown> = {
  classification: ToolClassification;
  content: TContent;
};

export type RunRequest = {
  input: {
    text: string;
    connections: {
      github: {
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

export type ToolExecutor = (
  toolName: string,
  body: unknown
) => Promise<ToolResult>;
