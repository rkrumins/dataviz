import { cn } from '@/lib/utils'

export function ToggleSwitch({
  checked,
  onChange,
  disabled,
  'aria-label': ariaLabel,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  'aria-label'?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-11 w-14 shrink-0 cursor-pointer rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2',
        'min-h-[44px] min-w-[44px] transition-colors duration-150 ease-out',
        'active:scale-[0.98] transition-transform',
        checked ? 'bg-accent-lineage shadow-inner' : 'bg-black/10 dark:bg-white/20',
        disabled && 'cursor-not-allowed opacity-50 active:scale-100'
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block h-9 w-9 transform rounded-full bg-white shadow-md ring-0 transition-transform duration-150 ease-out',
          checked ? 'translate-x-5' : 'translate-x-1'
        )}
      />
    </button>
  )
}
