import { NextResponse } from 'next/server';
import { SettlementError } from '../core/settlement';
import { GatewayError } from '../gateway/types';
import { FloorError } from './floor';

/**
 * Turning a thrown refusal into an answer.
 *
 * Every route here fails the same way on purpose: a person on the other end of a network call gets
 * one sentence that says what went wrong and a status that says what kind of wrong it was. The floor
 * has no half-errors - either the books moved or they did not, and the message says which.
 */
export function jsonError(error: unknown): Response {
  if (error instanceof FloorError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof SettlementError) return NextResponse.json({ error: error.message }, { status: 409 });
  if (error instanceof GatewayError) return NextResponse.json({ error: error.message, detail: error.detail }, { status: error.status });
  const message = error instanceof Error ? error.message : String(error);
  const status = /not authorised|invalid client/i.test(message) ? 401 : 502;
  return NextResponse.json({ error: message }, { status });
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = (await request.json()) as unknown;
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}
