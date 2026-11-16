/**
 * Units: how a quantity is written for people, and read back from what they type.
 *
 * Settings used to format their own numbers, each a little differently: "2 GB" here, "2048 MB"
 * there, a bare "300" that meant seconds in one card and minutes in the next. Every number in the
 * settings kit goes through these instead, so a value reads the same wherever it appears and
 * always carries its unit.
 *
 * Each `format*` has a `parse*` that reads its output back (and the looser things people type:
 * "1h30m", "13gb", "200k"). A parse that can't read the text returns `null`, never a guess.
 *
 * - Bytes are binary (1 KB = 1,024 bytes), counted the way the graph store's nodes report memory.
 * - Durations are seconds, said in words ("15 seconds", "1 hour 30 minutes") as the server says
 *   them; `ms` values are milliseconds, "250 ms" under a second.
 * - A `percent` is 0–100 ("85%"); a `ratio` is a plain number, shown in percent ("40%", "250%").
 * - `"unlimited"` and `"forever"` are values in their own right, never a magic number.
 *
 * Numbers use the reader's locale for separators, and parse accepts the same separators back.
 */

export const UNLIMITED = 'unlimited' as const
export const FOREVER = 'forever' as const
export type Unlimited = typeof UNLIMITED
export type Forever = typeof FOREVER

/** A unit a quantity can be entered in, and how many base units one of it holds. */
export interface QuantityUnit {
    id: string
    /** As written after a number: "GB", "min". */
    label: string
    factor: number
}

// ── Numbers ─────────────────────────────────────────────────────────────────

const separatorCache = new Map<string, { group: string; decimal: string }>()

/** The locale's thousands and decimal separators. */
function separators(locale?: string): { group: string; decimal: string } {
    const key = locale ?? ''
    const known = separatorCache.get(key)
    if (known) return known
    const parts = new Intl.NumberFormat(locale).formatToParts(12345.6)
    const found = {
        group: parts.find(p => p.type === 'group')?.value ?? ',',
        decimal: parts.find(p => p.type === 'decimal')?.value ?? '.',
    }
    separatorCache.set(key, found)
    return found
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `1234.5` → "1,234.5" (in the reader's locale), with at most `maxFractionDigits` decimals. */
export function formatNumber(n: number, { maxFractionDigits = 2, locale }: { maxFractionDigits?: number; locale?: string } = {}): string {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: maxFractionDigits }).format(n)
}

/**
 * Reads a number written with the locale's separators: "1,234.5", "1234.5", "1 234,5" (fr), and
 * "1_000". Thousands separators must group by three, so "1,5" in English is refused rather than
 * read as fifteen.
 */
export function parseNumber(text: string, locale?: string): number | null {
    const { group, decimal } = separators(locale)
    const s = text.trim().replace(/[\s\u00a0\u202f_]/g, '')
    if (!s) return null
    const g = /\s|\u00a0|\u202f/.test(group) ? '' : escapeRe(group)
    const d = escapeRe(decimal)
    const grouped = g ? `\\d{1,3}(?:${g}\\d{3})+` : null
    const re = new RegExp(`^([+-]?)(${grouped ? `${grouped}|` : ''}\\d+|(?=${d}\\d))(?:${d}(\\d+))?$`)
    const m = re.exec(s)
    if (!m) return null
    const whole = (g ? m[2].replace(new RegExp(g, 'g'), '') : m[2]) || '0'
    const value = Number(`${m[1]}${whole}${m[3] ? `.${m[3]}` : ''}`)
    return Number.isFinite(value) ? value : null
}

/** Splits "1.5 GB" into the number and what follows it. */
function splitUnit(text: string, locale?: string): { value: number; unit: string } | null {
    const m = /^\s*([+-]?[\d\s\u00a0\u202f_.,]*\d)\s*([^\d\s].*)?$/.exec(text)
    if (!m) return null
    const value = parseNumber(m[1], locale)
    if (value === null) return null
    return { value, unit: (m[2] ?? '').trim().toLowerCase() }
}

