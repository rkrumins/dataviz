/**
 * How the assistant behaves: which connection serves which job, which
 * personas are on, what may leave the platform, and the limits per person.
 *
 * Save first says what changes — and, louder, anything that lets more leave
 * the platform — and only a confirmation saves it (the residency policy's
 * preview-then-confirm).
 */
import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, Gauge, MessageSquareText, Plus, ShieldCheck, Workflow, X } from 'lucide-react'
import { Button, IconButton, Skeleton } from '@/components/ui/primitives'
import { DateTime } from '@/components/ui/DateTime'
import { useAppNotifications } from '@/components/ui/notifications'
import { ConfirmDialog } from '@/components/admin/AdminInfrastructure/ConfirmDialog'
import { Field, FieldGrid, SelectField, TextField } from '@/components/admin/sso/settings/ui'
import { SsoCard } from '@/components/admin/sso/ui/SsoCard'
import { ErrorBanner } from '@/components/admin/sso/tabs/ErrorBanner'
import { aiAdminService, AI_ADMIN_KEYS, type AiSettings, type Connection } from '@/services/aiAdminService'
import {
    MAX_PATTERNS, RANGES, draftFromSettings, settingsChanges, settingsErrors, settingsPatch, whatLeaves,
    type SettingsDraft,
} from './assistantSettings'

export function AssistantTab() {
    const settingsQ = useQuery({ queryKey: AI_ADMIN_KEYS.settings, queryFn: aiAdminService.getSettings })
    const connectionsQ = useQuery({ queryKey: AI_ADMIN_KEYS.connections, queryFn: aiAdminService.listConnections })
    if (settingsQ.isLoading) {
        return <div className="space-y-3" aria-label="Loading the settings"><Skeleton className="h-32 w-full" /><Skeleton className="h-48 w-full" /></div>
    }
    if (!settingsQ.data) return <ErrorBanner message={(settingsQ.error as Error | null)?.message ?? 'The settings could not be read.'} />
    // A fresh form after each save: the draft starts from what is saved.
    return <AssistantForm key={settingsQ.data.updatedAt ?? 'never'} settings={settingsQ.data} connections={connectionsQ.data ?? []} />
}

