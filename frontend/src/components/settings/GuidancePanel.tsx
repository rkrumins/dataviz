/**
 * GuidancePanel — everything someone needs to decide, from the registry: what the setting means,
 * what changing it does to each dimension, when to change it, the recommended value and why (and
 * what this platform's own facts recommend), the risk, an example worked with the values in force,
 * and the measured evidence.
 *
 * Plain words first. The engineering facts (key, env var, timing, caps, the measured evidence,
 * where it was stored) sit under "Technical details", collapsed except in the Technical view. Defined
 * terms ("graph store", "copy") carry their glossary definition on hover and focus, and in the
 * Technical view the term's technical note too.
 */
import { Fragment, type ReactNode } from 'react'
import { BookOpen, CircleDashed, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { HoverTip } from '@/components/ui/HoverTip'
import { formatValue, sameValue } from './format'
import type { Lens } from './lens'
import { RISK_META, VERDICT_META } from './meta'
import type { Dimension, DimensionInfo, Setting, SettingValue, Term, Verdict, Weight } from './types'

const WEIGHT_DOTS: Record<Weight, number> = { low: 1, medium: 2, high: 3 }

function Heading({ children }: { children: ReactNode }) {
    return <h4 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-secondary">{children}</h4>
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The level names are on every line; underlining them would underline everything. */
const PLAIN = new Set(['default', 'platform', 'workspace', 'graph'])
const MAX_TERMS = 3

/**
 * Where a glossary term is meant, not just its word: a term of several words anywhere; a single
 * word only written as the term writes it, mid-sentence ("graphs set to Coldline"), so "always"
 * in "how reads have always worked" isn't taken for the Always class.
 */
function termPattern(term: string): RegExp | null {
    if (PLAIN.has(term.toLowerCase())) return null
    return /[\s-]/.test(term)
        ? new RegExp(`\\b${escapeRe(term)}\\b`, 'i')
        : new RegExp(`(?<=[a-z,;] )${escapeRe(term)}\\b`)
}

/** Text with the first use of up to three glossary terms underlined, each carrying its definition
 *  (and, for `technical`, the term's technical note). */
function Prose({ text, glossary, technical }: { text: string; glossary: Term[]; technical: boolean }) {
    const parts: Array<string | { text: string; term: Term }> = [text]
    let found = 0
    for (const term of [...glossary].sort((a, b) => b.term.length - a.term.length)) {
        const re = termPattern(term.term)
        if (!re || found >= MAX_TERMS) continue
        const at = parts.findIndex((p) => typeof p === 'string' && re.test(p))
        if (at < 0) continue
        found += 1
        const s = parts[at] as string
        const m = re.exec(s) as RegExpExecArray
        parts.splice(at, 1, s.slice(0, m.index), { text: m[0], term }, s.slice(m.index + m[0].length))
    }
    return (
        <>
            {parts.map((p, i) => typeof p === 'string' ? <Fragment key={i}>{p}</Fragment> : (
                <HoverTip key={i} label={p.term.definition} detail={technical && p.term.technical ? `Technical: ${p.term.technical}` : undefined} className="inline">
                    <span tabIndex={0} className="cursor-help underline decoration-dotted decoration-ink-muted/60 underline-offset-[3px] outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                        {p.text}
                    </span>
                </HoverTip>
            ))}
        </>
    )
}

function WeightDots({ weight }: { weight: Weight }) {
    return (
        <span className="inline-flex items-center gap-0.5" role="img" aria-label={`${weight} impact`}>
            {[1, 2, 3].map((i) => (
                <span key={i} className={cn('h-1.5 w-1.5 rounded-full', i <= WEIGHT_DOTS[weight] ? 'bg-ink-secondary' : 'bg-ink-muted/25')} />
            ))}
        </span>
    )
}

/** For a number: each dimension it affects, and what raising and lowering it do. */
function EffectsTable({ setting, dimensions }: { setting: Setting; dimensions: DimensionInfo[] }) {
    const name = (d: Dimension) => dimensions.find((x) => x.id === d)?.label ?? d
    return (
        <table className="w-full border-separate border-spacing-0 text-left text-[12.5px]">
            <caption className="sr-only">What raising and lowering {setting.label} does</caption>
            <thead>
                <tr className="text-[11px] text-ink-secondary">
                    <th scope="col" className="pb-1.5 pr-4 font-medium">Affects</th>
                    <th scope="col" className="pb-1.5 font-medium">Raising it · Lowering it</th>
                </tr>
            </thead>
            <tbody>
                {setting.guidance.effects.map((e) => (
                    <tr key={e.dimension}>
                        <th scope="row" className="border-t border-glass-border/50 py-2 pr-4 align-top font-semibold text-ink whitespace-nowrap">
                            <span className="block">{name(e.dimension)}</span>
                            <WeightDots weight={e.weight} />
                        </th>
                        <td className="border-t border-glass-border/50 py-2 align-top leading-relaxed text-ink-secondary">
                            <span className="block"><span className="font-medium text-ink">Raising: </span>{e.up}</span>
                            <span className="block"><span className="font-medium text-ink">Lowering: </span>{e.down}</span>
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    )
}

/** For a choice: each option's verdict on each dimension, side by side. */
function VerdictMatrix({ setting, dimensions }: { setting: Setting; dimensions: DimensionInfo[] }) {
    const named = dimensions.filter((d) => setting.choices.some((c) => c.effects[d.id]))
    if (!named.length) return null
    return (
        <div className="overflow-x-auto">
            <table className="w-full min-w-[22rem] border-separate border-spacing-0 text-left text-[12.5px]">
                <caption className="sr-only">What each choice of {setting.label} does to each dimension</caption>
                <thead>
                    <tr className="text-[11px] text-ink-secondary">
                        <th scope="col" className="pb-1.5 pr-3 font-medium">Dimension</th>
                        {setting.choices.map((c) => <th key={c.id} scope="col" className="pb-1.5 px-2 font-medium">{c.short}</th>)}
                    </tr>
                </thead>
                <tbody>
                    {named.map((d) => (
                        <tr key={d.id}>
                            <th scope="row" className="border-t border-glass-border/50 py-1.5 pr-3 font-medium text-ink whitespace-nowrap">{d.label}</th>
                            {setting.choices.map((c) => {
                                const effect = c.effects[d.id]
                                const verdict: Verdict | null = effect?.[0] ?? null
                                const meta = verdict ? VERDICT_META[verdict] : null
                                const Icon = meta?.icon
                                return (
                                    <td key={c.id} className="border-t border-glass-border/50 px-2 py-1.5">
                                        {Icon && meta ? (
                                            <span className={cn('inline-flex items-center gap-1', meta.glyph)}>
                                                <Icon aria-hidden className="w-3.5 h-3.5" />
                                                <span className="sr-only">{meta.label}: {effect?.[1]}</span>
                                            </span>
                                        ) : (
                                            <span className="inline-flex items-center text-ink-muted" title="Not stated">
                                                <CircleDashed aria-hidden className="w-3 h-3" /><span className="sr-only">not stated</span>
                                            </span>
                                        )}
                                    </td>
                                )
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

export interface GuidancePanelProps {
    setting: Setting
    dimensions: DimensionInfo[]
    glossary?: Term[]
    lens?: Lens
    /** The value in force (or staged), to say whether it is already the recommended one. */
    current?: SettingValue
    /** Stages the recommended value. It never saves. */
    onUseRecommended?: (value: SettingValue) => void
    /** An interactive explainer, drawn first. */
    visual?: ReactNode
    id?: string
    className?: string
}

export function GuidancePanel({
    setting: s, dimensions, glossary = [], lens = 'business', current, onUseRecommended, visual, id, className,
}: GuidancePanelProps) {
    const g = s.guidance
    const rec = g.recommended.forThisPlatform?.value ?? g.recommended.value
    const already = current !== undefined && sameValue(current, rec)
    const risk = RISK_META[g.risk]
    const legacy = s.legacy
        ? Object.entries(s.legacy).filter(([k, v]) => v && k !== 'encode').map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}: ${v}`)
        : []

    return (
        <div id={id} className={cn('grid gap-x-8 gap-y-6 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]', className)}>
            {visual && <div className="min-w-0 lg:col-span-2">{visual}</div>}

            <div className="space-y-5 min-w-0">
                <section className="space-y-1.5">
                    <Heading>What it means</Heading>
                    <p className="text-[13.5px] leading-relaxed text-ink-secondary"><Prose text={g.means} glossary={glossary} technical={lens === 'operator'} /></p>
                </section>
                {(s.kind === 'choice' || g.effects.length > 0) && (
                    <section className="space-y-2">
                        <Heading>What changing it does</Heading>
                        {s.kind === 'choice' ? <VerdictMatrix setting={s} dimensions={dimensions} /> : <EffectsTable setting={s} dimensions={dimensions} />}
                    </section>
                )}
                {g.changeWhen.length > 0 && (
                    <section className="space-y-1.5">
                        <Heading>When to change it</Heading>
                        <ul className="space-y-1 text-[13.5px] leading-relaxed text-ink-secondary">
                            {g.changeWhen.map((w) => (
                                <li key={w} className="flex gap-2"><span aria-hidden className="text-ink-muted">–</span><span>{w}</span></li>
                            ))}
                        </ul>
                    </section>
                )}
                {g.example && (
                    <section className="space-y-1.5">
                        <Heading>For example</Heading>
                        <p className="rounded-xl bg-black/[0.03] px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink-secondary dark:bg-white/[0.04]">
                            <Prose text={g.example} glossary={glossary} technical={lens === 'operator'} />
                        </p>
                    </section>
                )}
            </div>

            <div className="space-y-5 min-w-0">
                <section className="space-y-2 rounded-2xl border border-glass-border/60 p-4">
                    <Heading>Recommended</Heading>
                    <p className="text-sm font-semibold text-ink">{formatValue(s, g.recommended.value)}</p>
                    <p className="text-[12.5px] leading-relaxed text-ink-secondary">{g.recommended.why}</p>
                    {g.recommended.forThisPlatform && (
                        <div className="rounded-xl bg-black/[0.03] px-3 py-2.5 dark:bg-white/[0.04]">
                            <p className="text-[12.5px] font-semibold text-ink">
                                For your platform: {formatValue(s, g.recommended.forThisPlatform.value)}
                            </p>
                            <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">{g.recommended.forThisPlatform.why}</p>
                        </div>
                    )}
                    {onUseRecommended && (
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                            <Button size="sm" variant="secondary" leftIcon={Sparkles} disabled={already} onClick={() => onUseRecommended(rec)}>
                                Use recommended
                            </Button>
                            <span className="text-[12.5px] text-ink-secondary">{already ? 'Already in use.' : 'Stages it; nothing is saved until you review.'}</span>
                        </div>
                    )}
                </section>
                <section className="space-y-1.5">
                    <Heading>Risk</Heading>
                    <Badge tone={risk.tone} size="md">{risk.label}</Badge>
                    {g.riskNote && <p className="text-[12.5px] leading-relaxed text-ink-secondary">{g.riskNote}</p>}
                </section>
            </div>

            <details open={lens === 'operator'} className="group lg:col-span-2 rounded-2xl border border-glass-border/60 px-4 py-3">
                <summary className="cursor-pointer select-none text-[12.5px] font-semibold text-ink-secondary outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 rounded">
                    Technical details
                </summary>
                <dl className="mt-3 grid gap-x-6 gap-y-2 text-[12.5px] sm:grid-cols-[max-content_minmax(0,1fr)]">
                    <dt className="text-ink-secondary">Key</dt><dd className="font-mono text-ink">{s.key}</dd>
                    {s.default.env && (<><dt className="text-ink-secondary">Environment variable</dt><dd className="font-mono text-ink [overflow-wrap:anywhere]">{s.default.env}</dd></>)}
                    <dt className="text-ink-secondary">Built-in default</dt><dd className="text-ink">{formatValue(s, s.default.code)}</dd>
                    <dt className="text-ink-secondary">Takes effect</dt><dd className="text-ink">{s.takesEffect.text}</dd>
                    {s.caps.length > 0 && (<><dt className="text-ink-secondary">Capped by</dt>
                        <dd className="font-mono text-ink [overflow-wrap:anywhere]">
                            {s.caps.map((c) => `${c.deployment ?? c.setting}${c.value != null ? ` (${formatValue(s, c.value)})` : ''}`).join(', ')}
                        </dd></>)}
                    {s.routing && (<><dt className="text-ink-secondary">Readers</dt><dd className="text-ink">A change moves readers to it on their next read.</dd></>)}
                    {s.freshness === 'strict' && (<><dt className="text-ink-secondary">Freshness</dt><dd className="text-ink">Read fresh every time; never cached.</dd></>)}
                    {s.materialized && (<><dt className="text-ink-secondary">Kept with each graph</dt><dd className="font-mono text-ink">{s.materialized}</dd></>)}
                    {legacy.length > 0 && (<><dt className="text-ink-secondary">Stored before</dt><dd className="font-mono text-ink">{legacy.join(' · ')}</dd></>)}
                    {g.evidence && (<><dt className="text-ink-secondary">Evidence</dt><dd className="leading-relaxed text-ink">{g.evidence}</dd></>)}
                    <dt className="text-ink-secondary">Guide</dt>
                    <dd>
                        <a href={`/guide/${s.docs}`} className="inline-flex items-center gap-1 font-medium text-indigo-700 hover:underline dark:text-indigo-300">
                            <BookOpen aria-hidden className="w-3.5 h-3.5" /> Read the guide
                        </a>
                    </dd>
                </dl>
            </details>
        </div>
    )
}
