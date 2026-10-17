import tailwindcssAnimate from 'tailwindcss-animate'

// ── Theme colours kept in CSS variables, with opacity modifiers that work ──
//
// The variables hold complete colours (`#8898a9`, `rgba(255,255,255,.4)`),
// not channel triples, so Tailwind could not build `rgb(… / <alpha>)` from
// them and SKIPPED every modified utility: about 1,700 classes across the app
// (`bg-canvas-elevated/95`, `border-glass-border/50`, `text-ink-muted/60`…)
// rendered transparent, inherited their colour or fell back to the default
// border grey — bright in the dark theme. A colour function gets the modifier
// and answers with something that renders. Without a modifier the plain
// variable comes back, so no unmodified class changes; a browser without
// `color-mix()` drops only the modified ones, exactly as before.

/** Plain modifier is a real alpha: the variable mixed with transparent. */
const withAlpha = (cssVar) => ({ opacityValue }) =>
  opacityValue === undefined || String(opacityValue).startsWith('var(')
    ? `var(${cssVar})`
    : `color-mix(in srgb, var(${cssVar}) calc(${opacityValue} * 100%), transparent)`

/** `glass-border/NN` is a divider at NN of full strength. The glass border
 *  itself is white glass, invisible on a light surface; its modifiers were
 *  only ever seen as the default grey divider, so that is what they now are —
 *  dark ink on light, light on dark (`--nx-divider-rgb`), where the dark
 *  theme used to show a bright line. */
const divider = ({ opacityValue }) =>
  opacityValue === undefined || String(opacityValue).startsWith('var(')
    ? 'var(--nx-border-glass)'
    : `rgb(var(--nx-divider-rgb) / calc(${opacityValue} * 0.16))`

/** Ink AS TEXT never fades below its own token: muted is already the floor
 *  for legibility, and `text-ink-muted/50` drawn at half strength would be a
 *  label nobody can read. As a fill or a border it takes the alpha. `/0` is
 *  the one exception, and means what it says: hidden (an arrow that appears
 *  on hover). */
