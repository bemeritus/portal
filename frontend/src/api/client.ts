/**
 * The one place that talks to the backend.
 *
 * Two things every caller depends on:
 *
 *  - `credentials: "include"` on every request. The session is a cookie, and
 *    `fetch` does not send cookies by default. Forgetting it on one call is a
 *    request that is mysteriously unauthenticated while every other one works.
 *  - Errors arrive as `ApiError` with the server's own sentence in `.message`.
 *    The backend answers `{"error": "..."}` for every failure, and that
 *    sentence was written to be shown to a person, so components render it
 *    directly instead of inventing their own wording.
 */

/** A failure the server described, or a transport failure described here. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }

  /** No session, or one that has ended. The app routes these to `/login`. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /** Signed in, but not allowed to do this. */
  get isForbidden(): boolean {
    return this.status === 403;
  }
}

/** What the browser reports when it could not reach the server at all. */
const NETWORK_MESSAGE = "Could not reach the server. Check your connection.";

async function toError(response: Response): Promise<ApiError> {
  // A failure that is not our JSON — a proxy's HTML error page, a 502 from
  // nginx — must not surface as "Unexpected token < in JSON".
  try {
    const body: unknown = await response.json();
    if (
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string"
    ) {
      return new ApiError(response.status, (body as { error: string }).error);
    }
  } catch {
    /* fall through to the status-based message */
  }
  return new ApiError(response.status, `Request failed (${response.status})`);
}

interface RequestOptions {
  method?: string;
  /** Serialized as JSON. Use `formData` for uploads instead. */
  body?: unknown;
  formData?: FormData;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, formData, signal } = options;

  const init: RequestInit = {
    method,
    // The session cookie rides on this. Every call, without exception.
    credentials: "include",
    signal,
  };

  if (formData) {
    // Deliberately no Content-Type: the browser has to set it, because only it
    // knows the multipart boundary it generated.
    init.body = formData;
  } else if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (e) {
    // An aborted request is the caller changing their mind (a filter typed
    // over, a page left), not a failure worth showing anyone.
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, NETWORK_MESSAGE);
  }

  if (!response.ok) throw await toError(response);

  // 204 has no body; `response.json()` on it throws.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  upload: <T>(path: string, formData: FormData) => request<T>(path, { method: "POST", formData }),
};

/** The sentence to show for any thrown value, API error or not. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}
