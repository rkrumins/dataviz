/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
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
  plugins: [],
}

