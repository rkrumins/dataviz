/**
 * A template manager's answer to "offer this to everyone": approve — it becomes
 * an Organization template the managers look after — or decline, with a note
 * for whoever asked. In the template's drawer and on the Requests tab.
 */
import { useState } from 'react'
import { Building2, Loader2 } from 'lucide-react'
import { PersonChip } from '@/components/ui/PersonChip'
import { useAppNotifications } from '@/components/ui/notifications'
import { useInvalidateLayoutTemplates } from '@/hooks/useLayoutTemplates'
import { timeAgo } from '@/lib/timeAgo'
import { layoutTemplateService, type LayoutTemplate } from '@/services/layoutTemplateService'

export function PromotionDecision({ template, onDone }: { template: LayoutTemplate; onDone?: (stillReadable: boolean) => void }) {
    const { notify } = useAppNotifications()
    const invalidate = useInvalidateLayoutTemplates()
    const [note, setNote] = useState('')
    const [busy, setBusy] = useState<'approve' | 'decline' | null>(null)
    const request = template.promotionRequest!
    const answer = async (approve: boolean) => {
        setBusy(approve ? 'approve' : 'decline')
        try {
            await layoutTemplateService.answerPromotion(template.id, approve, note.trim() || null)
            notify('success', approve ? `"${template.name}" is now offered to everyone` : `Declined — "${template.name}" stays as it was`)
            // Before the library refetches: a declined template is no longer
            // theirs to read, and a drawer still open on it would say it vanished.
            onDone?.(approve)
            void invalidate()
        } catch (err) {
            notify('error', (err as Error).message)
        } finally {
            setBusy(null)
        }
    }
    return (
        <section className="rounded-2xl border border-sky-500/30 bg-sky-500/[0.05] p-4">
            <h3 className="text-sm font-semibold text-ink flex items-center gap-1.5">
                <Building2 className="w-4 h-4 text-sky-600" /> Offer it to everyone?
            </h3>
            <p className="text-xs text-ink-muted mt-1 flex flex-wrap items-center gap-1">
                {request.requestedBy ? <PersonChip id={request.requestedBy} size="xs" link={false} /> : 'Its owner'}
                asked {timeAgo(request.requestedAt)}. Approving makes it an Organization template that template managers look after.
            </p>
            {request.note && <blockquote className="mt-2 border-l-2 border-sky-500/40 pl-3 text-sm text-ink-secondary">{request.note}</blockquote>}
            <textarea
                value={note}
                maxLength={500}
                rows={2}
                onChange={e => setNote(e.target.value)}
                placeholder="A note for them (optional)"
                aria-label="A note for whoever asked"
                className="input border-slate-200 dark:border-slate-700 mt-3 w-full py-2 bg-glass-base/40 resize-none text-sm"
            />
            <div className="flex gap-2 mt-2">
                <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void answer(true)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-sky-600 text-white disabled:opacity-50"
                >
                    {busy === 'approve' && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Approve
                </button>
                <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void answer(false)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-semibold border border-slate-200 dark:border-slate-700 text-ink-secondary hover:text-ink disabled:opacity-50"
                >
                    {busy === 'decline' && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Decline
                </button>
            </div>
        </section>
    )
}
