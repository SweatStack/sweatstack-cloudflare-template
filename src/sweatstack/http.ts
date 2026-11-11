// Low-level HTTP for everything that talks to SweatStack: base URL, timeouts, retries, errors.
// Route handlers never use this directly; they use the client in ./client.ts.

export const SWEATSTACK_URL = "https://app.sweatstack.no";

/** A function with the shape of the global `fetch`. Injected so tests never hit the network. */
export type Fetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

/** SweatStack answered with an error, or could not be reached (`status` 0). */
export class SweatStackError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /**
     * Machine-readable reason: the OAuth error (RFC 6749, e.g. "invalid_grant") or the `code` of an
     * RFC 7807 problem+json response (e.g. "missing_resting_hr"). Check it to handle expected states.
     */
    readonly code?: string,
  ) {
    super(message);
    this.name = "SweatStackError";
  }

  get isNotFound() {
    return this.status === 404;
  }
}

/** The user's SweatStack connection is gone (revoked, expired, or never existed): they must sign in again. */
export class NotAuthenticatedError extends Error {
  constructor(message = "Not signed in to SweatStack") {
    super(message);
    this.name = "NotAuthenticatedError";
  }
}

const TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 300;

/**
 * fetch() with a timeout, and one retry for transient failures (network error, 5xx, 429)
 * when `retry` is true. Only retry requests that are safe to repeat.
 */
export async function fetchWithRetry(
  fetchFn: Fetch,
  url: string,
  init: RequestInit,
  { retry }: { retry: boolean },
): Promise<Response> {
  const attempt = async () => {
    try {
      return await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "could not be reached";
      throw new SweatStackError(`SweatStack ${reason}`, 0);
    }
  };

  try {
    const response = await attempt();
    if (!retry || !isTransient(response.status)) return response;
  } catch (error) {
    if (!retry) throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  return attempt();
}

function isTransient(status: number) {
  return status === 429 || status >= 500;
}

/** Turns an error response into a SweatStackError with the most useful message SweatStack gave us. */
export async function errorFrom(response: Response, what: string): Promise<SweatStackError> {
  let detail = "";
  let code: string | undefined;
  try {
    const body = (await response.json()) as { error?: string; error_description?: string; code?: string; title?: string; detail?: unknown };
    code = body.error ?? body.code;
    detail = body.error_description ?? (typeof body.detail === "string" ? body.detail : body.title) ?? "";
  } catch {
    // not JSON
  }
  const message = `${what} failed: ${response.status}${code ? ` ${code}` : ""}${detail ? ` (${detail})` : ""}`;
  return new SweatStackError(message, response.status, code);
}
