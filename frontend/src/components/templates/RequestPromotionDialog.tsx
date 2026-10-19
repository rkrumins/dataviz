/**
 * "Offer to everyone" — ask the template managers to make a team's template an
 * Organization template. They hear about it, may read it until they answer, and
 * look after it once approved; whoever asked hears the answer either way.
 */
import { useState } from 'react'
import { Building2, Loader2, X } from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { useAppNotifications } from '@/components/ui/notifications'
import { useInvalidateLayoutTemplates } from '@/hooks/useLayoutTemplates'
import { useModalA11y } from '@/hooks/useModalA11y'
import { layoutTemplateService, type LayoutTemplate } from '@/services/layoutTemplateService'
import { useBrand } from '@/store/branding'

export function RequestPromotionDialog({ template, onClose }: { template: LayoutTemplate; onClose: () => void }) {
    const ref = useModalA11y(true, onClose)
    const { appName } = useBrand()
    const { notify } = useAppNotifications()
    const invalidate = useInvalidateLayoutTemplates()
    const [note, setNote] = useState('')
    const [sending, setSending] = useState(false)

    const send = async () => {
        setSending(true)
        try {
            await layoutTemplateService.requestPromotion(template.id, note.trim() || null)
            notify('success', `Asked for "${template.name}" to be offered to everyone. You'll hear the answer in your inbox.`)
            void invalidate()
            onClose()
        } catch (err) {
            notify('error', (err as Error).message)
        } finally {
            setSending(false)
        }
    }

    return (
        <>
            <Backdrop open onClick={onClose} zClassName="z-[60]" className="bg-black/50" />
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 pointer-events-none">
                <div
                    ref={ref}
                    role="dialog"
                    aria-modal="true"
                    aria-label={`Offer ${template.name} to everyone`}
                    tabIndex={-1}
                    className="pointer-events-auto w-full max-w-lg rounded-2xl bg-canvas-elevated border border-slate-200 dark:border-slate-700 shadow-2xl focus:outline-none"
                >
                    <div className="h-1 rounded-t-2xl bg-gradient-to-r from-sky-500 via-indigo-500 to-violet-500" />
                    <header className="flex items-start gap-3 px-6 pt-5 pb-3">
                        <div className="w-10 h-10 rounded-xl bg-sky-500/10 border border-sky-500/20 text-sky-600 flex items-center justify-center shrink-0">
                            <Building2 className="w-5 h-5" aria-hidden />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h2 className="text-lg font-bold text-ink">Offer “{template.name}” to everyone?</h2>
                            <p className="text-xs text-ink-muted mt-0.5">
                                Your template managers decide. Approved, it becomes an Organization template for everyone
                                in {appName} — and from then on the managers look after it.
                            </p>
                        </div>
                        <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5">
                            <X className="w-4 h-4" />
                        </button>
                    </header>
                    <div className="px-6 pb-2">
                        <label className="block">
                            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Why it would help (optional)</span>
                            <textarea
                                autoFocus
                                value={note}
                                maxLength={500}
                                rows={3}
                                onChange={e => setNote(e.target.value)}
                                placeholder="Three teams already copy it for their pipelines"
                                className="input border-slate-200 dark:border-slate-700 mt-1.5 w-full py-2 bg-glass-base/40 resize-none text-sm"
                            />
                        </label>
                    </div>
                    <footer className="flex items-center justify-end gap-3 px-6 py-4">
                        <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5">
                            Cancel
                        </button>
                        <button
                            type="button"
                            disabled={sending}
                            onClick={() => void send()}
                            className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold bg-gradient-to-r from-sky-500 to-indigo-600 text-white shadow-md disabled:opacity-50"
                        >
                            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Building2 className="w-4 h-4" />}
                            Ask the template managers
                        </button>
                    </footer>
                </div>
            </div>
        </>
    )
}