const inkText = (cssVar) => ({ opacityValue }) =>
  opacityValue !== undefined && Number(opacityValue) === 0 ? 'transparent' : `var(${cssVar})`

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      screens: {
        /**
         * `wide` — the viewport at which the capped page container can host ONE
         * MORE ~300px column without cramping the cards.
         *
         * Do NOT reach for `2xl` (1536px) here. Tailwind's breakpoints measure
         * the VIEWPORT, but cards live inside PageContainer, which has already
         * lost 260px to the sidebar and 96px to its gutters, and is capped at
         * 1760px. At a 1536px viewport that leaves ~1180px of content — five
         * columns there would be 212px each. A 16" MacBook (1728px) is likewise
         * still only ~1372px of content: five columns = 255px. Both are cramped.
         *
         * 1950px is where `min(1760, vw-260) - 96` first reaches 1596px, which
         * is exactly five 300px columns plus four 24px gaps. Below it, laptops
         * keep their current layout untouched; above it, a QHD monitor gains a
         * column instead of stretching the existing ones.
         *
         * Only for TOP-LEVEL pages. Admin panes sit behind a second 288px nav,
         * so this viewport threshold overshoots there — keep admin grids on `lg:`.
         */
        wide: '1950px',
      },
      colors: {
        // Adaptive backgrounds
        canvas: {
          // `base` is an alias of DEFAULT. `bg-canvas-base` is used ~65 times across
          // the app — heavily in the Advanced Search panel — but was
          // never defined here, so every one of those surfaces has been
          // rendering transparent. Defining it is what those call sites
          // always meant; migrating them to `bg-canvas` would be a
          // larger, riskier sweep for the same pixels.
          //
          //
          // Opacity modifiers on this family used to emit NO rule at all
          // (`bg-canvas-base/60` painted nothing), because the variables
          // hold complete colours. `withAlpha` above makes them render;
          // see the note at the top of this file.
          DEFAULT: withAlpha('--nx-bg-canvas'),
          base: withAlpha('--nx-bg-canvas'),
          elevated: withAlpha('--nx-bg-elevated'),
          overlay: withAlpha('--nx-bg-overlay'),
        },
        // Glass effect
        glass: {
          DEFAULT: withAlpha('--nx-bg-glass'),
          border: divider,
        },
        // Semantic accents
        // Raw channels + <alpha-value> so `accent-lineage/15` actually emits a
        // rule. As bare `var()`s these tokens silently dropped EVERY alpha
        // suffix — 1,066 of them across 208 files — which is why accent tints,
        // rings and gradients rendered as nothing and the app read as grey.
        // Lineage DIRECTION — incoming (upstream) / outgoing (downstream), one
        // pair everywhere (lib/lineageDirectionColors.ts), raw channels so
        // `lineage-in/10` emits a rule.
        lineage: {
          in: 'rgb(var(--nx-lineage-in-rgb) / <alpha-value>)',
          out: 'rgb(var(--nx-lineage-out-rgb) / <alpha-value>)',
        },
        accent: {
          lineage: 'rgb(var(--nx-accent-lineage-rgb) / <alpha-value>)',
          business: 'rgb(var(--nx-accent-business-rgb) / <alpha-value>)',
          explore: 'rgb(var(--nx-accent-explore-rgb) / <alpha-value>)',
          technical: 'rgb(var(--nx-accent-technical-rgb) / <alpha-value>)',
          warning: 'rgb(var(--nx-accent-warning-rgb) / <alpha-value>)',
          muted: 'rgb(var(--nx-accent-muted-rgb) / <alpha-value>)',
        },
        // Text colors — as a fill or a border, with a real alpha.
        ink: {
          DEFAULT: withAlpha('--nx-text-primary'),
          secondary: withAlpha('--nx-text-secondary'),
          muted: withAlpha('--nx-text-muted'),
          inverse: withAlpha('--nx-text-inverse'),
        },
      },
      // …and as text, never fainter than the token (see `inkText`).
      textColor: {
        ink: {
          DEFAULT: inkText('--nx-text-primary'),
          secondary: inkText('--nx-text-secondary'),
          muted: inkText('--nx-text-muted'),
          inverse: inkText('--nx-text-inverse'),
        },
      },
      // A placeholder is text too: `placeholder-ink-muted/40` reads like
      // `placeholder:text-ink-muted/40`.
      placeholderColor: ({ theme }) => ({ ink: theme('textColor.ink') }),
      fontFamily: {
        display: ['Outfit', 'system-ui', 'sans-serif'],
        sans: ['Inter Variable', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],
      },
      // The in-between steps the app is written with. Tailwind's scale goes in
      // fives, and a modifier off it (`bg-emerald-500/8`, `bg-accent-lineage/12`)
      // emits no rule at all — about 170 tints, washes and gradient stops
      // painted nothing until these were named.
      opacity: {
        3: '0.03',
        8: '0.08',
        12: '0.12',
        18: '0.18',
        22: '0.22',
        96: '0.96',
        98: '0.98',
      },
      backdropBlur: {
        glass: 'var(--nx-glass-blur)',
      },
      boxShadow: {
        'glass': '0 8px 32px rgba(0, 0, 0, 0.12)',
        'glass-lg': '0 16px 48px rgba(0, 0, 0, 0.16)',
        'glow': '0 0 20px var(--nx-accent-lineage)',
        'node': '0 4px 12px rgba(0, 0, 0, 0.15)',
        'node-hover': '0 8px 24px rgba(0, 0, 0, 0.2)',
      },
      borderRadius: {
        'xl': '12px',
        '2xl': '16px',
        '3xl': '24px',
      },
      animation: {
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'slide-right': 'slideRight 0.3s ease-out',
        'pulse-soft': 'pulseSoft 2s ease-in-out infinite',
        'flow': 'flow 2s linear infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideRight: {
          '0%': { opacity: '0', transform: 'translateX(-10px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        },
        flow: {
          '0%': { strokeDashoffset: '24' },
          '100%': { strokeDashoffset: '0' },
        },
      },
    },
  },
  // Powers the `animate-in` / `animate-out` entrance utilities (fade-in,
  // zoom-in-95, slide-in-from-*) already used across ~59 files. Without the
  // plugin those classes are inert — they were animating nothing.
  plugins: [tailwindcssAnimate],
}

