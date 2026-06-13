import { expect } from "bun:test";

export type ProviderCassette = {
  name: string;
  interactions: ProviderCassetteInteraction[];
};

export type ProviderCassetteInteraction = {
  request: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    bodyJson?: unknown;
  };
  response: {
    status?: number;
    headers?: Record<string, string>;
    body: unknown;
  };
};

export type ProviderCassetteRequest = {
  method: string;
  url: string;
  bodyJson?: unknown;
};

export function installProviderCassette(cassette: ProviderCassette): {
  requests: ProviderCassetteRequest[];
  assertComplete: () => void;
  restore: () => void;
} {
  const originalFetch = globalThis.fetch;
  const requests: ProviderCassetteRequest[] = [];
  let interactionIndex = 0;

  globalThis.fetch = (async (input, init) => {
    const interaction = cassette.interactions[interactionIndex];
    if (!interaction) {
      throw new Error(
        `Provider cassette ${cassette.name} received unexpected request ${String(
          input
        )}`
      );
    }
    interactionIndex += 1;

    const method = (init?.method ?? "GET").toUpperCase();
    const bodyJson =
      typeof init?.body === "string" && init.body.length > 0
        ? JSON.parse(init.body)
        : undefined;
    requests.push({
      method,
      url: String(input),
      ...(bodyJson !== undefined ? { bodyJson } : {})
    });

    expect(method).toBe((interaction.request.method ?? "GET").toUpperCase());
    expect(String(input)).toBe(interaction.request.url);

    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(interaction.request.headers ?? {})) {
      expect(headers.get(name)).toBe(value);
    }

    if ("bodyJson" in interaction.request) {
      expect(bodyJson).toEqual(interaction.request.bodyJson);
    }

    return Response.json(interaction.response.body, {
      status: interaction.response.status ?? 200,
      headers: interaction.response.headers
    });
  }) as typeof fetch;

  return {
    requests,
    assertComplete() {
      expect(interactionIndex).toBe(cassette.interactions.length);
    },
    restore() {
      globalThis.fetch = originalFetch;
    }
  };
}

export async function withProviderCassette<T>(
  cassette: ProviderCassette,
  fn: (installed: {
    requests: ProviderCassetteRequest[];
    assertComplete: () => void;
  }) => T | Promise<T>
): Promise<T> {
  const installed = installProviderCassette(cassette);
  try {
    return await fn({
      requests: installed.requests,
      assertComplete: installed.assertComplete
    });
  } finally {
    installed.restore();
  }
}
