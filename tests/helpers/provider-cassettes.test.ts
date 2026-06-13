import { expect, test } from "bun:test";

import {
  installProviderCassette,
  withProviderCassette,
  type ProviderCassette
} from "./provider-cassettes";

const cassette: ProviderCassette = {
  name: "helper-test",
  interactions: [
    {
      request: { url: "https://example.test/ok" },
      response: { body: { ok: true } }
    }
  ]
};

test("withProviderCassette restores fetch after a successful callback", async () => {
  const originalFetch = globalThis.fetch;

  await withProviderCassette(cassette, async (installed) => {
    await fetch("https://example.test/ok");
    installed.assertComplete();
  });

  expect(globalThis.fetch).toBe(originalFetch);
});

test("withProviderCassette restores fetch after a throwing callback", async () => {
  const originalFetch = globalThis.fetch;

  await expect(
    withProviderCassette(cassette, async () => {
      throw new Error("boom");
    })
  ).rejects.toThrow("boom");

  expect(globalThis.fetch).toBe(originalFetch);
});

test("installProviderCassette still exposes explicit restore for manual scopes", () => {
  const originalFetch = globalThis.fetch;
  const installed = installProviderCassette(cassette);

  expect(globalThis.fetch).not.toBe(originalFetch);
  installed.restore();
  expect(globalThis.fetch).toBe(originalFetch);
});
