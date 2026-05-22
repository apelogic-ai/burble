import { describe, expect, test } from "bun:test";
import { extractMcpTextContent } from "../../src/tools/mcp";

describe("extractMcpTextContent", () => {
  test("returns text and resource text content from MCP tool results", () => {
    expect(
      extractMcpTextContent({
        content: [
          { type: "text", text: "first" },
          {
            type: "resource",
            resource: {
              uri: "jira://issue/ENG-1",
              text: "second"
            }
          },
          { type: "image", data: "base64", mimeType: "image/png" }
        ]
      })
    ).toEqual(["first", "second"]);
  });

  test("returns an empty list for malformed or non-text results", () => {
    expect(extractMcpTextContent(null)).toEqual([]);
    expect(extractMcpTextContent({ content: [{ type: "audio" }] })).toEqual([]);
  });
});
