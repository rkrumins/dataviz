/**
 * Shared field chrome for the per-kind settings forms.
 *
 * Sized to be read and typed into rather than filled in — this is the
 * surface where someone rotates a client secret at 2am, not a dense table.
 * Follows `InviteWizard/ui`'s border-2 + focus-ring idiom so the drawer and
 * the wizard look like the same product.
 */
import { useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Eye, EyeOff, KeyRound, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'

/** The marker the API substitutes for a configured secret. */
export const REDACTED = '********'

export function Field({
    label, hint, required, children, className, unlabelled,
}: {
    label: ReactNode
    hint?: ReactNode
    required?: boolean
    children: ReactNode
    className?: string
    /**
     * Render a plain container rather than a `<label>`.
     *
     * Needed whenever the content is not a single form control: `<button>`
     * is a *labelable* element, so a button inside a `<label>` inherits the
     * whole label as its accessible name — a screen reader announces the
     * Rotate button as "Client secret Configured — leave as-is to keep it
     * Rotate".
     */
    unlabelled?: boolean
}) {
    const Wrapper = unlabelled ? 'div' : 'label'
    return (
        <Wrapper className={cn('block', className)}>
            <span className="block text-xs font-semibold text-ink mb-1.5">
                {label}
                {required && <span aria-hidden="true" className="text-red-500 ml-0.5">*</span>}
            </span>
            {children}
            {hint && (
                <span className="mt-1 block text-[10px] text-ink-muted leading-relaxed">
                    {hint}
                </span>
            )}
        </Wrapper>
    )
}

const base =
    'w-full px-3 py-2 text-sm rounded-xl border-2 bg-canvas-elevated text-ink ' +
    'placeholder:text-ink-muted outline-none transition-colors duration-150 ' +
    'focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10'

const idle = 'border-black/[0.10] dark:border-white/[0.12]'
const bad = 'border-rose-400 dark:border-rose-500/70 focus:ring-rose-500/10'

export function TextField({
    invalid, mono = true, ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
    invalid?: boolean
    mono?: boolean
}) {
    return (
        <input
            {...props}
            className={cn(base, invalid ? bad : idle, mono && 'font-mono text-xs')}
        />
    )
}

export function TextAreaField({
    invalid, ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
    return (
        <textarea
            {...props}
            className={cn(base, invalid ? bad : idle, 'font-mono text-xs resize-y')}
        />
    )
}

export function SelectField(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
    return <select {...props} className={cn(base, idle, 'text-sm')} />
}

/**
 * A secret that is already configured.
 *
 * The API returns `********` for every secret field, and PATCH merges
 * rather than replaces — so a form that pre-fills a password box with the
 * mask invites writing the mask over the real value. (The server refuses
 * that outright; this is about not asking for it in the first place.)
 *
 * So a configured secret is *stated*, not shown in an editable box.
 * Rotating is a deliberate second action, and until you take it the field
 * submits nothing at all.
 */
export function SecretField({
    label, hint, value, onChange, placeholder, required,
}: {
    label: ReactNode
    hint?: ReactNode
    value: string
    onChange: (next: string) => void
    placeholder?: string
    required?: boolean
}) {
    const configured = value === REDACTED
    const [rotating, setRotating] = useState(false)
    const [reveal, setReveal] = useState(false)

    if (configured && !rotating) {
        return (
            <Field label={label} hint={hint} unlabelled>
                <div className="flex items-center gap-2 px-3 py-2 rounded-xl border-2 border-emerald-400/40 bg-emerald-500/[0.06]">
                    <Check className="w-3.5 h-3.5 shrink-0 text-emerald-500" />
                    <span className="flex-1 text-xs text-ink">
                        Configured — leave as-is to keep it
                    </span>
                    <button
                        type="button"
                        onClick={() => { setRotating(true); onChange('') }}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-black/[0.10] dark:border-white/[0.12] text-[11px] text-ink-muted hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                    >
                        <RotateCcw className="w-3 h-3" /> Rotate
                    </button>
                </div>
            </Field>
        )
    }

    return (
        <Field label={label} hint={hint} required={required}>
            <div className="relative">
                <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted pointer-events-none" />
                <input
                    type={reveal ? 'text' : 'password'}
                    value={value}
                    onChange={e => onChange(e.target.value)}
                    placeholder={placeholder}
                    autoComplete="new-password"
                    className={cn(base, idle, 'font-mono text-xs pl-9 pr-10')}
                />
                <button
                    type="button"
                    aria-label={reveal ? 'Hide secret' : 'Show secret'}
                    onClick={() => setReveal(r => !r)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-ink-muted hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
                >
                    {reveal ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
            </div>
            {rotating && (
                <span className="mt-1 block text-[10px] text-amber-600 dark:text-amber-400">
                    Replacing the existing secret. Leave empty to cancel the rotation.
                </span>
            )}
        </Field>
    )
}

/** The two settings that knowingly degrade trust. Loud on purpose. */
export function DangerToggle({
    checked, onChange, title, children,
}: {
    checked: boolean
    onChange: (v: boolean) => void
    title: string
    children: ReactNode
}) {
    return (
        <div className={cn(
            'p-3 rounded-xl border-2',
            checked
                ? 'border-red-500/50 bg-red-500/10'
                : 'border-black/[0.10] dark:border-white/[0.12]',
        )}>
            <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                    type="checkbox"
                    checked={checked}
                    onChange={e => onChange(e.target.checked)}
                    className="mt-0.5"
                />
                <span>
                    <span className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                        <AlertTriangle className={cn(
                            'w-3.5 h-3.5',
                            checked ? 'text-red-500' : 'text-amber-500',
                        )} />
                        {title}
                    </span>
                    <span className="mt-1 block text-[11px] text-ink-muted leading-relaxed">
                        {children}
                    </span>
                </span>
            </label>
        </div>
    )
}

export function FieldGrid({ children }: { children: ReactNode }) {
    return <div className="grid gap-3 sm:grid-cols-2">{children}</div>
}