function AssistantForm({ settings, connections }: { settings: AiSettings; connections: Connection[] }) {
    const qc = useQueryClient()
    const { notify } = useAppNotifications()
    const saved = useMemo(() => draftFromSettings(settings), [settings])
    const [d, setD] = useState<SettingsDraft>(saved)
    const [confirming, setConfirming] = useState(false)
    const set = <K extends keyof SettingsDraft>(k: K, v: SettingsDraft[K]) => setD(prev => ({ ...prev, [k]: v }))

    const errors = settingsErrors(d)
    const valid = Object.keys(errors).length === 0
    const changes = settingsChanges(saved, d, connections)
    const widening = changes.filter(c => c.widens)
    const leaves = whatLeaves(d)
    const chatName = connections.find(c => c.id === d.chatConnectionId)?.name

    const save = useMutation({
        mutationFn: () => aiAdminService.saveSettings(settingsPatch(d)),
        onSuccess: next => {
            qc.setQueryData(AI_ADMIN_KEYS.settings, next)
            notify('success', 'Saved the assistant settings')
        },
    })

    // Enabled ones, plus whichever is chosen now even if it was switched off
    // since — a select showing a different value than is saved would lie.
    const choices = (chosen: string) => connections.filter(c => c.enabled || c.id === chosen)

    return (
        <div className="space-y-5">
            <p className="text-[11px] text-ink-muted">
                {settings.updatedBy
                    ? <>Last changed by {settings.updatedBy}{settings.updatedAt && <> · <DateTime at={settings.updatedAt} variant="calendar" /></>}</>
                    : 'Never changed: every value is its default.'}
            </p>

            <SsoCard icon={Workflow} title="Which connection does what" blurb="Only enabled connections can be chosen. Test a connection under Connections to see what it can do.">
                <FieldGrid>
                    <Field label="Chat" hint="Answers every question. With none, the assistant tells people it is not set up yet.">
                        <SelectField value={d.chatConnectionId} onChange={e => set('chatConnectionId', e.target.value)}>
                            <option value="">None — the assistant does not answer</option>
                            {choices(d.chatConnectionId).map(c => <option key={c.id} value={c.id}>{c.name}{c.enabled ? '' : ' (off)'}</option>)}
                        </SelectField>
                    </Field>
                    <Field label="Fast jobs" hint="Titles and other small jobs. Usually a cheaper model.">
                        <SelectField value={d.fastConnectionId} onChange={e => set('fastConnectionId', e.target.value)}>
                            <option value="">The chat connection</option>
                            {choices(d.fastConnectionId).map(c => <option key={c.id} value={c.id}>{c.name}{c.enabled ? '' : ' (off)'}</option>)}
                        </SelectField>
                    </Field>
                    <Field label="Embeddings" hint="Finds guide pages and views by meaning. With none, they are found by their words.">
                        <SelectField value={d.embeddingConnectionId} onChange={e => set('embeddingConnectionId', e.target.value)}>
                            <option value="">None — search by words only</option>
                            {choices(d.embeddingConnectionId).map(c => (
                                <option key={c.id} value={c.id} disabled={!c.models.embedding}>
                                    {c.name}{c.models.embedding ? '' : ' (no embedding model)'}{c.enabled ? '' : ' (off)'}
                                </option>
                            ))}
                        </SelectField>
                    </Field>
                </FieldGrid>
            </SsoCard>

            <SsoCard icon={MessageSquareText} title="Personas" blurb="What people can ask. Turning one off hides it from the assistant panel.">
                <div className="grid gap-3 sm:grid-cols-2">
                    <Toggle checked={d.personaData} onChange={v => set('personaData', v)} label="Ask about data">
                        Questions about lineage and the catalogue: what breaks if this changes, where something is, who owns it. It also drafts searches.
                    </Toggle>
                    <Toggle checked={d.personaHelp} onChange={v => set('personaHelp', v)} label="Help & docs">
                        How-to questions, answered from this product’s guide with links to the pages used.
                    </Toggle>
                </div>
            </SsoCard>

            <SsoCard
                icon={ShieldCheck}
                title="Data sharing"
                blurb={<>What the assistant may send to {chatName ? <strong className="text-ink">{chatName}</strong> : 'the chat connection'} to answer a question. Less shared means less precise answers, never wrong access: people only get answers about what they can open.</>}
            >
                <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
                    <div className="space-y-4">
                        <Toggle checked={d.sendDescriptions} onChange={v => set('sendDescriptions', v)} label="Send descriptions">
                            The descriptions written on assets and views. They are often what makes “customer data” findable.
                        </Toggle>
                        <Toggle checked={d.sendPropertyValues} onChange={v => set('sendPropertyValues', v)} label="Send property values">
                            Values such as owner, classification and tags on the assets in an answer. Needed for “who owns…” and “which are PII…”.
                        </Toggle>
                        <Toggle checked={d.sendSampleValues} onChange={v => set('sendSampleValues', v)} label="Send sample values">
                            Example values from columns, where the catalogue holds them. Turn off if columns hold personal data.
                        </Toggle>
                        <Field
                            label="Rows of a result sent to the model"
                            hint={errors.maxResultRows ? <Bad>{errors.maxResultRows}</Bad> : 'The person asking still sees every row; the model reasons over the first ones. 1 to 200.'}
                        >
                            <TextField value={d.maxResultRows} inputMode="numeric" invalid={Boolean(errors.maxResultRows)}
                                onChange={e => set('maxResultRows', e.target.value)} />
                        </Field>
                        <RedactPatterns
                            patterns={d.redactPatterns}
                            errors={errors.patterns ?? {}}
                            tooMany={errors.redactPatterns}
                            onChange={v => set('redactPatterns', v)}
                        />
                    </div>
                    <aside aria-label="What leaves the platform" className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-4 space-y-3 h-fit">
                        <h3 className="text-xs font-bold text-ink">What leaves the platform</h3>
                        <ul className="space-y-1.5">
                            {leaves.sent.map(s => (
                                <li key={s} className="flex gap-2 text-[11px] text-ink-secondary">
                                    <ArrowRight className="w-3 h-3 mt-0.5 shrink-0 text-amber-500" aria-hidden />{s}
                                </li>
                            ))}
                        </ul>
                        <h3 className="text-xs font-bold text-ink pt-1">What stays</h3>
                        <ul className="space-y-1.5">
                            {leaves.withheld.map(s => (
                                <li key={s} className="flex gap-2 text-[11px] text-ink-secondary">
                                    <ShieldCheck className="w-3 h-3 mt-0.5 shrink-0 text-emerald-500" aria-hidden />{s}
                                </li>
                            ))}
                        </ul>
                    </aside>
                </div>
            </SsoCard>

            <SsoCard icon={Gauge} title="Limits and retention" blurb="Per person, so one busy colleague cannot use up the budget of everyone else.">
                <FieldGrid>
                    <NumberField label="Steps per answer" value={d.maxStepsPerTurn} error={errors.maxStepsPerTurn}
                        hint={`Searches and look-ups the assistant may make for one question. ${RANGES.maxStepsPerTurn.join(' to ')}.`}
                        onChange={v => set('maxStepsPerTurn', v)} />
                    <NumberField label="Tokens per person per day" value={d.dailyTokensPerUser} error={errors.dailyTokensPerUser}
                        hint="Questions and answers together. When it is used up, the assistant says so until tomorrow (UTC)."
                        onChange={v => set('dailyTokensPerUser', v)} />
                    <NumberField label="Questions at once per person" value={d.maxConcurrentTurnsPerUser} error={errors.maxConcurrentTurnsPerUser}
                        hint="A further question waits for one of these to finish. 1 to 8."
                        onChange={v => set('maxConcurrentTurnsPerUser', v)} />
                    <NumberField label="Keep conversations for (days)" value={d.retentionDays} error={errors.retentionDays}
                        hint="Older conversations, and their feedback, are deleted. 1 to 3650."
                        onChange={v => set('retentionDays', v)} />
                </FieldGrid>
            </SsoCard>

            <div className="flex items-center justify-end gap-2">
                {save.error && <p className="mr-auto text-[11px] text-red-600 dark:text-red-400">{(save.error as Error).message}</p>}
                {!valid && changes.length > 0 && <p className="mr-auto text-[11px] text-red-600 dark:text-red-400">Fix the fields marked in red to save.</p>}
                <Button size="sm" variant="ghost" disabled={changes.length === 0 || save.isPending} onClick={() => setD(saved)}>
                    Discard
                </Button>
                <Button size="sm" variant="primary" disabled={changes.length === 0 || !valid} onClick={() => { save.reset(); setConfirming(true) }}>
                    Save
                </Button>
            </div>

            {confirming && (
                <ConfirmDialog
                    title="Save the assistant settings"
                    confirmLabel="Save"
                    pending={save.isPending}
                    error={save.error ? (save.error as Error).message : null}
                    onClose={() => setConfirming(false)}
                    onConfirm={() => save.mutate(undefined, { onSuccess: () => setConfirming(false) })}
                >
                    {widening.length > 0 && (
                        <p className="flex gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.05] px-3 py-2 text-amber-800 dark:text-amber-300">
                            <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
                            <span>More leaves the platform, or stays longer: {widening.map(c => c.label.toLowerCase()).join(', ')}.</span>
                        </p>
                    )}
                    <ul className="space-y-1">
                        {changes.map(c => (
                            <li key={c.label}>
                                <span className="font-semibold text-ink">{c.label}</span>: {c.from} → {c.to}
                            </li>
                        ))}
                    </ul>
                    <p className="text-[11px] text-ink-muted">Every answer started after saving follows the new settings, within a few seconds.</p>
                </ConfirmDialog>
            )}
        </div>
    )
}

