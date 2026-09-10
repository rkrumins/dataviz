/**
 * Admin Branding page — white-label the deployment from one place.
 * Accessible at /admin/branding (system:admin required).
 *
 * Edits the ``application_branding`` singleton through the admin API and
 * applies the result to the live brand store on save, so the header,
 * auth pages, tab title, favicon and accent colour all update without a
 * reload. A live preview mirrors changes as you type. Optimistic
 * concurrency: the saved ``version`` is echoed back; a 409 surfaces a
 * "someone else changed this" prompt rather than silently overwriting.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import {
    Palette, Type, ImageIcon, Scale, Loader2, Check, Upload, Trash2,
    RotateCcw, AlertCircle, Info, Sparkles,
} from 'lucide-react'

/** Built-in brand marks the admin can apply in one click. Paths resolve to
 *  self-contained SVGs in /public and flow through the ordinary
 *  logoUrl/faviconUrl fields — the animated variant is used for the logo
 *  (CSS animation plays when an SVG is loaded via <img>), the static variant
 *  for the favicon (browsers don't animate favicons). */
const BUILTIN_MARKS = [
    {
        id: 'graph-constellation',
        name: 'Graph constellation',
        blurb: 'Animated node-graph — the “preparing your graph” mark.',
        logoUrl: '/brand-graph-mark.svg',
        faviconUrl: '/brand-graph-icon.svg',
    },
    {
        id: 'nexus-pyramid',
        name: 'Layered pyramid',
        blurb: 'The classic stacked-pyramid mark.',
        logoUrl: '/nexus-icon.svg',
        faviconUrl: '/nexus-icon.svg',
    },
] as const
import {
    fetchAdminBranding, updateBranding, uploadBrandingImage, resetBranding,
    type Branding, type BrandingPatch,
} from '@/services/brandingService'
import { useBrandingStore } from '@/store/branding'
import { useAppNotifications } from '@/components/ui/notifications'
import { Backdrop } from '@/components/ui/Backdrop'
import { cn } from '@/lib/utils'
import { PageContainer } from '@/components/layout/PageContainer'

const BRANDING_QUERY_KEY = ['admin', 'branding'] as const

/** authFetch / fetch errors arrive as Error objects — read their message. */
function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
}

// The editable subset of the branding payload.
type FormState = Pick<
    Branding,
    | 'appName' | 'shortName' | 'description' | 'loginTagline'
    | 'logoUrl' | 'faviconUrl' | 'accentColor'
    | 'copyrightText' | 'supportEmail'
>

function formFrom(b: Branding): FormState {
    return {
        appName: b.appName,
        shortName: b.shortName,
        description: b.description,
        loginTagline: b.loginTagline,
        logoUrl: b.logoUrl.startsWith('data:') ? '' : b.logoUrl,
        faviconUrl: b.faviconUrl.startsWith('data:') ? '' : b.faviconUrl,
        accentColor: b.accentColor,
        copyrightText: b.copyrightText,
        supportEmail: b.supportEmail,
    }
}

