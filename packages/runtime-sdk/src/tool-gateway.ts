export type RuntimeToolGatewayFetch = (
  url: string,
  init?: RequestInit
) => Promise<Response>;

export type RuntimeToolGatewayClient = {
  execute(toolName: string, body: unknown): Promise<unknown>;
};

export function buildRuntimeBearerHeaders(
  runtimeToken: string,
  headers?: HeadersInit,
  runtimeId?: string
): Headers {
  const result = new Headers(headers);
  result.set("authorization", `Bearer ${runtimeToken}`);
  if (runtimeId) {
    result.set("x-burble-runtime-id", runtimeId);
  }
  return result;
}

export function createRuntimeToolGatewayClient(input: {
  baseUrl: string;
  runtimeToken: string;
  runtimeId?: string;
  fetch?: RuntimeToolGatewayFetch;
}): RuntimeToolGatewayClient {
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  const requestFetch = input.fetch ?? fetch;
  return {
    async execute(toolName, body) {
      const response = await requestFetch(
        `${baseUrl}/${encodeURIComponent(toolName)}/execute`,
        {
          method: "POST",
          headers: Object.fromEntries(
            buildRuntimeBearerHeaders(
              input.runtimeToken,
              {
                accept: "application/json",
                "content-type": "application/json"
              },
              input.runtimeId
            ).entries()
          ),
          body: JSON.stringify(body)
        }
      );
      if (!response.ok) {
        throw new Error(
          `Burble tool gateway returned HTTP ${response.status}${await readErrorDetail(response)}`
        );
      }
      return response.json();
    }
  };
}

async function readErrorDetail(response: Response): Promise<string> {
  const text = await response.text();
  return text.trim() ? `: ${text.trim().slice(0, 500)}` : "";
}
