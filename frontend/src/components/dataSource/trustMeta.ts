/**
 * How each trust status and sensitivity label looks and what it means, in one place: the
 * badges, the status form and the guide all say the same thing.
 */
import { BadgeCheck, Building2, CircleOff, Globe, Hourglass, Lock, LockKeyhole } from 'lucide-react'
import type { Classification, TrustStatus } from '@/services/dataSourceMetadataService'

type Glyph = React.ComponentType<{ className?: string }>

export const TRUST_META: Record<TrustStatus, { icon: Glyph; pill: string; tip: string; detail: string }> = {
    certified: {
        icon: BadgeCheck,
        pill: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25',
        tip: 'Certified — fit to rely on',
        detail: 'Its Owner, a Steward or a workspace admin checked it and vouches for it.',
    },
    in_review: {
        icon: Hourglass,
        pill: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25',
        tip: 'In review — being checked',
        detail: 'Use it with care until its Owner or Stewards certify it.',
    },
    deprecated: {
        icon: CircleOff,
        pill: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/25',
        tip: 'Deprecated — on its way out',
        detail: 'Build nothing new on it. Its note says what to use instead.',
    },
}

export const CLASSIFICATION_META: Record<Classification, { icon: Glyph; glyph: string; tip: string; detail: string }> = {
    public: {
        icon: Globe, glyph: 'text-sky-500',
        tip: 'Public — fine to share outside the company',
        detail: 'A sensitivity label, set by its Owner, Stewards or the workspace’s admins.',
    },
    internal: {
        icon: Building2, glyph: 'text-indigo-500',
        tip: 'Internal — for people inside the company',
        detail: 'A sensitivity label, set by its Owner, Stewards or the workspace’s admins.',
    },
    confidential: {
        icon: Lock, glyph: 'text-orange-500',
        tip: 'Confidential — share only with the teams that need it',
        detail: 'A sensitivity label, set by its Owner, Stewards or the workspace’s admins.',
    },
    restricted: {
        icon: LockKeyhole, glyph: 'text-red-500',
        tip: 'Restricted — the most sensitive data; only named people should see it',
        detail: 'A sensitivity label. It is not the admin’s “restricted publishing” setting, '
            + 'which decides whether views on this source need approval to publish.',
    },
}