/** The plural of a unit noun, for `n`: "1 row", "2 rows", "1 entity", "2 entities". */
export function pluralize(n: number, noun: string): string {
    if (Math.abs(n) === 1) {
        if (noun.endsWith('ies')) return `${noun.slice(0, -3)}y`
        if (noun.endsWith('ses') || noun.endsWith('xes')) return noun.slice(0, -2)
        if (noun.endsWith('s') && !noun.endsWith('ss')) return noun.slice(0, -1)
        return noun
    }
    if (noun.endsWith('s')) return noun
    if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`
    return `${noun}s`
}

// ── Counts ──────────────────────────────────────────────────────────────────

/** `200000, 'rows'` → "200,000 rows"; `1, 'rows'` → "1 row"; no noun → "200,000". */
export function formatCount(n: number, noun?: string, locale?: string): string {
    const num = formatNumber(n, { maxFractionDigits: 0, locale })
    return noun ? `${num} ${pluralize(n, noun)}` : num
}

const COUNT_SUFFIX: Record<string, number> = {
    k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9,
}

/**
 * A whole number ≥ 0: "200,000", "200000", "200k", "1.5M", "200,000 rows". A trailing word that
 * isn't a known multiplier is taken as the unit noun and ignored.
 */
export function parseCount(text: string, locale?: string): number | null {
    const split = splitUnit(text, locale)
    if (!split) return null
    const word = split.unit.split(/\s+/)[0] ?? ''
    const factor = COUNT_SUFFIX[word] ?? 1
    const n = split.value * factor
    if (n < 0) return null
    const rounded = Math.round(n)
    return Math.abs(rounded - n) < 1e-9 ? rounded : null
}

// ── Unlimited / forever ─────────────────────────────────────────────────────

const UNLIMITED_WORDS = new Set(['unlimited', 'no limit', 'nolimit', 'none', '∞', 'inf', 'infinite', 'infinity'])
const FOREVER_WORDS = new Set(['forever', 'for good', 'never', '∞', 'always', 'indefinitely'])

export const isUnlimited = (v: unknown): v is Unlimited => v === UNLIMITED
export const isForever = (v: unknown): v is Forever => v === FOREVER

/** `'unlimited'` → "Unlimited"; a number as `formatCount`. */
export function formatCountOrUnlimited(v: number | Unlimited, noun?: string, locale?: string): string {
    return isUnlimited(v) ? 'Unlimited' : formatCount(v, noun, locale)
}

export function parseCountOrUnlimited(text: string, locale?: string): number | Unlimited | null {
    if (UNLIMITED_WORDS.has(text.trim().toLowerCase())) return UNLIMITED
    return parseCount(text, locale)
}

// ── Bytes (binary) ──────────────────────────────────────────────────────────

export const BYTE_UNITS: QuantityUnit[] = [
    { id: 'B', label: 'bytes', factor: 1 },
    { id: 'KB', label: 'KB', factor: 1024 },
    { id: 'MB', label: 'MB', factor: 1024 ** 2 },
    { id: 'GB', label: 'GB', factor: 1024 ** 3 },
    { id: 'TB', label: 'TB', factor: 1024 ** 4 },
]

const BYTE_ALIASES: Record<string, number> = {
    '': 1, b: 1, byte: 1, bytes: 1,
    k: 1024, kb: 1024, kib: 1024,
    m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2,
    g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3,
    t: 1024 ** 4, tb: 1024 ** 4, tib: 1024 ** 4,
}

/**
 * The unit to show a value in: the largest whose figure is at least 1 and exact to `maxDecimals`
 * decimals (5,400 s → "90 min", not "1.5 h" when `maxDecimals` is 0), else the smallest unit.
 */
export function pickUnit(value: number, units: QuantityUnit[], maxDecimals = 2): QuantityUnit {
    const scale = 10 ** maxDecimals
    for (let i = units.length - 1; i > 0; i -= 1) {
        const u = units[i]
        if (Math.abs(value) < u.factor) continue
        const figure = value / u.factor
        if (Math.abs(Math.round(figure * scale) / scale - figure) < 1e-9) return u
    }
    return units[0]
}

/** `13958643712` → "13 GB"; `1536` → "1.5 KB"; `1` → "1 byte". Up to two decimals. */
export function formatBytes(n: number, locale?: string): string {
    // The largest unit the value reaches, shown to two decimals: readable, and exact for the
    // round values settings hold.
    let unit = BYTE_UNITS[0]
    for (const u of BYTE_UNITS) if (Math.abs(n) >= u.factor) unit = u
    if (unit.factor === 1) return `${formatNumber(n, { maxFractionDigits: 0, locale })} ${Math.abs(n) === 1 ? 'byte' : 'bytes'}`
    return `${formatNumber(n / unit.factor, { locale })} ${unit.label}`
}

/** "13 GB", "13GiB", "13g", "1.5 TB", "512 bytes", "1024" (bytes). Whole bytes only. */
export function parseBytes(text: string, locale?: string): number | null {
    const split = splitUnit(text, locale)
    if (!split) return null
    const factor = BYTE_ALIASES[split.unit]
    if (factor === undefined || split.value < 0) return null
    return Math.round(split.value * factor)
}

export function formatBytesOrUnlimited(v: number | Unlimited, locale?: string): string {
    return isUnlimited(v) ? 'Unlimited' : formatBytes(v, locale)
}

export function parseBytesOrUnlimited(text: string, locale?: string): number | Unlimited | null {
    if (UNLIMITED_WORDS.has(text.trim().toLowerCase())) return UNLIMITED
    return parseBytes(text, locale)
}

// ── Durations (seconds) ─────────────────────────────────────────────────────

export const DURATION_UNITS: QuantityUnit[] = [
    { id: 's', label: 's', factor: 1 },
    { id: 'min', label: 'min', factor: 60 },
    { id: 'h', label: 'h', factor: 3600 },
    { id: 'd', label: 'd', factor: 86400 },
]

/** The same units, spelled out for a unit picker. */
export const DURATION_UNIT_NAMES: Record<string, string> = { s: 'seconds', min: 'minutes', h: 'hours', d: 'days' }

const LONG_NAMES: Record<string, [string, string]> = {
    d: ['day', 'days'], h: ['hour', 'hours'], min: ['minute', 'minutes'], s: ['second', 'seconds'],
}

const DURATION_ALIASES: Record<string, number> = {
    '': 1, s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
    m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
    h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
    d: 86400, day: 86400, days: 86400,
    w: 604800, wk: 604800, wks: 604800, week: 604800, weeks: 604800,
}

/**
 * Seconds in the units a person would say: `5400` → "1 hour 30 minutes", `604800` → "7 days".
 * `short` writes "1 h 30 min".
 */
export function formatDuration(secs: number, { style = 'long', locale }: { style?: 'long' | 'short'; locale?: string } = {}): string {
    const sign = secs < 0 ? '-' : ''
    let rest = Math.abs(secs)
    const parts: string[] = []
    for (const u of [...DURATION_UNITS].reverse()) {
        const whole = u.factor === 1 ? rest : Math.floor(rest / u.factor + 1e-9)
        if (whole <= 0 && !(u.factor === 1 && parts.length === 0)) continue
        rest -= whole * u.factor
        const figure = formatNumber(whole, { maxFractionDigits: 3, locale })
        parts.push(style === 'short' ? `${figure} ${u.label}` : `${figure} ${LONG_NAMES[u.id][whole === 1 ? 0 : 1]}`)
        if (rest < 1e-9) break
    }
    return sign + parts.join(' ')
}

/**
 * "90" (seconds), "90s", "1.5h", "1h30m", "1 hour 30 minutes", "2 days 6 hours", "2w". `m` is
 * minutes. Returns seconds, which may be fractional ("1.5s").
 */
export function parseDuration(text: string, locale?: string): number | null {
    const s = text.trim().toLowerCase()
    if (!s) return null
    const bare = parseNumber(s, locale)
    if (bare !== null) return bare >= 0 ? bare : null
    const { decimal } = separators(locale)
    const re = new RegExp(`(\\d+(?:${escapeRe(decimal)}\\d+)?)\\s*([a-z]+)`, 'g')
    let total = 0
    let consumed = ''
    for (const m of s.matchAll(re)) {
        const factor = DURATION_ALIASES[m[2]]
        const figure = parseNumber(m[1], locale)
        if (factor === undefined || figure === null) return null
        total += figure * factor
        consumed += m[0]
    }
    // Everything but spaces and joining words must have been read.
    if (!consumed || s.replace(/\s+|,|and/g, '') !== consumed.replace(/\s+/g, '')) return null
    return total
}

// ── Days ────────────────────────────────────────────────────────────────────

/** `1` → "1 day", `30` → "30 days". */
export function formatDays(n: number, locale?: string): string {
    return `${formatNumber(n, { maxFractionDigits: 0, locale })} ${Math.abs(n) === 1 ? 'day' : 'days'}`
}

/** "30", "30 days", "30d", "2 weeks" → whole days. */
export function parseDays(text: string, locale?: string): number | null {
    const split = splitUnit(text, locale)
    if (!split) return null
    const perUnit: Record<string, number> = { '': 1, d: 1, day: 1, days: 1, w: 7, wk: 7, week: 7, weeks: 7 }
    const factor = perUnit[split.unit]
    if (factor === undefined || split.value < 0) return null
    const n = split.value * factor
    return Number.isInteger(n) ? n : null
}

/** `'forever'` → "Forever"; a number as `formatDays`. */
export function formatDaysOrForever(v: number | Forever, locale?: string): string {
    return isForever(v) ? 'Forever' : formatDays(v, locale)
}

export function parseDaysOrForever(text: string, locale?: string): number | Forever | null {
    if (FOREVER_WORDS.has(text.trim().toLowerCase())) return FOREVER
    return parseDays(text, locale)
}

// ── Milliseconds ────────────────────────────────────────────────────────────

export const MS_UNITS: QuantityUnit[] = [
    { id: 'ms', label: 'ms', factor: 1 },
    { id: 's', label: 's', factor: 1000 },
    { id: 'min', label: 'min', factor: 60_000 },
]

/** `250` → "250 ms", `1500` → "1,500 ms", `30000` → "30 seconds", `90000` → "1 minute 30 seconds". */
export function formatMs(ms: number, locale?: string): string {
    if (Math.abs(ms) < 1000 || ms % 1000 !== 0) return `${formatNumber(ms, { locale })} ms`
    return formatDuration(ms / 1000, { locale })
}

/** "250", "250ms", "1.5s", "2 min", "1 min 30 s" → milliseconds. */
export function parseMs(text: string, locale?: string): number | null {
    const s = text.trim().toLowerCase()
    const split = splitUnit(s, locale)
    if (split && (split.unit === '' || split.unit === 'ms' || split.unit === 'millisecond' || split.unit === 'milliseconds')) {
        return split.value >= 0 ? split.value : null
    }
    const secs = parseDuration(s, locale)
    return secs === null ? null : Math.round(secs * 1000 * 1000) / 1000
}

// ── Percent and ratio ───────────────────────────────────────────────────────

/** A percent held as 0–100: `85` → "85%", `0.5` → "0.5%". */
export function formatPercent(p: number, locale?: string): string {
    return `${formatNumber(p, { locale })}%`
}

/** "85%", "85 %", "85" → 85. */
export function parsePercent(text: string, locale?: string): number | null {
    const split = splitUnit(text, locale)
    if (!split || (split.unit !== '' && split.unit !== '%' && split.unit !== 'percent')) return null
    return split.value
}

export type RatioStyle = 'share' | 'times'

/**
 * A ratio: as a share of a whole (`0.4` → "40%") or as a multiplier (`0.5` → "×0.5", what a pause
 * is of the write before it).
 */
export function formatRatio(r: number, style: RatioStyle = 'share', locale?: string): string {
    if (style === 'times') return `×${formatNumber(r, { locale })}`
    return formatPercent(Math.round(r * 100 * 1e6) / 1e6, locale)
}

/**
 * "40%" → 0.4 in either style. A bare number is the ratio itself ("0.4", or "1.5" for a
 * multiplier), except a share above 1, which can only mean a percent ("40" → 0.4).
 */
export function parseRatio(text: string, style: RatioStyle = 'share', locale?: string): number | null {
    const s = text.trim().replace(/^[×x*]\s*/i, '').replace(/\s*[×x]$/i, '')
    const split = splitUnit(s, locale)
    if (!split) return null
    if (split.unit === '%' || split.unit === 'percent') return Math.round(split.value * 1e6) / 1e8
    if (split.unit !== '') return null
    if (style === 'share' && split.value > 1) return Math.round(split.value * 1e6) / 1e8
    return split.value
}

// ── Refused-rows budget ─────────────────────────────────────────────────────

/**
 * How many rows an import may refuse and still land: `"0"` (none), a count (`"100"`), a share of
 * the import's rows (`"0.5%"`), or `"unlimited"`.
 */
export function formatRefusalBudget(v: string, locale?: string): string {
    if (v === UNLIMITED) return 'Unlimited'
    if (v.endsWith('%')) return `${formatPercent(Number(v.slice(0, -1)), locale)} of rows`
    const n = Number(v)
    if (n === 0) return 'None'
    return formatCount(n, 'rows', locale)
}

/** "none", "0", "100", "100 rows", "0.5%", "0.5% of rows", "unlimited" → the stored form. */
export function parseRefusalBudget(text: string, locale?: string): string | null {
    const s = text.trim().toLowerCase().replace(/\s+of\s+(the\s+)?rows$/, '')
    if (UNLIMITED_WORDS.has(s) && s !== 'none') return UNLIMITED
    if (s === 'none' || s === 'no rows') return '0'
    if (s.endsWith('%')) {
        const p = parseNumber(s.slice(0, -1), locale)
        return p !== null && p >= 0 && p <= 100 ? `${p}%` : null
    }
    const n = parseCount(s, locale)
    return n === null ? null : String(n)
}
