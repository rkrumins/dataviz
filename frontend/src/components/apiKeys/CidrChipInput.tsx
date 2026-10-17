/**
 * The networks a key may be used from, one chip each.
 *
 * An entry becomes a chip on Enter, a comma, a space or leaving the field —
 * and a pasted list becomes several. A mistyped entry stays, marked, with
 * what is wrong with it underneath: deleting someone's input because it did
 * not parse makes them type it again and still not know why.
 *
 * "Add this address" offers the one the server sees this browser at, which
 * is usually what a person limiting a key to "here" means.
 */
import { useState } from 'react'
import { AlertCircle, Network, Plus, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { MAX_CIDRS, cidrProblem, parseCidrs } from './apiKeyFormat'

export function CidrChipInput({ value, onChange, clientIp }: {
    value: string[]
    onChange: (cidrs: string[]) => void
    clientIp: string | null
}) {
    const [text, setText] = useState('')

    const add = (entries: string[]) => {
        const next = [...value]
        for (const e of entries) if (!next.includes(e)) next.push(e)
        onChange(next)
    }
    const commit = () => {
        const entries = parseCidrs(text)
        if (entries.length > 0) add(entries)
        setText('')
    }
    const bad = value.map((c) => ({ entry: c, problem: cidrProblem(c) })).filter((b) => b.problem)
    const full = value.length >= MAX_CIDRS

    return (
        <div>
            <div className={cn(
                'flex flex-wrap items-center gap-1.5 min-h-[52px] px-3 py-2 rounded-xl border-2 bg-canvas-elevated transition-colors duration-150',
                'focus-within:border-indigo-500 focus-within:ring-4 focus-within:ring-indigo-500/10',
                bad.length > 0 ? 'border-rose-400 dark:border-rose-500/70' : 'border-black/[0.10] dark:border-white/[0.12]',
            )}>
                {value.map((c) => {
                    const wrong = Boolean(cidrProblem(c))
                    return (
                        <span
                            key={c}
                            className={cn(
                                'inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-lg text-xs font-mono font-medium border',
                                wrong
                                    ? 'bg-rose-500/10 border-rose-500/30 text-rose-700 dark:text-rose-300'
                                    : 'bg-indigo-500/[0.07] border-indigo-500/20 text-indigo-700 dark:text-indigo-300',
                            )}
                        >
                            {wrong ? <AlertCircle className="w-3 h-3" aria-hidden /> : <Network className="w-3 h-3" aria-hidden />}
                            {c}
                            <button
                                type="button"
                                onClick={() => onChange(value.filter((x) => x !== c))}
                                aria-label={`Remove ${c}`}
                                className="p-0.5 rounded hover:bg-black/[0.06] dark:hover:bg-white/[0.10]"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </span>
                    )
                })}
                <input
                    aria-label="Allowed networks"
                    value={text}
                    disabled={full}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
                            e.preventDefault()
                            commit()
                        } else if (e.key === 'Backspace' && !text && value.length > 0) {
                            onChange(value.slice(0, -1))
                        }
                    }}
                    onPaste={(e) => {
                        const pasted = parseCidrs(e.clipboardData.getData('text'))
                        if (pasted.length > 1) {
                            e.preventDefault()
                            add(pasted)
                        }
                    }}
                    onBlur={commit}
                    placeholder={value.length === 0 ? 'Any network — or type an address such as 203.0.113.0/24' : full ? '' : 'Add another'}
                    className="flex-1 min-w-[10rem] bg-transparent py-1 text-sm font-mono text-ink placeholder:font-sans placeholder:text-ink-muted outline-none"
                />
            </div>

            {bad.length > 0 && (
                <ul className="mt-2 space-y-1" role="alert">
                    {bad.map((b) => (
                        <li key={b.entry} className="flex items-start gap-1.5 text-xs text-rose-600 dark:text-rose-400">
                            <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
                            <span><span className="font-mono">{b.entry}</span> {b.problem} — for example 203.0.113.0/24.</span>
                        </li>
                    ))}
                </ul>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {clientIp && !value.includes(clientIp) && !full && (
                    <button
                        type="button"
                        onClick={() => add([clientIp])}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-500/10 hover:bg-indigo-500/15 transition-colors"
                    >
                        <Plus className="w-3.5 h-3.5" aria-hidden />
                        Add this address ({clientIp})
                    </button>
                )}
                <span className="text-[11px] text-ink-muted">
                    {value.length} of {MAX_CIDRS}
                </span>
            </div>
        </div>
    )
}
