const STORED = 'crier.operator.key';

/**
 * The key this browser hands the settlement desk.
 *
 * Kept in the page's own storage so a reload does not ask again, and never in a place the floor
 * reads back: the check lives on the server, and a browser that will not keep anything simply gets
 * asked every time.
 */

export function readOperatorKey(): string {
  try {
    return window.localStorage.getItem(STORED) ?? '';
  } catch {
    return '';
  }
}

export function rememberOperatorKey(key: string): void {
  try {
    if (key.length === 0) window.localStorage.removeItem(STORED);
    else window.localStorage.setItem(STORED, key);
  } catch {
    // A browser with its storage turned off is a browser that gets asked again.
  }
}
