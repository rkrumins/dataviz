import { cn } from '@/lib/utils'

/**
 * The switch was 44×56px of solid colour. Next to a 13px feature name, twelve times down a list, it
 * made the least informative element on the page the loudest thing on it — you saw a column of
 * toggles and had to hunt for the words.
 *
 * So `sm` shrinks the SWITCH, not the TARGET. The paint is 20×36, the size every console you'd want
 * to be compared to draws one; the button keeps its 44px hit area, because that minimum is about
 * thumbs, not about how big the colour has to look. Shrinking the tap target to tidy up the page
 * would be trading a real accessibility guarantee for a cosmetic one.
 */
export function ToggleSwitch({
  checked,
  onChange,
  disabled,
  size = 'md',
  'aria-label': ariaLabel,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  size?: 'sm' | 'md'
  'aria-label'?: string
}) {
  const sm = size === 'sm'

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'group relative inline-flex h-11 shrink-0 cursor-pointer items-center justify-center rounded-full',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2',
        sm ? 'w-11' : 'w-14',
        'active:scale-[0.98] transition-transform',
        disabled && 'cursor-not-allowed opacity-50 active:scale-100'
      )}
    >
      <span
        className={cn(
          'pointer-events-none flex items-center rounded-full transition-colors duration-150 ease-out',
          sm ? 'h-5 w-9' : 'h-11 w-14',
          checked ? 'bg-accent-lineage shadow-inner' : 'bg-black/15 dark:bg-white/20'
        )}
      >
        <span
          className={cn(
            'pointer-events-none inline-block transform rounded-full bg-white shadow-md ring-0 transition-transform duration-150 ease-out',
            sm ? 'h-4 w-4' : 'h-9 w-9',
            sm
              ? (checked ? 'translate-x-[18px]' : 'translate-x-0.5')
              : (checked ? 'translate-x-5' : 'translate-x-1')
          )}
        />
      </span>
    </button>
  )
}
