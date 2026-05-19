import type { ToolClassification } from "../conversation/types";

export type ToolResult<TContent> = {
  classification: ToolClassification;
  content: TContent;
};
