/**
 * How people meet this connection on the sign-in page.
 *
 * The Enabled caption used to read "when on, this provider appears on the
 * login page for everyone", which stopped being true when the draft/live
 * lifecycle landed: a draft appears to nobody however this is set. Getting
 * that wrong is not cosmetic — an operator who believes a draft is live
 * will not publish it, and one who believes a live provider is hidden will
 * leave it serving sign-ins.
 */
import { AlertCircle, Eye } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { IdpProvider } from '@/services/ssoAdminService'
import { Field, FieldGrid, TextField } from '../../settings/ui'
import { SectionHeader } from './SectionHeader'
import type { ProviderEditor } from '../ProviderEditorDrawer'

export function AppearanceSection({
    provider, ed,
}: {
    provider: IdpProvider
    ed: ProviderEditor
}) {
    const isDraft = provider.lifecycle === 'draft'
    const label = ed.draft.buttonLabel || ed.draft.displayName || provider.slug

    return (
        <div className="space-y-5 max-w-2xl">
            <SectionHeader title="Login page">
                What someone sees before they have signed in, and which
                addresses route straight here.
            </SectionHeader>

            {/* Say what is actually true right now, rather than making the
                operator infer it from two independent switches. */}
            <div className={cn(
                'flex items-start gap-2.5 p-3 rounded-xl border-2',
                isDraft
                    ? 'border-amber-400/40 bg-amber-500/[0.07]'
                    : ed.draft.enabled
                        ? 'border-emerald-400/40 bg-emerald-500/[0.06]'
                        : 'border-black/[0.10] dark:border-white/[0.12]',
            )}>
                <Eye className="w-4 h-4 mt-0.5 shrink-0 text-ink-muted" />
                <p className="text-xs text-ink leading-relaxed">
                    {isDraft ? (
                        <>This connection is a <strong>draft</strong> — nobody
                        can see it on the sign-in page, whatever the switch
                        below says. Rehearse a sign-in, then publish it from
                        its card.</>
                    ) : ed.draft.enabled ? (
                        <>Live and on: everyone reaching the sign-in page sees{' '}
                        <strong>{label}</strong>.</>
                    ) : (
                        <>Live but switched off: the configuration is kept and
                        sign-ins through it are refused.</>
                    )}
                </p>
            </div>

            <label className="flex items-start gap-2.5 p-3 rounded-xl border-2 border-black/[0.10] dark:border-white/[0.12] cursor-pointer">
                <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={ed.draft.enabled}
                    onChange={e => ed.set('enabled', e.target.checked)}
                />
                <span>
                    <span className="block text-xs font-semibold text-ink">Enabled</span>
                    <span className="block text-[11px] text-ink-muted">
                        The operational switch — turn it off to stop sign-ins
                        during an incident without losing the configuration.
                    </span>
                </span>
            </label>

            <FieldGrid>
                <Field
                    label={<>Button label <span className="font-normal text-ink-muted">(optional)</span></>}
                    hint="Defaults to the display name."
                >
                    <TextField
                        mono={false}
                        value={ed.draft.buttonLabel}
                        onChange={e => ed.set('buttonLabel', e.target.value)}
                        placeholder={ed.draft.displayName || 'Sign in with…'}
                    />
                </Field>
                <Field label="Priority" hint="Login-page order, lowest first.">
                    <TextField
                        type="number"
                        mono={false}
                        min={0}
                        max={10000}
                        value={String(ed.draft.priority)}
                        onChange={e => ed.set('priority', Number(e.target.value))}
                    />
                </Field>
            </FieldGrid>

            <Field
                label={<>Button icon <span className="font-normal text-ink-muted">(optional)</span></>}
                hint="A data: URI or a path on this server."
            >
                <TextField
                    value={ed.draft.buttonIcon}
                    onChange={e => ed.set('buttonIcon', e.target.value)}
                    invalid={Boolean(ed.errors.buttonIcon)}
                    placeholder="data:image/svg+xml;base64,… or /static/idp/entra.svg"
                />
                {ed.errors.buttonIcon && (
                    <span className="mt-1 flex items-start gap-1 text-[11px] text-red-500">
                        <AlertCircle className="w-3 h-3 mt-px shrink-0" />
                        {ed.errors.buttonIcon}
                    </span>
                )}
            </Field>

            <Field
                label={<>Email domains <span className="font-normal text-ink-muted">(optional)</span></>}
                hint="Routes these domains straight here when email-first sign-in is on (Settings tab). Ignored otherwise."
            >
                <TextField
                    value={ed.draft.emailDomains}
                    onChange={e => ed.set('emailDomains', e.target.value)}
                    placeholder="corp.example.com, subsidiary.example"
                />
            </Field>
        </div>
    )
}
