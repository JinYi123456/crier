import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

/**
 * Who is allowed to speak for the platform.
 *
 * The pit itself is open: anybody may shout, and the book crosses what it is given. What a stranger
 * must not be able to do from a public URL is decide that the platform moves somebody's money, ring
 * the bell early, or edit the tape to watch the seals break. Those are the operator's actions, and
 * when `OPERATOR_TOKEN` is set they are refused unless the request quotes the key.
 *
 * With the variable unset every action is open, which is the point of a floor you can run on your own
 * machine with nothing installed - and the point of the README saying so.
 */

export const OPERATOR_ENV = 'OPERATOR_TOKEN';
export const OPERATOR_HEADER = 'x-operator-token';

/** The actions that bind the platform rather than a seat. */
const OPERATOR_ACTIONS: readonly string[] = ['trade', 'close', 'tamper'];

function expectedToken(env: Readonly<Record<string, string | undefined>>): string {
  return (env[OPERATOR_ENV] ?? '').trim();
}

export function isOperatorAction(action: string): boolean {
  return OPERATOR_ACTIONS.includes(action);
}

/** Whether this floor is refusing operator actions right now. Screens use it to show the key field. */
export function deskIsLocked(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return expectedToken(env).length > 0;
}

/**
 * `null` when the request may go ahead, the refusal it should be answered with otherwise. The
 * comparison is constant-time and the token never appears in the answer.
 */
export function operatorRefusal(request: Request, action: string, env: Readonly<Record<string, string | undefined>> = process.env): Response | null {
  const expected = expectedToken(env);
  if (expected.length === 0 || !isOperatorAction(action)) return null;
  const given = request.headers.get(OPERATOR_HEADER) ?? '';
  const offered = Buffer.from(given, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (offered.length === wanted.length && timingSafeEqual(offered, wanted)) return null;
  return NextResponse.json(
    { error: 'the settlement desk is locked: this action speaks for the platform and needs the operator key' },
    { status: 401 },
  );
}