export function AdminBranding() {
    const setBranding = useBrandingStore((s) => s.setBranding)
    const { notify } = useAppNotifications()

    const { data, isLoading, error, refetch } = useQuery({
        queryKey: BRANDING_QUERY_KEY,
        queryFn: fetchAdminBranding,
        staleTime: 0,
    })

    const [form, setForm] = useState<FormState | null>(null)
    const [version, setVersion] = useState(0)
    // The resolved logo/favicon as the server sees them (may be data URIs
    // from an upload) — used by the preview and the "remove" affordance.
    const [resolvedLogo, setResolvedLogo] = useState('')
    const [resolvedFavicon, setResolvedFavicon] = useState('')
    const [saving, setSaving] = useState(false)
    const [saved, setSaved] = useState(false)
    const [conflict, setConflict] = useState(false)
    const [showReset, setShowReset] = useState(false)
    const [resetting, setResetting] = useState(false)

    // Sync local form when the query resolves (or after a refetch).
    useEffect(() => {
        if (data) {
            setForm(formFrom(data))
            setVersion(data.version)
            setResolvedLogo(data.logoUrl)
            setResolvedFavicon(data.faviconUrl)
        }
    }, [data])

    const dirty = useMemo(
        () => !!data && !!form
            && JSON.stringify(form) !== JSON.stringify(formFrom(data)),
        [form, data],
    )

    function update<K extends keyof FormState>(key: K, value: FormState[K]) {
        setForm((f) => (f ? { ...f, [key]: value } : f))
        setSaved(false)
    }

    /** Apply a server response everywhere: local form, version, store. */
    function absorb(next: Branding) {
        setForm(formFrom(next))
        setVersion(next.version)
        setResolvedLogo(next.logoUrl)
        setResolvedFavicon(next.faviconUrl)
        setBranding(next)   // live-update the whole app
    }

    async function handleSave() {
        if (!form) return
        setSaving(true)
        setConflict(false)
        const patch: BrandingPatch = { ...form, expectedVersion: version }
        try {
            absorb(await updateBranding(patch))
            setSaved(true)
            notify('success', 'Branding saved — the new name and logo are live everywhere.')
        } catch (e) {
            const msg = errMsg(e)
            // A 409 is not a failure to report and forget: it is a standing
            // instruction ("someone else changed this, reload and re-apply"),
            // and it stays on the page until the user acts on it.
            if (/version mismatch|conflict/i.test(msg)) {
                setConflict(true)
            } else {
                notify('error', msg || 'Could not save the branding changes.')
            }
        } finally {
            setSaving(false)
        }
    }

    async function handleUpload(kind: 'logo' | 'favicon', file: File) {
        setSaving(true)
        try {
            absorb(await uploadBrandingImage(kind, file))
            setSaved(true)
            notify('success', kind === 'logo'
                ? 'New logo uploaded — it is live everywhere now.'
                : 'New favicon uploaded — it is live in the browser tab now.')
        } catch (e) {
            notify('error', errMsg(e) || `Could not upload the new ${kind}.`)
        } finally {
            setSaving(false)
        }
    }

    /** Reset every field back to the deployment (env) defaults. */
    async function handleReset() {
        setResetting(true)
        try {
            absorb(await resetBranding())
            notify('success', 'Branding reset — every override is gone and the deployment defaults are back.')
        } catch (e) {
            notify('error', errMsg(e) || 'Could not reset branding. Nothing was changed.')
        } finally {
            // Closed either way. The confirmation asked its question and got an
            // answer; a dialog left standing over a failure is both an invitation
            // to click the same button again and — before this page spoke through
            // the notification stack — the thing that hid the failure completely,
            // because the modal sits on top of the page it was reported on.
            setShowReset(false)
            setResetting(false)
        }
    }

    /** Apply a built-in mark as BOTH logo and favicon in one click. Writes the
     *  asset paths and clears any uploaded image data so the paths win
     *  (uploads otherwise take precedence). Persists immediately, like upload. */
    async function applyBuiltInMark(mark: (typeof BUILTIN_MARKS)[number]) {
        setSaving(true)
        try {
            absorb(await updateBranding({
                logoUrl: mark.logoUrl,
                faviconUrl: mark.faviconUrl,
                logoData: '', logoMime: '',
                faviconData: '', faviconMime: '',
                expectedVersion: version,
            }))
            setSaved(true)
            notify('success', `“${mark.name}” applied as the logo and favicon.`)
        } catch (e) {
            notify('error', errMsg(e) || `Could not apply “${mark.name}”.`)
        } finally {
            setSaving(false)
        }
    }

    /** Clear an uploaded image so the URL field / default mark takes over. */
    async function handleClearImage(kind: 'logo' | 'favicon') {
        setSaving(true)
        const patch: BrandingPatch = kind === 'logo'
            ? { logoData: '', logoMime: '', expectedVersion: version }
            : { faviconData: '', faviconMime: '', expectedVersion: version }
        try {
            absorb(await updateBranding(patch))
            setSaved(true)
            notify('success', kind === 'logo'
                ? 'Uploaded logo removed — the URL field, or the default mark, takes over.'
                : 'Uploaded favicon removed — the URL field, or the default mark, takes over.')
        } catch (e) {
            notify('error', errMsg(e) || `Could not remove the uploaded ${kind}.`)
        } finally {
            setSaving(false)
        }
    }

    if (isLoading || !form) {
        return (
            <div className="max-w-2xl mx-auto p-8 space-y-6">
                <div className="space-y-2">
                    <div className="h-7 w-40 rounded-lg bg-black/5 dark:bg-white/10 animate-pulse" />
                    <div className="h-4 w-64 rounded bg-black/5 dark:bg-white/10 animate-pulse" />
                </div>
                {[1, 2, 3, 4].map((i) => (
                    <div key={i} className="space-y-2">
                        <div className="h-4 w-28 rounded bg-black/5 dark:bg-white/10 animate-pulse" />
                        <div className="h-10 w-full rounded-lg border border-glass-border bg-black/5 dark:bg-white/10 animate-pulse" />
                    </div>
                ))}
            </div>
        )
    }

    if (error) {
        return (
            <div className="max-w-2xl mx-auto p-8">
                <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-accent-warning/10 border border-accent-warning/20 text-accent-warning">
                    <AlertCircle className="w-5 h-5 shrink-0" />
                    <span className="text-sm">Couldn't load branding settings. {errMsg(error)}</span>
                </div>
            </div>
        )
    }

    const hasUploadedLogo = resolvedLogo.startsWith('data:')
    const hasUploadedFavicon = resolvedFavicon.startsWith('data:')
    const previewLogo = hasUploadedLogo ? resolvedLogo : form.logoUrl

    return (
        <PageContainer gutter="shell" className="py-8 animate-in fade-in duration-500">
            {/* Page header */}
            <div className="flex items-start gap-4 mb-8">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/20 shrink-0">
                    <Palette className="w-6 h-6 text-white" />
                </div>
                <div className="min-w-0">
                    <h1 className="text-2xl font-bold text-ink">Branding</h1>
                    <p className="text-sm text-ink-secondary mt-1 max-w-2xl">
                        Customise how this deployment presents itself — the name, logo,
                        colours and legal text used across the app, the sign-in screen,
                        and the browser tab. Changes apply everywhere the moment you save.
                    </p>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[1fr_22rem] gap-8 items-start">
                {/* ── Editor column ─────────────────────────────── */}
                <div className="space-y-6 order-2 lg:order-1">
                    <Section
                        icon={Type}
                        title="Identity"
                        blurb="The names and copy that introduce your product to users."
                    >
                        <Field
                            label="Application name"
                            help="The full product name. Shown on the sign-in screen and the browser tab."
                            value={form.appName}
                            onChange={(v) => update('appName', v)}
                            placeholder="Context Visualization Platform"
                        />
                        <Field
                            label="Short name"
                            help="A compact variant for tight spaces like the top bar and command palette."
                            value={form.shortName}
                            onChange={(v) => update('shortName', v)}
                            placeholder="CVP"
                        />
                        <Field
                            label="Description"
                            help="A one-line tagline describing what the product does. Used in metadata."
                            value={form.description}
                            onChange={(v) => update('description', v)}
                            placeholder="Interactive Data Lineage Visualization"
                        />
                        <Field
                            label="Sign-in tagline"
                            help="The line shown beneath the name on the login screen."
                            value={form.loginTagline}
                            onChange={(v) => update('loginTagline', v)}
                            placeholder="Sign in to continue"
                        />
                    </Section>

                    <Section
                        icon={ImageIcon}
                        title="Logo & favicon"
                        blurb="Upload an image or point to a hosted URL. Uploads take precedence; SVG or PNG up to 1 MB."
                    >
                        {/* Built-in marks — one click sets both logo and favicon. */}
                        <div className="flex flex-col gap-2">
                            <div className="text-xs font-medium text-ink-muted">Built-in marks</div>
                            {BUILTIN_MARKS.map((mark) => {
                                const active = resolvedLogo === mark.logoUrl && resolvedFavicon === mark.faviconUrl
                                return (
                                    <div
                                        key={mark.id}
                                        className="flex items-center gap-3.5 rounded-xl border border-glass-border bg-canvas/40 p-3"
                                    >
                                        <img
                                            src={mark.logoUrl}
                                            alt={mark.name}
                                            className="h-11 w-11 shrink-0 rounded-lg object-contain shadow-sm"
                                        />
                                        <div className="min-w-0 flex-1">
                                            <div className="text-sm font-semibold text-ink">{mark.name}</div>
                                            <div className="text-xs text-ink-muted">{mark.blurb}</div>
                                        </div>
                                        {active ? (
                                            <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold text-accent-business">
                                                <Check className="h-4 w-4" /> In use
                                            </span>
                                        ) : (
                                            <button
                                                onClick={() => applyBuiltInMark(mark)}
                                                disabled={saving}
                                                className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-accent-lineage px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-50"
                                            >
                                                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                                                Use this mark
                                            </button>
                                        )}
                                    </div>
                                )
                            })}
                        </div>

                        <ImageField
                            label="Logo"
                            help="Shown in the top bar. Falls back to the default mark when empty."
                            uploaded={hasUploadedLogo}
                            uploadedSrc={resolvedLogo}
                            url={form.logoUrl}
                            onUrlChange={(v) => update('logoUrl', v)}
                            onUpload={(f) => handleUpload('logo', f)}
                            onClear={() => handleClearImage('logo')}
                            busy={saving}
                        />
                        <ImageField
                            label="Favicon"
                            help="The icon in the browser tab. ICO, PNG or SVG."
                            uploaded={hasUploadedFavicon}
                            uploadedSrc={resolvedFavicon}
                            url={form.faviconUrl}
                            onUrlChange={(v) => update('faviconUrl', v)}
                            onUpload={(f) => handleUpload('favicon', f)}
                            onClear={() => handleClearImage('favicon')}
                            busy={saving}
                        />
                    </Section>

                    <Section
                        icon={Palette}
                        title="Theme"
                        blurb="The primary accent colour used for highlights, buttons and active states."
                    >
                        <div className="flex items-center gap-4">
                            <input
                                type="color"
                                aria-label="Accent colour"
                                value={form.accentColor}
                                onChange={(e) => update('accentColor', e.target.value)}
                                className="w-12 h-12 rounded-xl border border-glass-border bg-transparent cursor-pointer shrink-0"
                            />
                            <div className="flex-1">
                                <Field
                                    label="Accent colour"
                                    help="Hex value, e.g. #6366f1. Applied live across the app."
                                    value={form.accentColor}
                                    onChange={(v) => update('accentColor', v)}
                                    placeholder="#6366f1"
                                    mono
                                />
                            </div>
                        </div>
                    </Section>

                    <Section
                        icon={Scale}
                        title="Legal & contact"
                        blurb="Footer copyright and the support address surfaced in help."
                    >
                        <Field
                            label="Copyright"
                            help="Footer text on the sign-in screen and elsewhere."
                            value={form.copyrightText}
                            onChange={(v) => update('copyrightText', v)}
                            placeholder="© 2026 Context Visualization Platform"
                        />
                        <Field
                            label="Support email"
                            help="Where users are pointed for help. Leave blank to hide."
                            value={form.supportEmail}
                            onChange={(v) => update('supportEmail', v)}
                            placeholder="support@example.com"
                            type="email"
                        />
                    </Section>

                    {/* The one thing that stays on the page: a 409 is not a report of
                        something that happened, it is state that is still true while
                        you read it, and it carries the next step. Failures go to the
                        notification stack — including the reset's, which used to be
                        rendered here, underneath the modal that caused it. */}
                    {conflict && (
                        <Banner tone="warning">
                            Someone else updated branding while you were editing. {' '}
                            <button
                                onClick={() => { setConflict(false); void refetch() }}
                                className="underline font-medium hover:opacity-80"
                            >
                                Reload the latest
                            </button>{' '}and re-apply your changes.
                        </Banner>
                    )}

                    {/* Action bar */}
                    <div className="flex items-center gap-3 sticky bottom-4 bg-canvas-elevated border border-glass-border rounded-2xl px-4 py-3 shadow-lg">
                        <button
                            onClick={handleSave}
                            disabled={!dirty || saving}
                            className={cn(
                                'inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors',
                                'bg-indigo-500 text-white hover:bg-indigo-600 shadow-sm shadow-indigo-500/30',
                                'disabled:opacity-40 disabled:cursor-not-allowed',
                            )}
                        >
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" />
                                : saved && !dirty ? <Check className="w-4 h-4" />
                                : null}
                            {saving ? 'Saving…' : saved && !dirty ? 'Saved' : 'Save changes'}
                        </button>
                        {dirty && data && (
                            <button
                                onClick={() => setForm(formFrom(data))}
                                disabled={saving}
                                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                            >
                                <RotateCcw className="w-4 h-4" /> Discard
                            </button>
                        )}
                        <div className="ml-auto flex items-center gap-3">
                            <span className="text-[11px] text-ink-muted hidden sm:inline">
                                Empty fields fall back to deployment defaults.
                            </span>
                            <button
                                onClick={() => setShowReset(true)}
                                disabled={saving || resetting}
                                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-ink-muted hover:text-accent-warning hover:bg-accent-warning/10 transition-colors disabled:opacity-50"
                            >
                                <RotateCcw className="w-4 h-4" /> Reset to defaults
                            </button>
                        </div>
                    </div>
                </div>

                {/* ── Live preview column ───────────────────────── */}
                <div className="order-1 lg:order-2 lg:sticky lg:top-8 space-y-3">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-muted">
                        <Info className="w-3.5 h-3.5" /> Live preview
                    </div>
                    <Preview
                        accent={form.accentColor}
                        name={form.appName}
                        shortName={form.shortName}
                        tagline={form.loginTagline}
                        copyright={form.copyrightText}
                        logo={previewLogo}
                    />
                </div>
            </div>

            <ResetConfirmModal
                open={showReset}
                loading={resetting}
                onClose={() => setShowReset(false)}
                onConfirm={handleReset}
            />
        </PageContainer>
    )
}

