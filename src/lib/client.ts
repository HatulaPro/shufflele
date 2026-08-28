/**
 * True when the app is running on fabricated data (lib/mock.ts).
 *
 * Lives here rather than being imported from lib/mock.ts because this one is
 * read in the browser, and that module is server-only — it renders WAV files
 * into node Buffers. The variable has to carry the `NEXT_PUBLIC_` prefix for
 * the same reason: nothing else reaches the client bundle.
 */
export const MOCK = process.env.NEXT_PUBLIC_SHUFFLELE_MOCK === '1';

/** A failed response, carrying the status so callers can tell 409 from 500. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Thin fetch wrapper: JSON in, JSON out, server error messages preserved. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // fall through to the status-code message
  }

  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Something went wrong (${res.status}).`;
    throw new ApiError(message, res.status);
  }

  return body as T;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
