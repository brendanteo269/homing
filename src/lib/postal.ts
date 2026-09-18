/**
 * Singapore postal codes, as people actually type them.
 *
 * Every address in the country has a six-digit code, and typing one is the
 * shortest way to name a building unambiguously — so the app has to accept the
 * forms people use: with the sector's leading zero missing, with an "S" in
 * front, with "Singapore" spelled out, or broken up with a space or a dash.
 *
 * Kept free of any Node imports so the browser can use it too.
 */

/** The complete six-digit code a query means, or null if it is not one. */
export function parsePostal(input: string): string | null {
  const digits = digitsOf(input);
  if (digits === null) return null;
  if (digits.length === 6) return digits;
  // Sectors 01-09 — the city centre and the south — are routinely typed
  // without the leading zero, and 018956 is only ever written as five digits
  // by someone who means 018956.
  if (digits.length === 5) return `0${digits}`;
  return null;
}

/**
 * Whether a query is on its way to being a postal code. A half-typed one is
 * worth nothing to a geocoder: "5604" matches a thousand unrelated blocks, so
 * the search waits rather than sending it.
 */
export function looksLikePostalPrefix(input: string): boolean {
  return digitsOf(input) !== null;
}

/**
 * Whether a query is the five-digit short form. It is genuinely ambiguous:
 * "56040" is both a city-centre code with its leading zero dropped and the
 * first five digits of 560406, and mid-typing it is nearly always the latter.
 * Callers use this to wait a beat longer before spending a lookup on it —
 * another keystroke settles the question for free, and only a real pause
 * means the short form.
 */
export function isShortFormPostal(input: string): boolean {
  return digitsOf(input)?.length === 5;
}

function digitsOf(input: string): string | null {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/^singapore\b/, "")
    .replace(/^s(?=\s*\d)/, "")
    .replace(/[\s-]/g, "");
  return cleaned.length > 0 && /^\d+$/.test(cleaned) ? cleaned : null;
}
