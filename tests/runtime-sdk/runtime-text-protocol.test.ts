import { describe, expect, test } from "bun:test";
import {
  containsRuntimeToolCallProtocolFragments,
  stripRuntimeToolCallProtocolFragments
} from "@burble/runtime-sdk/runtime-text-protocol";

describe("stripRuntimeToolCallProtocolFragments", () => {
  test("leaves ordinary prose unchanged", () => {
    expect(stripRuntimeToolCallProtocolFragments("Done — I created the deck.")).toBe(
      "Done — I created the deck."
    );
  });

  test("strips pure tool-call protocol text", () => {
    expect(
      stripRuntimeToolCallProtocolFragments(
        JSON.stringify({
          tool_call: {
            name: "google.slidesCreateSlide",
            arguments: { presentationId: "deck-1" }
          }
        })
      )
    ).toBe("");
  });

  test("strips mixed prose and nested tool-call protocol text", () => {
    const protocol = JSON.stringify({
      tool_call: {
        name: "google.slidesCreateSlide",
        arguments: {
          presentationId: "deck-1",
          replacements: [
            {
              placeholderType: "BODY",
              text: "Nested {braces} inside a string are content."
            }
          ]
        }
      }
    });

    expect(
      stripRuntimeToolCallProtocolFragments(`Done — I created the deck.\n\n${protocol}`)
    ).toBe("Done — I created the deck.");
  });

  test("keeps ordinary JSON that is not the runtime tool protocol", () => {
    const json = JSON.stringify({
      status: "ok",
      tool: "google.slidesCreateSlide"
    });

    expect(stripRuntimeToolCallProtocolFragments(`Debug payload:\n${json}`)).toBe(
      `Debug payload:\n${json}`
    );
  });

  test("detects JSON runtime tool-call protocol", () => {
    expect(
      containsRuntimeToolCallProtocolFragments(
        JSON.stringify({
          tool_call: {
            name: "google.slidesCreateSlide",
            arguments: { presentationId: "deck-1" }
          }
        })
      )
    ).toBe(true);
  });

  test("detects Hermes-style leaked tool transcript lines", () => {
    expect(
      containsRuntimeToolCallProtocolFragments(`Checking the window.
to=terminal_exec code
{"command":"date -u","timeout_ms":120000}
recipient=shell
New PRs found.`)
    ).toBe(true);
  });

  test("does not flag ordinary prose or non-protocol JSON", () => {
    expect(
      containsRuntimeToolCallProtocolFragments(
        `Send this to=example note in prose.\n${JSON.stringify({ ok: true })}`
      )
    ).toBe(false);
  });
});