function Bad({ children }: { children: ReactNode }) {
    return <span className="text-red-500">{children}</span>
}

function Toggle({ checked, onChange, label, children }: {
    checked: boolean
    onChange: (v: boolean) => void
    label: string
    children: ReactNode
}) {
    return (
        <label className="flex items-start gap-2.5 cursor-pointer">
            <input type="checkbox" className="mt-0.5" checked={checked} onChange={e => onChange(e.target.checked)} />
            <span>
                <span className="block text-xs font-semibold text-ink">{label}</span>
                <span className="block text-[11px] text-ink-muted leading-relaxed">{children}</span>
            </span>
        </label>
    )
}

function NumberField({ label, value, error, hint, onChange }: {
    label: string
    value: string
    error?: string
    hint: string
    onChange: (v: string) => void
}) {
    return (
        <Field label={label} hint={error ? <Bad>{error}</Bad> : hint}>
            <TextField value={value} inputMode="numeric" invalid={Boolean(error)} onChange={e => onChange(e.target.value)} />
        </Field>
    )
}

function RedactPatterns({ patterns, errors, tooMany, onChange }: {
    patterns: string[]
    errors: Record<number, string>
    tooMany?: string
    onChange: (next: string[]) => void
}) {
    return (
        <Field
            label="Redaction patterns"
            hint={tooMany
                ? <Bad>{tooMany}</Bad>
                : 'Text matching any of these is replaced by [redacted] before anything is sent. Regular expressions (Python syntax), checked as you type and again on save.'}
            unlabelled
        >
            <div role="group" aria-label="Redaction patterns" className="space-y-1.5">
                {patterns.map((p, i) => (
                    <div key={i}>
                        <div className="flex items-center gap-2">
                            <TextField
                                aria-label={`Redaction pattern ${i + 1}`}
                                value={p}
                                placeholder="\b\d{3}-\d{2}-\d{4}\b"
                                invalid={Boolean(errors[i])}
                                onChange={e => onChange(patterns.map((q, j) => (j === i ? e.target.value : q)))}
                            />
                            <IconButton icon={X} size="sm" variant="danger" label={`Remove pattern ${i + 1}`}
                                onClick={() => onChange(patterns.filter((_, j) => j !== i))} />
                        </div>
                        {errors[i] && <span role="alert" className="mt-0.5 block text-[11px] text-red-500">{errors[i]}</span>}
                    </div>
                ))}
                {patterns.length < MAX_PATTERNS && (
                    <button
                        type="button"
                        onClick={() => onChange([...patterns, ''])}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                        <Plus className="w-3 h-3" aria-hidden /> Add a pattern
                    </button>
                )}
            </div>
        </Field>
    )
}
