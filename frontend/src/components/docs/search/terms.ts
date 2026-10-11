/**
 * How the docs search turns words into index terms.
 *
 * The same function runs over the pages when the index is built and over
 * the query as it is typed, so "tracing", "traced" and "traces" all meet
 * "trace", and "passwords" meets "password". It is the first step of the
 * Porter stemmer — plurals and -ed / -ing — which is where nearly every
 * miss came from; the later steps fold words together too eagerly for a
 * product's own vocabulary ("general" and "generate" are different pages).
 */

/** Words that say nothing about which page you want. */
export const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for',
  'from', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'of',
  'on', 'or', 'so', 'that', 'the', 'their', 'then', 'there', 'this', 'to',
  'was', 'we', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with',
  'you', 'your',
])

const VOWEL = /[aeiou]/

/** A consonant at position `i`, treating `y` as Porter does. */
function isConsonant(word: string, i: number): boolean {
  const c = word[i]
  if (VOWEL.test(c)) return false
  if (c === 'y') return i === 0 || !isConsonant(word, i - 1)
  return true
}

/** Porter's "measure": the number of vowel-consonant runs in the stem. */
function measure(stem: string): number {
  let m = 0
  let i = 0
  const n = stem.length
  while (i < n && isConsonant(stem, i)) i++
  while (i < n) {
    while (i < n && !isConsonant(stem, i)) i++
    if (i >= n) break
    m++
    while (i < n && isConsonant(stem, i)) i++
  }
  return m
}

function hasVowel(stem: string): boolean {
  for (let i = 0; i < stem.length; i++) if (!isConsonant(stem, i)) return true
  return false
}

/** Consonant-vowel-consonant at the end, the last not w, x or y ("hop" → "hope"). */
function endsCvc(stem: string): boolean {
  const n = stem.length
  return n >= 3
    && isConsonant(stem, n - 3) && !isConsonant(stem, n - 2) && isConsonant(stem, n - 1)
    && !/[wxy]/.test(stem[n - 1])
}

function endsDoubleConsonant(stem: string): boolean {
  const n = stem.length
  return n >= 2 && stem[n - 1] === stem[n - 2] && isConsonant(stem, n - 1)
}

/** Porter step 1 (1a, 1b, 1c). Expects a lower-case word. */
export function stem(word: string): string {
  if (word.length <= 2) return word
  let w = word

  // 1a — plurals.
  if (w.endsWith('sses')) w = w.slice(0, -2)
  else if (w.endsWith('ies')) w = w.slice(0, -2)
  else if (w.endsWith('ss')) { /* keep */ }
  else if (w.endsWith('s') && !w.endsWith('us') && !w.endsWith('is')) w = w.slice(0, -1)

  // 1b — -eed, -ed, -ing.
  let stripped = false
  if (w.endsWith('eed')) {
    if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1)
  } else if (w.endsWith('ed') && hasVowel(w.slice(0, -2))) {
    w = w.slice(0, -2)
    stripped = true
  } else if (w.endsWith('ing') && hasVowel(w.slice(0, -3))) {
    w = w.slice(0, -3)
    stripped = true
  }
  if (stripped) {
    if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz')) w += 'e'
    else if (endsDoubleConsonant(w) && !/[lsz]$/.test(w)) w = w.slice(0, -1)
    else if (measure(w) === 1 && endsCvc(w)) w += 'e'
  }

  // 1c — a final y after a vowel-bearing stem.
  if (w.endsWith('y') && hasVowel(w.slice(0, -1))) w = w.slice(0, -1) + 'i'

  return w
}

/**
 * One raw token → its index term, or `null` to leave it out. MiniSearch
 * calls this for every token of every field, and for every query term.
 */
export function processTerm(token: string): string | null {
  const word = token
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
  if (word.length < 2 || STOP_WORDS.has(word)) return null
  return stem(word)
}
