export type RuntimeToolGatewayFetch = (
  url: string,
  init?: RequestInit
) => Promise<Response>;

export type RuntimeToolGatewayClient = {
  execute(toolName: string, body: unknown): Promise<unknown>;
};

const defaultMaxToolGatewayAttempts = 3;
const defaultToolGatewayRetryBaseDelayMs = 250;

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
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  shouldRetryTool?: (toolName: string) => boolean;
  fetch?: RuntimeToolGatewayFetch;
}): RuntimeToolGatewayClient {
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  const requestFetch = input.fetch ?? fetch;
  const maxAttempts = normalizeAttemptCount(
    input.maxAttempts,
    defaultMaxToolGatewayAttempts
  );
  const retryBaseDelayMs = normalizeDelayMs(
    input.retryBaseDelayMs,
    defaultToolGatewayRetryBaseDelayMs
  );
  return {
    async execute(toolName, body) {
      const url = `${baseUrl}/${encodeURIComponent(toolName)}/execute`;
      const retryEnabled = input.shouldRetryTool?.(toolName) ?? true;
      let lastError: unknown;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          const response = await requestFetch(
            url,
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
          if (response.ok) {
            return response.json();
          }

          const error = new RuntimeToolGatewayError(
            response.status,
            await readErrorDetail(response)
          );
          if (
            !retryEnabled ||
            !shouldRetryToolGatewayError(error) ||
            attempt === maxAttempts - 1
          ) {
            throw error;
          }
          lastError = error;
        } catch (error) {
          if (
            !retryEnabled ||
            !shouldRetryToolGatewayError(error) ||
            attempt === maxAttempts - 1
          ) {
            throw error;
          }
          lastError = error;
        }
        await sleep(retryDelayMs(attempt, retryBaseDelayMs));
      }

      throw lastError instanceof Error
        ? lastError
        : new Error("Burble tool gateway request failed");
    }
  };
}

export class RuntimeToolGatewayError extends Error {
  constructor(
    readonly status: number,
    detail: string
  ) {
    super(`Burble tool gateway returned HTTP ${status}${detail}`);
  }
}

function shouldRetryToolGatewayError(error: unknown): boolean {
  if (error instanceof RuntimeToolGatewayError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError;
}

function normalizeAttemptCount(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeDelayMs(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function retryDelayMs(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * 2 ** attempt;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readErrorDetail(response: Response): Promise<string> {
  const text = await response.text();
  return text.trim() ? `: ${text.trim().slice(0, 500)}` : "";
}
