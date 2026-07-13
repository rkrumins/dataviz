import tailwindcssAnimate from 'tailwindcss-animate'

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
          DEFAULT: 'var(--nx-bg-canvas)',
          elevated: 'var(--nx-bg-elevated)',
          overlay: 'var(--nx-bg-overlay)',
        },
        // Glass effect
        glass: {
          DEFAULT: 'var(--nx-bg-glass)',
          border: 'var(--nx-border-glass)',
        },
        // Semantic accents
        accent: {
          lineage: 'var(--nx-accent-lineage)',
          business: 'var(--nx-accent-business)',
          technical: 'var(--nx-accent-technical)',
          warning: 'var(--nx-accent-warning)',
          muted: 'var(--nx-accent-muted)',
        },
        // Text colors
        ink: {
          DEFAULT: 'var(--nx-text-primary)',
          secondary: 'var(--nx-text-secondary)',
          muted: 'var(--nx-text-muted)',
          inverse: 'var(--nx-text-inverse)',
        },
      },
      fontFamily: {
        display: ['Outfit', 'system-ui', 'sans-serif'],
        sans: ['Inter Variable', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],
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

