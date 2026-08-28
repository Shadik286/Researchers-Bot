/**
 * Outbound request description shared by every adapter.
 */

export type HttpMethod = "GET" | "POST";

export interface HttpRequestOptions {
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Query parameters; `undefined` values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Overrides the adapter default (e.g. Atom XML instead of JSON). */
  accept?: string;
  /** Skip the retry loop for calls where a retry makes no sense. */
  noRetry?: boolean;
  /** Label used in logs, e.g. "search" or "doi-lookup". */
  operation?: string;
  /** Per-call cache TTL override, in seconds. */
  cacheTtlSeconds?: number;
}

export interface HttpResponseMeta {
  status: number;
  headers: Record<string, string>;
  url: string;
  durationMs: number;
  attempts: number;
}

export interface HttpResponse<T> {
  data: T;
  meta: HttpResponseMeta;
}

/** Serializes a query object into a URLSearchParams-compatible shape. */
export function buildQueryString(
  query: Record<string, string | number | boolean | undefined> | undefined,
): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.append(key, String(value));
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

export function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    // Response headers are provider-controlled, but a stray credential echo
    // must never make it into a log line.
    if (/^(authorization|set-cookie|cookie)$/i.test(key)) return;
    out[key.toLowerCase()] = value;
  });
  return out;
}
