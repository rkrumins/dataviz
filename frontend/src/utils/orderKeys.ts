/**
 * Fractional (LexoRank-style) order keys for user-defined node ordering
 * within a layer column — see `LayerAssignmentEntry.orderKey` in
 * frontend/src/types/schema.ts.
 *
 * Implements the base-62 fractional-indexing algorithm (à la
 * https://observablehq.com/@dgreensp/implementing-fractional-indexing /
 * rocicorp/fractional-indexing): keys are plain ASCII strings whose
 * ORDINAL comparison (`<` / `>`, never localeCompare) matches their
 * logical position. `generateKeyBetween` always finds a key strictly
 * between two neighbors, so inserts/moves never require renumbering other
 * entries; repeated midpoint insertion grows key length logarithmically
 * and keys never exhaust.
 *
 * Key shape: an "integer part" whose head char encodes its length
 * ('a'–'z' positive, 'A'–'Z' negative; "a0" is zero) followed by an
 * optional fraction that never ends in '0'.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

const SMALLEST_INTEGER = 'A00000000000000000000000000'

/** Ordinal comparator for order keys (safe for Array.prototype.sort). */
export function compareOrderKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function getIntegerLength(head: string): number {
  if (head >= 'a' && head <= 'z') {
    return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2
  }
  if (head >= 'A' && head <= 'Z') {
    return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2
  }
  throw new Error(`invalid order key head: ${head}`)
}

function getIntegerPart(key: string): string {
  const integerLength = getIntegerLength(key.charAt(0))
  if (integerLength > key.length) {
    throw new Error(`invalid order key: ${key}`)
  }
  return key.slice(0, integerLength)
}

function validateInteger(int: string): void {
  if (int.length !== getIntegerLength(int.charAt(0))) {
    throw new Error(`invalid order key integer part: ${int}`)
  }
}

function validateOrderKey(key: string): void {
  if (key === SMALLEST_INTEGER) {
    throw new Error(`invalid order key: ${key}`)
  }
  const integerPart = getIntegerPart(key) // throws on malformed head/length
  const fraction = key.slice(integerPart.length)
  if (fraction.slice(-1) === '0') {
    throw new Error(`invalid order key (trailing-zero fraction): ${key}`)
  }
}

/**
 * Midpoint of two fraction-digit strings (`b === null` = unbounded above).
 * Preconditions: `a < b` lexicographically, neither ends in '0'.
 */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) {
    throw new Error(`midpoint: ${a} >= ${b}`)
  }
  if (a.slice(-1) === '0' || (b !== null && b.slice(-1) === '0')) {
    throw new Error('midpoint: trailing zero')
  }
  if (b !== null) {
    // Strip the longest common prefix and recurse on the tails.
    let n = 0
    while ((a.charAt(n) || '0') === b.charAt(n)) n++
    if (n > 0) {
      return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
    }
  }
  const digitA = a === '' ? 0 : DIGITS.indexOf(a.charAt(0))
  const digitB = b === null ? DIGITS.length : DIGITS.indexOf(b.charAt(0))
  if (digitB - digitA > 1) {
    return DIGITS.charAt(Math.round(0.5 * (digitA + digitB)))
  }
  // First digits are consecutive.
  if (b !== null && b.length > 1) {
    return b.slice(0, 1)
  }
  return DIGITS.charAt(digitA) + midpoint(a.slice(1), null)
}

function incrementInteger(x: string): string | null {
  validateInteger(x)
  const [head, ...digs] = x.split('')
  let carry = true
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]) + 1
    if (d === DIGITS.length) {
      digs[i] = '0'
    } else {
      digs[i] = DIGITS.charAt(d)
      carry = false
    }
  }
  if (carry) {
    if (head === 'Z') return 'a0'
    if (head === 'z') return null
    const nextHead = String.fromCharCode(head.charCodeAt(0) + 1)
    if (nextHead > 'a') {
      digs.push('0')
    } else {
      digs.pop()
    }
    return nextHead + digs.join('')
  }
  return head + digs.join('')
}

function decrementInteger(x: string): string | null {
  validateInteger(x)
  const [head, ...digs] = x.split('')
  let borrow = true
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]) - 1
    if (d === -1) {
      digs[i] = DIGITS.slice(-1)
    } else {
      digs[i] = DIGITS.charAt(d)
      borrow = false
    }
  }
  if (borrow) {
    if (head === 'a') return 'Z' + DIGITS.slice(-1)
    if (head === 'A') return null
    const prevHead = String.fromCharCode(head.charCodeAt(0) - 1)
    if (prevHead < 'Z') {
      digs.push(DIGITS.slice(-1))
    } else {
      digs.pop()
    }
    return prevHead + digs.join('')
  }
  return head + digs.join('')
}

/**
 * A key strictly between `a` and `b` (ordinal string order). `null` means
 * unbounded: `(null, null)` → first-ever key, `(last, null)` → append,
 * `(null, first)` → prepend. Throws if `a >= b` or either key is malformed.
 */
export function generateKeyBetween(a: string | null, b: string | null): string {
  if (a !== null) validateOrderKey(a)
  if (b !== null) validateOrderKey(b)
  if (a !== null && b !== null && a >= b) {
    throw new Error(`generateKeyBetween: ${a} >= ${b}`)
  }

  if (a === null) {
    if (b === null) return 'a0'
    const ib = getIntegerPart(b)
    const fb = b.slice(ib.length)
    if (ib === SMALLEST_INTEGER) {
      return ib + midpoint('', fb)
    }
    if (ib < b) return ib // b carries a fraction → its bare integer sorts before it
    const res = decrementInteger(ib)
    if (res === null) throw new Error('generateKeyBetween: cannot decrement any more')
    return res
  }

  if (b === null) {
    const ia = getIntegerPart(a)
    const fa = a.slice(ia.length)
    const i = incrementInteger(ia)
    return i === null ? ia + midpoint(fa, null) : i
  }

  const ia = getIntegerPart(a)
  const fa = a.slice(ia.length)
  const ib = getIntegerPart(b)
  const fb = b.slice(ib.length)
  if (ia === ib) {
    return ia + midpoint(fa, fb)
  }
  const i = incrementInteger(ia)
  if (i === null) throw new Error('generateKeyBetween: cannot increment any more')
  if (i < b) return i
  return ia + midpoint(fa, null)
}

/**
 * `n` evenly-distributed keys strictly between `a` and `b` (both nullable,
 * same semantics as generateKeyBetween). Used to seed orderKeys for a whole
 * layer when it switches to custom sort mode.
 */
export function generateNKeysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n === 0) return []
  if (n === 1) return [generateKeyBetween(a, b)]
  if (b === null) {
    let c = generateKeyBetween(a, b)
    const result = [c]
    for (let i = 0; i < n - 1; i++) {
      c = generateKeyBetween(c, b)
      result.push(c)
    }
    return result
  }
  if (a === null) {
    let c = generateKeyBetween(a, b)
    const result = [c]
    for (let i = 0; i < n - 1; i++) {
      c = generateKeyBetween(a, c)
      result.push(c)
    }
    return result.reverse()
  }
  const mid = Math.trunc(n / 2)
  const c = generateKeyBetween(a, b)
  return [...generateNKeysBetween(a, c, mid), c, ...generateNKeysBetween(c, b, n - mid - 1)]
}
