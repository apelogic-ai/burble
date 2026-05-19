import type { ConversationResponse } from "./types";

export function enforceVisibility(
  response: ConversationResponse,
  context: { isDirectMessage: boolean }
): ConversationResponse {
  if (context.isDirectMessage) {
    return response;
  }

  if (
    response.visibility === "public" &&
    response.classification !== "public"
  ) {
    return {
      ...response,
      visibility: "ephemeral"
    };
  }

  return response;
}
