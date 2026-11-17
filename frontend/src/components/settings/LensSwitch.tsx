/**
 * LensSwitch — the app's own Business / Technical switch (`PersonaToggle`), where the settings are,
 * with a line saying what the view changes here. It is the top bar's switch: flipping it here flips
 * the whole app, and every settings surface follows (`useLens`).
 *
 * Each one sits in a layout group of its own, so its thumb never slides into another toggle's: the
 * top bar's, or the page's behind a drawer that shows one too.
 */
import { useId } from 'react'
import { LayoutGroup } from 'framer-motion'
import { cn } from '@/lib/utils'
import { PersonaToggle } from '@/components/persona/PersonaToggle'
import { useLens, type Lens } from './lens'

const SAYS: Record<Lens, string> = {
    business: 'Plain questions and outcomes.',
    operator: 'Every detail: env vars, timing, caps, evidence and ids.',
}

export function LensSwitch({ className }: { className?: string }) {
    const [lens] = useLens()
    const group = useId()
    return (
        <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5', className)}>
            <LayoutGroup id={`settings-view${group}`}>
                <PersonaToggle />
            </LayoutGroup>
            {/* As wide (and, wrapped, as tall) as the longest line, so flipping the view never moves the switch. */}
            <div className="grid text-xs text-ink-secondary">
                <p className="col-start-1 row-start-1">{SAYS[lens]}</p>
                {Object.values(SAYS).map((says) => <span key={says} aria-hidden className="invisible col-start-1 row-start-1">{says}</span>)}
            </div>
        </div>
    )
}
