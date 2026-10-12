/**
 * JSON.parse that never rounds an integer.
 *
 * `JSON.parse` turns every number into an IEEE double, so an integer beyond
 * ±(2^53 − 1) — the ids, hashes and snowflakes data sources are full of —
 * arrives as a NEIGHBOUR of itself: -3746471915534727923 reads back as
 * -3746471915534727700 and prints as -3746471915534728000. Everything
 * downstream then works on a value the graph does not hold: the Property
 * Manager shows it, a search for it matches nothing, and a save writes it
 * back over the real one.
 *
 * Here such an integer arrives as its exact decimal digits in a STRING
 * instead. Every other number, and every response that carries no 16-digit
 * run at all (the fast path — nearly all of them), parses exactly as
 * `JSON.parse` would. The server keeps sending plain JSON numbers: they are
 * exact for every client that does not parse into doubles.
 */

// A safe integer has at most 16 digits, so a document without a 16-digit run
// cannot hold an unsafe one. Digits inside strings also trip it (a long urn),
// which only costs the slow path, never a wrong answer.
const MAY_HOLD_UNSAFE_INTEGER = /\d{16}/

// One token at a time, left to right: a whole string (so digits inside one are
// never looked at) or a number. JSON has no other token that contains digits.
const STRING_OR_NUMBER = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g

function quoteIfUnsafe(token: string): string {
    if (token.charCodeAt(0) === 34 /* " */) return token
    if (token.length < 16 || /[.eE]/.test(token)) return token
    return Number.isSafeInteger(Number(token)) ? token : `"${token}"`
}

export function parseJsonLossless<T = unknown>(text: string): T {
    if (!MAY_HOLD_UNSAFE_INTEGER.test(text)) return JSON.parse(text) as T
    return JSON.parse(text.replace(STRING_OR_NUMBER, quoteIfUnsafe)) as T
}

/** `response.json()`, lossless. */
export async function readJsonLossless<T = unknown>(response: Response): Promise<T> {
    return parseJsonLossless<T>(await response.text())
}
