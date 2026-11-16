/**
 * "Start from a profile": a few values that go together ("Fastest reads", "Least memory"), staged
 * in one go and saved through the same review.
 *
 * The picker is the kit's `ProfilePicker` (`components/settings/ProfilePicker.tsx`), loaded the
 * first time it opens. Until the kit has one, or while the registry names no profiles, this draws
 * nothing — the slot is `import.meta.glob`, which finds no module rather than failing the build.
 */
import { lazy, Suspense, useState, type ComponentType } from 'react'
import { ArrowRight, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Drawer } from '@/components/ui/Drawer'
import { SkeletonText } from '@/components/ui/Skeleton'
import type { Editor, ResolvedValues, Scope, SettingValue } from '@/components/settings'
import type { SettingsProfile } from '@/services/settingsService'

/** What the page hands the picker. */
export interface ProfilePickerProps {
    profiles: SettingsProfile[]
    scope: Scope
    editor: Editor | null
    resolved: ResolvedValues
    /** Stages one key; called once per key the profile sets here. */
    onStage: (key: string, value: SettingValue | null) => void
    onClose: () => void
}

const found = import.meta.glob<{ ProfilePicker: ComponentType<ProfilePickerProps> }>('/src/components/settings/ProfilePicker.tsx')
const load = Object.values(found)[0]
const ProfilePicker = load ? lazy(() => load().then((m) => ({ default: m.ProfilePicker }))) : null

export function ProfileEntry({ profiles, ...pass }: Omit<ProfilePickerProps, 'onClose' | 'profiles'> & { profiles?: SettingsProfile[] }) {
    const [open, setOpen] = useState(false)
    if (!ProfilePicker || !profiles?.length) return null
    const named = profiles.slice(0, 2).map((p) => p.title)
    return (
        <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-glass-border/50 bg-canvas-elevated px-4 py-3">
                <Sparkles aria-hidden className="w-4 h-4 shrink-0 text-ink-muted" />
                <p className="min-w-0 flex-1 basis-56 text-[13px] text-ink-secondary">
                    <span className="font-semibold text-ink">Start from a profile.</span>{' '}
                    {profiles.length} starting points, like {named.join(' or ')}. A profile stages its values; nothing is saved until you review.
                </p>
                <Button size="sm" rightIcon={ArrowRight} onClick={() => setOpen(true)}>Choose a profile…</Button>
            </div>
            <Drawer open={open} onOpenChange={setOpen} title="Start from a profile" size="lg"
                description="Pick the outcome you want. Its values are staged here, for you to review before anything is saved.">
                <Suspense fallback={<SkeletonText lines={6} />}>
                    <ProfilePicker profiles={profiles} {...pass} onClose={() => setOpen(false)} />
                </Suspense>
            </Drawer>
        </>
    )
}
