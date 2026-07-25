import { NextResponse } from 'next/server';

export function json<T>(body: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(body, init);
}

export function fail(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/** Every game route reads live state; nothing here may be cached. */
export const dynamic = 'force-dynamic';