function ResetConfirmModal({
    open, loading, onClose, onConfirm,
}: {
    open: boolean
    loading: boolean
    onClose: () => void
    onConfirm: () => void
}) {
    return (
        <>
            {/* Backdrop — plain CSS transition, never inside AnimatePresence (fixes the
                StrictMode click-shield where a stranded fixed-inset-0 node eats clicks). */}
            <Backdrop open={open} onClick={() => !loading && onClose()} zClassName="z-50" className="bg-black/50" />

            {/* Centering layer: plain, always-mounted, transparent to clicks (they fall
                through to the Backdrop beneath → outside-click still closes). */}
            <div className="fixed inset-0 z-[51] flex items-center justify-center p-4 pointer-events-none">
                <AnimatePresence>
                    {open && (
                        <motion.div
                            key="branding-reset-card"
                            initial={{ scale: 0.96, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.96, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            onClick={(e) => e.stopPropagation()}
                            className="pointer-events-auto w-full max-w-md rounded-2xl bg-canvas-elevated border border-glass-border shadow-xl p-6"
                            role="dialog"
                            aria-modal="true"
                            aria-labelledby="branding-reset-title"
                        >
                            <h3 id="branding-reset-title" className="text-lg font-bold text-ink mb-2">
                                Reset to defaults
                            </h3>
                            <p className="text-sm text-ink-muted mb-6 leading-relaxed">
                                Clear every branding override — name, logo, favicon, colours
                                and legal text — and revert to this deployment's defaults?
                                This applies immediately and can't be undone.
                            </p>
                            <div className="flex justify-end gap-3">
                                <button
                                    type="button"
                                    onClick={onClose}
                                    disabled={loading}
                                    className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={onConfirm}
                                    disabled={loading}
                                    className="px-4 py-2 rounded-xl text-sm font-semibold bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50 transition-colors flex items-center gap-2"
                                >
                                    {loading ? <Loader2 className="w-4 h-4 animate-spin" />
                                        : <RotateCcw className="w-4 h-4" />}
                                    Reset
                                </button>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </>
    )
}

// ── Building blocks ─────────────────────────────────────────────────

function Section({
    icon: Icon, title, blurb, children,
}: {
    icon: typeof Type
    title: string
    blurb: string
    children: React.ReactNode
}) {
    return (
        <section className="rounded-2xl border border-glass-border bg-canvas-elevated p-6">
            <div className="flex items-start gap-3 mb-5">
                <div className="w-9 h-9 rounded-xl bg-indigo-500/10 flex items-center justify-center shrink-0">
                    <Icon className="w-4.5 h-4.5 text-indigo-500" />
                </div>
                <div>
                    <h2 className="text-sm font-bold text-ink">{title}</h2>
                    <p className="text-xs text-ink-muted mt-0.5">{blurb}</p>
                </div>
            </div>
            <div className="space-y-5">{children}</div>
        </section>
    )
}

function Field({
    label, help, value, onChange, placeholder, type = 'text', mono = false,
}: {
    label: string
    help: string
    value: string
    onChange: (v: string) => void
    placeholder?: string
    type?: string
    mono?: boolean
}) {
    return (
        <label className="block">
            <span className="text-xs font-semibold text-ink-secondary">{label}</span>
            <input
                type={type}
                value={value}
                placeholder={placeholder}
                onChange={(e) => onChange(e.target.value)}
                className={cn(
                    'mt-1.5 w-full px-3 py-2 rounded-lg border border-glass-border bg-canvas',
                    'text-ink text-sm placeholder:text-ink-muted/60',
                    'focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40 transition-shadow',
                    mono && 'font-mono',
                )}
            />
            <span className="block text-[11px] text-ink-muted mt-1">{help}</span>
        </label>
    )
}

function ImageField({
    label, help, uploaded, uploadedSrc, url, onUrlChange, onUpload, onClear, busy,
}: {
    label: string
    help: string
    uploaded: boolean
    uploadedSrc: string
    url: string
    onUrlChange: (v: string) => void
    onUpload: (f: File) => void
    onClear: () => void
    busy: boolean
}) {
    const inputRef = useRef<HTMLInputElement>(null)
    const hasImage = uploaded || !!url
    const previewSrc = uploaded ? uploadedSrc : url

    return (
        <div>
            <span className="text-xs font-semibold text-ink-secondary">{label}</span>
            <div className="mt-1.5 flex items-start gap-3">
                {/* Thumbnail */}
                <div className="w-14 h-14 rounded-xl border border-glass-border bg-canvas flex items-center justify-center overflow-hidden shrink-0">
                    {hasImage
                        ? <img src={previewSrc} alt={`${label} preview`} className="w-full h-full object-contain" />
                        : <ImageIcon className="w-5 h-5 text-ink-muted/50" />}
                </div>
                <div className="flex-1 min-w-0 space-y-2">
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => inputRef.current?.click()}
                            disabled={busy}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-indigo-600 dark:text-indigo-400 border border-indigo-500/25 hover:bg-indigo-500/10 transition-colors disabled:opacity-50"
                        >
                            <Upload className="w-3.5 h-3.5" /> Upload
                        </button>
                        {(uploaded || url) && (
                            <button
                                type="button"
                                onClick={uploaded ? onClear : () => onUrlChange('')}
                                disabled={busy}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-accent-warning hover:bg-accent-warning/10 transition-colors disabled:opacity-50"
                            >
                                <Trash2 className="w-3.5 h-3.5" /> Remove
                            </button>
                        )}
                        <input
                            ref={inputRef}
                            type="file"
                            accept="image/svg+xml,image/png,image/jpeg,image/webp,image/x-icon"
                            className="hidden"
                            onChange={(e) => {
                                const f = e.target.files?.[0]
                                if (f) onUpload(f)
                                e.target.value = ''
                            }}
                        />
                    </div>
                    <input
                        type="url"
                        value={url}
                        placeholder="…or paste a hosted image URL"
                        disabled={uploaded}
                        onChange={(e) => onUrlChange(e.target.value)}
                        className="w-full px-3 py-1.5 rounded-lg border border-glass-border bg-canvas text-ink text-xs placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 disabled:opacity-50"
                    />
                </div>
            </div>
            <span className="block text-[11px] text-ink-muted mt-1.5">
                {help}{uploaded && ' An uploaded image is in use — remove it to use a URL.'}
            </span>
        </div>
    )
}

function Preview({
    accent, name, shortName, tagline, copyright, logo,
}: {
    accent: string
    name: string
    shortName: string
    tagline: string
    copyright: string
    logo: string
}) {
    const Mark = (
        <div
            className="w-8 h-8 rounded-lg flex items-center justify-center overflow-hidden shrink-0"
            style={logo ? undefined : { background: `linear-gradient(135deg, ${accent}, ${accent}99)` }}
        >
            {logo
                ? <img src={logo} alt="" className="w-full h-full object-contain" />
                : (
                    <svg viewBox="0 0 24 24" className="w-5 h-5 text-white" fill="none" stroke="currentColor" strokeWidth={2}>
                        <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
                    </svg>
                )}
        </div>
    )

    return (
        <div className="space-y-3">
            {/* Top-bar mock */}
            <div className="rounded-xl border border-glass-border bg-canvas-elevated overflow-hidden">
                <div className="h-12 px-3 flex items-center gap-2 border-b border-glass-border">
                    {Mark}
                    <span className="font-display font-semibold text-sm text-ink truncate">
                        {shortName || name || 'Your brand'}
                    </span>
                    <span className="ml-auto w-16 h-5 rounded-md" style={{ background: `${accent}22` }} />
                </div>
                <div className="p-3 flex gap-2">
                    <span className="px-2.5 py-1 rounded-md text-[11px] font-medium text-white" style={{ background: accent }}>
                        Primary
                    </span>
                    <span className="px-2.5 py-1 rounded-md text-[11px] font-medium" style={{ color: accent, background: `${accent}1a` }}>
                        Active
                    </span>
                </div>
            </div>

            {/* Sign-in mock */}
            <motion.div layout className="rounded-xl border border-glass-border bg-canvas-elevated p-5 text-center">
                <div className="mx-auto w-10 h-10 mb-3 rounded-xl flex items-center justify-center" style={{ background: `linear-gradient(135deg, ${accent}, ${accent}cc)` }}>
                    <div className="scale-90">{logo ? <img src={logo} alt="" className="w-6 h-6 object-contain" /> : null}</div>
                </div>
                <div className="text-base font-bold text-ink truncate" style={{ color: accent }}>
                    {name || 'Your brand'}
                </div>
                <div className="text-[11px] text-ink-secondary mt-1">{tagline || 'Sign in to continue'}</div>
                <div className="mt-4 space-y-2">
                    <div className="h-7 rounded-lg bg-black/5 dark:bg-white/5" />
                    <div className="h-7 rounded-lg bg-black/5 dark:bg-white/5" />
                    <div className="h-7 rounded-lg text-white text-[11px] font-semibold flex items-center justify-center" style={{ background: accent }}>
                        Sign in
                    </div>
                </div>
                <div className="text-[9px] text-ink-muted/70 mt-3 uppercase tracking-widest">
                    {copyright || '© Your Company'}
                </div>
            </motion.div>
        </div>
    )
}

function Banner({ tone, children }: { tone: 'warning' | 'error'; children: React.ReactNode }) {
    return (
        <div className={cn(
            'flex items-start gap-3 px-4 py-3 rounded-xl border text-sm',
            tone === 'warning'
                ? 'bg-amber-500/10 border-amber-500/20 text-amber-700 dark:text-amber-300'
                : 'bg-accent-warning/10 border-accent-warning/20 text-accent-warning',
        )}>
            <AlertCircle className="w-4.5 h-4.5 shrink-0 mt-0.5" />
            <div>{children}</div>
        </div>
    )
}
