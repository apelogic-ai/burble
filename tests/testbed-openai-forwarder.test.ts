import { describe, expect, test } from "bun:test";
import { forwardOpenAiRequest } from "../src/testbed/openai-forwarder";

describe("testbed OpenAI forwarder", () => {
  test("replaces the runtime placeholder without changing the request body", async () => {
    let forwarded: Request | null = null;
    const response = await forwardOpenAiRequest(
      new Request("http://openai-direct:4100/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer sk-BURBLE-INFERENCE-PROXY",
          "content-type": "application/json",
          "x-test": "preserved"
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          input: "hello",
          metadata: { burble_correlation_id: "0123456789abcdef" }
        })
      }),
      {
        apiKey: "sk-test-real-key",
        fetch: async (request) => {
          forwarded = request;
          return new Response("data: [DONE]\n\n", {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "x-request-id": "req_test"
            }
          });
        },
        log: () => undefined
      }
    );

    expect(forwarded).not.toBeNull();
    expect(forwarded!.url).toBe("https://api.openai.com/v1/responses");
    expect(forwarded!.headers.get("authorization")).toBe(
      "Bearer sk-test-real-key"
    );
    expect(forwarded!.headers.get("x-test")).toBe("preserved");
    expect(await forwarded!.json()).toEqual({
      model: "gpt-5.4",
      input: "hello",
      metadata: { burble_correlation_id: "0123456789abcdef" }
    });
    expect(response.headers.get("x-request-id")).toBe("req_test");
    expect(await response.text()).toBe("data: [DONE]\n\n");
  });
});
