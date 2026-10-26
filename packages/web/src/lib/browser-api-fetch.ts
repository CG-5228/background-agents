import { getPageLoadId } from "./page-load-telemetry";
import { TRACE_ID_HEADER } from "./request-correlation";

/**
 * App-owned browser-to-BFF request boundary.
 *
 * The path type keeps application calls on the BFF API surface, while the
 * browser's native request mode prevents cross-origin dispatch.
 */
export type BrowserApiPath = `/api/${string}`;

export function browserApiFetch(input: BrowserApiPath, init?: RequestInit): Promise<Response> {
  const pageLoadId = getPageLoadId();
  if (pageLoadId) {
    const headers = new Headers(init?.headers);
    if (!headers.has(TRACE_ID_HEADER)) {
      headers.set(TRACE_ID_HEADER, pageLoadId);
      init = { ...init, headers };
    }
  }
  return fetch(input, {
    ...init,
    mode: "same-origin",
    credentials: "same-origin",
  });
}
