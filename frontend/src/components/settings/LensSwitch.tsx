/**
 * LensSwitch — Business or Operator: the same settings, framed for who is deciding.
 *
 * Business asks each setting's question and shows outcome cards; Operator adds the env var, when a
 * change takes effect, caps and evidence. Both show every setting the viewer may change. The page
 * holds the lens (`useLens`, which opens on the app's business / technical view).
 */
import { Briefcase, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Segmented } from '@/components/ui/Segmented'
import type { Lens } from './lens'

const SAYS: Record<Lens, string> = {
    business: 'Plain questions, outcomes and recommendations.',
    operator: 'Full detail: env vars, timing, caps and evidence.',
}

export function LensSwitch({ value, onChange, className }: { value: Lens; onChange: (lens: Lens) => void; className?: string }) {
    return (
        <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5', className)}>
            <Segmented
                label="Show settings for"
                size="md"
                value={value}
                onChange={onChange}
                options={[
                    { value: 'business', label: 'Business', icon: Briefcase },
                    { value: 'operator', label: 'Operator', icon: Wrench },
                ]}
            />
            <p className="text-xs text-ink-muted">{SAYS[value]}</p>
        </div>
    )
}
