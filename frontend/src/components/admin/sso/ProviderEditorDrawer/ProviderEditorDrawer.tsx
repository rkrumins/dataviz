/**
 * Editing a connection, as a place you go rather than a page that grows.
 *
 * The pencil used to expand a ~1000px form *under the card*, pushing the
 * rest of the list off screen — identity, protocol settings, login-page
 * appearance, email domains and the entire claim mapper, one flat run with
 * no grouping and no way to see where you were.
 *
 * Here it is a drawer with five sections, because those are the five
 * genuinely different questions: who is this, how do we reach it, what do
 * its claims mean, how does it look on the login page, and how do we get
 * rid of it. The mapping section is also the only one that needs real
 * width, which is the other reason this could not stay inline.
 *
 * Follows `RoleEditorDrawer` for the dirty/save idiom, and `WizardShell`'s
 * visual language so the edit and connect surfaces read as one product.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
    AlertCircle, Fingerprint, Loader2, Palette, Plug, Save,
    Trash2, Waypoints, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import { DocsLink } from '@/components/help/DocsLink'
import { useToast } from '@/components/ui/toast'
import type { IdpProvider } from '@/services/ssoAdminService'
import { AssurancePill } from '@/components/admin/AssurancePill'
import { logoFor } from '../IdpLogos'
import { useProviderEditor, type EditorSection } from './useProviderEditor'
import { IdentitySection } from './sections/IdentitySection'
import { ConnectionSection } from './sections/ConnectionSection'
import { MappingSection } from './sections/MappingSection'
import { AppearanceSection } from './sections/AppearanceSection'
import { DangerSection } from './sections/DangerSection'

const SECTIONS: { id: EditorSection; label: string; icon: typeof Plug; blurb: string }[] = [
    { id: 'identity', label: 'Identity', icon: Fingerprint, blurb: 'Name and protocol' },
    { id: 'connection', label: 'Connection', icon: Plug, blurb: 'Endpoints and credentials' },
    { id: 'mapping', label: 'Claim mapping', icon: Waypoints, blurb: 'Their fields to ours' },
    { id: 'appearance', label: 'Login page', icon: Palette, blurb: 'How people see it' },
    { id: 'danger', label: 'Danger zone', icon: Trash2, blurb: 'Delete this connection' },
]

export function ProviderEditorDrawer({
    provider, onClose, onSaved, onDeleted,
}: {
    provider: IdpProvider
    onClose: () => void
    onSaved: () => void
    onDeleted: () => void
}) {
    const ed = useProviderEditor(provider)
    const { showToast } = useToast()
    const titleId = useId()
    const panel = useRef<HTMLDivElement>(null)
    const [confirmDiscard, setConfirmDiscard] = useState(false)

    useEffect(() => { panel.current?.focus() }, [])

    /** Closing with unsaved edits asks first. The old form just threw them
     *  away, which for a claim mapping is twenty minutes of work. */
    function requestClose() {
        if (ed.dirty) { setConfirmDiscard(true); return }
        onClose()
    }

    useEffect(() => {
        function esc(e: KeyboardEvent) {
            if (e.key === 'Escape') requestClose()
        }
        document.addEventListener('keydown', esc)
        return () => document.removeEventListener('keydown', esc)
    })

    async function submit() {
        if (await ed.save()) {
            showToast('success', `Saved ${provider.displayName || provider.slug}`)
            onSaved()
            onClose()
        }
    }

    const Logo = logoFor(provider.kind, provider.kind)
    const draft = provider.lifecycle === 'draft'

    return (
        <>
            <Backdrop open onClick={requestClose} zClassName="z-50" className="bg-black/60" />
            <motion.div
                ref={panel}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                initial={{ x: 40, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                transition={{ duration: 0.14, ease: 'easeOut' }}
                className="fixed inset-y-0 right-0 z-[51] w-full max-w-[940px] bg-canvas-elevated shadow-2xl flex flex-col focus:outline-none"
            >
                {/* Header — identity and state, so the drawer never leaves
                    you wondering which connection you are editing. */}
                <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-glass-border bg-gradient-to-r from-black/[0.02] to-transparent dark:from-white/[0.02]">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-xl bg-black/[0.04] dark:bg-white/[0.06] flex items-center justify-center shrink-0">
                            <Logo className="w-6 h-6" />
                        </div>
                        <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                                <h2 id={titleId} className="text-lg font-bold text-ink truncate">
                                    {ed.draft.displayName || provider.slug}
                                </h2>
                                <span className={cn(
                                    'px-1.5 py-0.5 rounded text-[10px] font-medium',
                                    draft
                                        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                                        : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
                                )}>
                                    {draft ? 'Draft' : 'Live'}
                                </span>
                                <AssurancePill
                                    level={provider.assurance}
                                    reason={provider.assuranceReason}
                                />
                            </div>
                            <p className="text-xs text-ink-muted font-mono truncate">
                                {provider.slug}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                        <DocsLink slug="sso-setup" variant="icon" />
                        <button
                            onClick={requestClose}
                            aria-label="Close"
                            className="p-2 rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10"
                        >
                            <X className="w-4 h-4 text-ink-muted" />
                        </button>
                    </div>
                </div>

                <div className="flex-1 flex min-h-0">
                    {/* Section rail */}
                    <nav
                        aria-label="Sections"
                        className="w-56 shrink-0 border-r border-glass-border p-3 space-y-1 overflow-y-auto bg-black/[0.015] dark:bg-white/[0.015]"
                    >
                        {SECTIONS.map(s => {
                            const on = ed.section === s.id
                            const problems = ed.sectionErrors[s.id]
                            return (
                                <button
                                    key={s.id}
                                    onClick={() => ed.setSection(s.id)}
                                    aria-current={on ? 'true' : undefined}
                                    // The blurb is supplementary; without
                                    // this "Danger zone — delete this
                                    // connection" answers to "Connection".
                                    aria-label={s.label}
                                    className={cn(
                                        'w-full flex items-start gap-2.5 px-3 py-2 rounded-xl text-left transition-colors duration-150',
                                        on
                                            ? 'bg-indigo-500/[0.10] text-ink'
                                            : 'text-ink-muted hover:bg-black/[0.04] dark:hover:bg-white/[0.05]',
                                    )}
                                >
                                    <s.icon className={cn(
                                        'w-4 h-4 mt-0.5 shrink-0',
                                        on ? 'text-indigo-500' : '',
                                        s.id === 'danger' && 'text-red-500/70',
                                    )} />
                                    <span className="min-w-0 flex-1">
                                        <span className={cn(
                                            'block text-xs font-semibold',
                                            on ? 'text-ink' : '',
                                        )}>
                                            {s.label}
                                        </span>
                                        <span className="block text-[10px] text-ink-muted truncate">
                                            {s.blurb}
                                        </span>
                                    </span>
                                    {problems ? (
                                        <AlertCircle
                                            aria-label={`${problems} problem${problems === 1 ? '' : 's'}`}
                                            className="w-3.5 h-3.5 mt-0.5 shrink-0 text-red-500"
                                        />
                                    ) : null}
                                </button>
                            )
                        })}
                    </nav>

                    {/* Section body */}
                    <div className="flex-1 min-w-0 overflow-y-auto p-6">
                        {ed.section === 'identity' && (
                            <IdentitySection provider={provider} ed={ed} />
                        )}
                        {ed.section === 'connection' && (
                            <ConnectionSection provider={provider} ed={ed} />
                        )}
                        {ed.section === 'mapping' && (
                            <MappingSection provider={provider} ed={ed} />
                        )}
                        {ed.section === 'appearance' && (
                            <AppearanceSection provider={provider} ed={ed} />
                        )}
                        {ed.section === 'danger' && (
                            <DangerSection provider={provider} onDeleted={onDeleted} />
                        )}
                    </div>
                </div>

                {/* Footer — says what is unsaved, not just that something is. */}
                <div className="flex items-center justify-between gap-4 px-6 py-4 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02]">
                    <div className="min-w-0 text-xs">
                        {ed.saveError ? (
                            <span className="flex items-start gap-1.5 text-red-500">
                                <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0" />
                                {ed.saveError}
                            </span>
                        ) : ed.dirty ? (
                            <span className="flex items-center gap-1.5 text-ink-muted">
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                                {ed.changedCount} unsaved change
                                {ed.changedCount === 1 ? '' : 's'}
                            </span>
                        ) : (
                            <span className="text-ink-muted">No changes</span>
                        )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <button
                            onClick={requestClose}
                            className="px-4 py-2 rounded-xl text-sm font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={() => { void submit() }}
                            disabled={!ed.dirty || !ed.valid || ed.saving}
                            className={cn(
                                'flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium transition-colors duration-150',
                                ed.dirty && ed.valid && !ed.saving
                                    ? 'bg-gradient-to-r from-indigo-500 to-violet-600 text-white hover:brightness-110 shadow-md'
                                    : 'bg-black/5 dark:bg-white/5 text-ink-muted cursor-not-allowed',
                            )}
                        >
                            {ed.saving
                                ? <><Loader2 className="w-4 h-4 animate-spin" />Saving…</>
                                : <><Save className="w-4 h-4" />Save changes</>}
                        </button>
                    </div>
                </div>
            </motion.div>

            {confirmDiscard && (
                <DiscardConfirm
                    count={ed.changedCount}
                    onKeep={() => setConfirmDiscard(false)}
                    onDiscard={onClose}
                />
            )}
        </>
    )
}

function DiscardConfirm({
    count, onKeep, onDiscard,
}: {
    count: number
    onKeep: () => void
    onDiscard: () => void
}) {
    return (
        <>
            <Backdrop open zClassName="z-[60]" className="bg-black/50" />
            <div className="fixed inset-0 z-[61] flex items-center justify-center p-4">
                <div
                    role="alertdialog"
                    aria-modal="true"
                    className="w-full max-w-sm rounded-2xl bg-canvas-elevated shadow-xl p-5"
                >
                    <h3 className="text-base font-bold text-ink">
                        Discard {count} unsaved change{count === 1 ? '' : 's'}?
                    </h3>
                    <p className="mt-1.5 text-xs text-ink-muted">
                        Closing now throws them away. Nothing has been written
                        to this connection.
                    </p>
                    <div className="mt-4 flex justify-end gap-2">
                        <button
                            onClick={onKeep}
                            className="px-4 py-2 rounded-xl text-sm font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5"
                        >
                            Keep editing
                        </button>
                        <button
                            onClick={onDiscard}
                            className="px-4 py-2 rounded-xl text-sm font-medium bg-red-500 text-white hover:bg-red-600"
                        >
                            Discard
                        </button>
                    </div>
                </div>
            </div>
        </>
    )
}

export type ProviderEditor = ReturnType<typeof useProviderEditor>
