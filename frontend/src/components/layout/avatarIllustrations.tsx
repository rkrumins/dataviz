/**
 * The pre-defined avatar illustrations — plain data, in its own module
 * so both the picker and ``UserAvatar`` can read it without either
 * dragging a component export along (react-refresh wants component
 * files to export only components).
 */

/** Each entry is a simple inline-SVG illustration. */
export const AVATARS: { id: string; label: string; bg: string; content: (cls: string) => React.ReactNode }[] = [
  {
    id: 'bot',
    label: 'Robot',
    bg: 'bg-sky-500/15',
    content: (cls) => (
      <svg className={cls} viewBox="0 0 36 36" fill="none">
        <rect x="8" y="12" width="20" height="16" rx="4" stroke="currentColor" strokeWidth="2" />
        <circle cx="14" cy="20" r="2" fill="currentColor" />
        <circle cx="22" cy="20" r="2" fill="currentColor" />
        <path d="M14 25h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="18" y1="6" x2="18" y2="12" stroke="currentColor" strokeWidth="2" />
        <circle cx="18" cy="5" r="2" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: 'cat',
    label: 'Cat',
    bg: 'bg-amber-500/15',
    content: (cls) => (
      <svg className={cls} viewBox="0 0 36 36" fill="none">
        <path d="M8 28V14l5-8h10l5 8v14a2 2 0 01-2 2H10a2 2 0 01-2-2z" stroke="currentColor" strokeWidth="2" />
        <circle cx="14" cy="18" r="2" fill="currentColor" />
        <circle cx="22" cy="18" r="2" fill="currentColor" />
        <path d="M16 23l2 2 2-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12 24h-4M24 24h4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'rocket',
    label: 'Rocket',
    bg: 'bg-rose-500/15',
    content: (cls) => (
      <svg className={cls} viewBox="0 0 36 36" fill="none">
        <path d="M18 4c-4 6-6 12-6 18h12c0-6-2-12-6-18z" stroke="currentColor" strokeWidth="2" />
        <circle cx="18" cy="16" r="3" stroke="currentColor" strokeWidth="1.5" />
        <path d="M12 22l-4 6h4M24 22l4 6h-4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M15 28h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'tree',
    label: 'Tree',
    bg: 'bg-emerald-500/15',
    content: (cls) => (
      <svg className={cls} viewBox="0 0 36 36" fill="none">
        <path d="M18 4l-8 12h4l-5 8h18l-5-8h4L18 4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <rect x="16" y="24" width="4" height="8" rx="1" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    id: 'star',
    label: 'Star',
    bg: 'bg-yellow-500/15',
    content: (cls) => (
      <svg className={cls} viewBox="0 0 36 36" fill="none">
        <path d="M18 4l4.09 8.29L31 13.64l-6.5 6.33 1.53 8.96L18 24.77l-8.03 4.16 1.53-8.96L5 13.64l8.91-1.35L18 4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'mountain',
    label: 'Mountain',
    bg: 'bg-violet-500/15',
    content: (cls) => (
      <svg className={cls} viewBox="0 0 36 36" fill="none">
        <path d="M4 30l10-18 4 6 6-12 8 24H4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <circle cx="28" cy="8" r="3" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    id: 'diamond',
    label: 'Diamond',
    bg: 'bg-cyan-500/15',
    content: (cls) => (
      <svg className={cls} viewBox="0 0 36 36" fill="none">
        <path d="M18 4l14 14-14 14L4 18 18 4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M10 18h16M18 10v16" stroke="currentColor" strokeWidth="1" opacity="0.4" />
      </svg>
    ),
  },
  {
    id: 'lightning',
    label: 'Lightning',
    bg: 'bg-orange-500/15',
    content: (cls) => (
      <svg className={cls} viewBox="0 0 36 36" fill="none">
        <path d="M20 4L10 20h7l-3 12 13-18h-8L20 4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      </svg>
    ),
  },
]
