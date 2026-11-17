/**
 * "Start from a profile": a few values that go together ("Fastest reads", "Least memory"), staged
 * in one go and saved through the same review. A card that says so (`variant="card"`), or a button
 * among a page's actions (`variant="button"`, the settings page's hero), each opening the picker in
 * a drawer of its own; or a card that opens it in place, under itself (`variant="inline"`, a graph's
 * settings drawer: never a drawer stacked on a drawer).
 *
 * The picker is the kit's `ProfilePicker` (`components/settings/ProfilePicker.tsx`), loaded the
 * first time it opens. Until the kit has one, or while the registry names no profiles, this draws
 * nothing — the slot is `import.meta.glob`, which finds no module rather than failing the build.
 */
import { lazy, Suspense, useEffect, useId, useRef, useState, type ComponentType } from 'react'
import { ArrowRight, ChevronUp, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Drawer } from '@/components/ui/Drawer'
import { SkeletonText } from '@/components/ui/Skeleton'
import { SCOPE_HERE, type Editor, type Lens, type ResolvedValues, type Scope, type SettingValue } from '@/components/settings'
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
    /** The app's view, passed through: Business lists the business profiles first. */
    lens?: Lens
}

const found = import.meta.glob<{ ProfilePicker: ComponentType<ProfilePickerProps> }>('/src/components/settings/ProfilePicker.tsx')
const load = Object.values(found)[0]
const ProfilePicker = load ? lazy(() => load().then((m) => ({ default: m.ProfilePicker }))) : null

export function ProfileEntry({ profiles, variant = 'card', primary = true, className, ...pass }: Omit<ProfilePickerProps, 'onClose' | 'profiles'> & {
    profiles?: SettingsProfile[]
    variant?: 'card' | 'button' | 'inline'
    /** The button is the page's first step (filled); false beside a first step of the page's own. */
    primary?: boolean
    className?: string
}) {
    const [open, setOpen] = useState(false)
    // In place, focus follows the picker: into it as it opens, back to its button as it closes.
    const panelId = useId()
    const toggle = useRef<HTMLButtonElement>(null)
    const panel = useRef<HTMLDivElement>(null)
    const shown = useRef(false)
    useEffect(() => {
        if (variant !== 'inline' || open === shown.current) return
        shown.current = open
        if (open) panel.current?.focus()
        else toggle.current?.focus()
    }, [variant, open])
    if (!ProfilePicker || !profiles?.length) return null
    const named = profiles.slice(0, 2).map((p) => p.title)
    if (variant === 'inline') {
        return (
            // Clipped: the picker's footer is the card's bottom edge here, not one pinned over the drawer's.
            <div className={cn('overflow-hidden rounded-2xl border border-glass-border/50 bg-canvas-elevated', className)}>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                    <Sparkles aria-hidden className="w-4 h-4 shrink-0 text-violet-600 dark:text-violet-300" />
                    <p className="min-w-0 flex-1 basis-56 text-[13px] text-ink-secondary">
                        <span className="font-semibold text-ink">Start from a profile.</span>{' '}
                        {profiles.length} starting points for {SCOPE_HERE[pass.scope]}, like {named.join(' or ')}. Only what you may set here is staged,
                        and nothing is saved until you review.
                    </p>
                    {/* Its edge a divider's: the plain glass edge is white, invisible on the card. */}
                    <Button ref={toggle} size="sm" rightIcon={open ? ChevronUp : ArrowRight} aria-expanded={open} aria-controls={panelId}
                        onClick={() => setOpen((o) => !o)} className="border-glass-border/80">
                        {open ? 'Close the profiles' : 'Choose a profile…'}
                    </Button>
                </div>
                {open && (
                    <div ref={panel} id={panelId} role="region" aria-label="Start from a profile" tabIndex={-1}
                        className="border-t border-glass-border/50 px-5 py-5 outline-none sm:px-6">
                        <Suspense fallback={<SkeletonText lines={6} />}>
                            <ProfilePicker profiles={profiles} {...pass} onClose={() => setOpen(false)} />
                        </Suspense>
                    </div>
                )}
            </div>
        )
    }
    return (
        <>
            {variant === 'button' ? (
                primary ? (
                    // The page's first step: filled, in the app's indigo-to-violet.
                    <Button variant="primary" leftIcon={Sparkles} onClick={() => setOpen(true)}
                        className={cn('bg-indigo-600 bg-gradient-to-r from-indigo-600 to-violet-600 shadow-indigo-600/25', className)}>
                        Start from a profile…
                    </Button>
                ) : (
                    // Its edge a divider's: the plain glass edge is white, invisible on the hero's card.
                    <Button leftIcon={Sparkles} onClick={() => setOpen(true)} className={cn('border-glass-border/80', className)}>
                        Start from a profile…
                    </Button>
                )
            ) : (
                <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-glass-border/50 bg-canvas-elevated px-4 py-3', className)}>
                    <Sparkles aria-hidden className="w-4 h-4 shrink-0 text-ink-muted" />
                    <p className="min-w-0 flex-1 basis-56 text-[13px] text-ink-secondary">
                        <span className="font-semibold text-ink">Start from a profile.</span>{' '}
                        {profiles.length} starting points, like {named.join(' or ')}. A profile stages its values; nothing is saved until you review.
                    </p>
                    <Button size="sm" rightIcon={ArrowRight} onClick={() => setOpen(true)}>Choose a profile…</Button>
                </div>
            )}
            <Drawer open={open} onOpenChange={setOpen} title="Start from a profile" size="lg"
                description="Pick the outcome you want. Its values are staged here, for you to review before anything is saved.">
                <Suspense fallback={<SkeletonText lines={6} />}>
                    <ProfilePicker profiles={profiles} {...pass} onClose={() => setOpen(false)} />
                </Suspense>
            </Drawer>
        </>
    )
}
