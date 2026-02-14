/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // ---------------------------------------------------------------------
        // OpenReelio Cinematic Core Palette (Zinc-based for neutral precision)
        // ---------------------------------------------------------------------

        // Base neutrals - Optimized for long-session eye comfort and color grading neutrality
        neutral: {
          50: '#fafafa',
          100: '#f4f4f5',
          200: '#e4e4e7',
          300: '#d4d4d8',
          400: '#a1a1aa',
          500: '#71717a',
          600: '#52525b',
          700: '#3f3f46',
          800: '#27272a',
          900: '#18181b',
          950: '#09090b', // True deep black for OLED contrast
        },

        // Brand Identity
        primary: {
          50: '#f0f9ff',
          100: '#e0f2fe',
          200: '#bae6fd',
          300: '#7dd3fc',
          400: '#38bdf8',
          500: '#0ea5e9', // Sky-500 (Main Brand)
          600: '#0284c7',
          700: '#0369a1',
          800: '#075985',
          900: '#0c4a6e',
          950: '#082f49',
        },

        // Legacy/editor semantic aliases (used across the UI)
        // Keep these stable to avoid breaking existing classnames.
        editor: {
          bg: '#09090b', // surface.base
          'bg-secondary': '#18181b', // surface.panel
          'bg-tertiary': '#27272a', // surface.elevated
          'bg-hover': '#18181b', // hover on editor.bg surfaces
          sidebar: '#18181b', // surface.panel
          panel: '#18181b', // surface.panel
          modal: '#27272a', // surface.elevated
          surface: '#27272a', // surface.elevated
          'surface-hover': '#3f3f46', // surface.active
          hover: '#27272a', // generic hover surface
          highlight: '#3f3f46', // emphasized hover/selection
          backdrop: 'rgba(9, 9, 11, 0.8)', // modal backdrop
          input: '#18181b', // surface.panel
          key: '#3f3f46', // keyboard hint background
          border: '#3f3f46', // border.default
          text: '#e4e4e7', // text.primary
          'text-muted': '#a1a1aa', // text.secondary
          'text-secondary': '#a1a1aa', // text.secondary alias
        },

        // Semantic Surface System (Elevation & Role)
        surface: {
          base: '#09090b', // App Background (Zinc-950)
          panel: '#18181b', // Secondary Background (Zinc-900)
          elevated: '#27272a', // Cards / Popovers (Zinc-800)
          active: '#3f3f46', // Active/Selected States (Zinc-700)
          highest: '#52525b', // Hover/Highest surface (Zinc-600)
          overlay: 'rgba(9, 9, 11, 0.8)', // Modal Backdrop
        },

        // Semantic Text System
        text: {
          primary: '#e4e4e7', // High Emphasis (Zinc-200) - Not pure white to reduce glare
          secondary: '#a1a1aa', // Medium Emphasis (Zinc-400)
          muted: '#52525b', // Disabled/Watermarks (Zinc-600)
          inverted: '#09090b', // Text on bright backgrounds
        },

        // Semantic Border System
        border: {
          subtle: '#27272a', // Dividers (Zinc-800)
          default: '#3f3f46', // Input borders (Zinc-700)
          strong: '#52525b', // Active borders (Zinc-600)
          focus: '#0ea5e9', // Focus rings (Primary-500)
        },

        // Accent aliases (used by UI primitives)
        accent: {
          primary: '#0ea5e9',
          success: '#22c55e',
          warning: '#f59e0b',
          error: '#ef4444',
          info: '#3b82f6',
        },

        // ---------------------------------------------------------------------
        // Professional Video Editing Domain Colors
        // ---------------------------------------------------------------------

        timeline: {
          track: {
            bg: '#121214', // Track background
            video: '#1e293b', // Slate-800 tint
            audio: '#14532d', // Emerald-900 tint
          },
          clip: {
            video: {
              base: '#3b82f6', // Blue-500
              hover: '#60a5fa', // Blue-400
              selected: '#2563eb', // Blue-600
            },
            audio: {
              base: '#10b981', // Emerald-500
              hover: '#34d399', // Emerald-400
              selected: '#059669', // Emerald-600
            },
            caption: {
              base: '#f59e0b', // Amber-500
            },
          },
          playhead: {
            line: '#ef4444', // Red-500
            knob: '#ef4444', // Red-500
          },
          grid: '#27272a', // Zinc-800
        },

        // Avid/Premiere-style Edit Modes
        edit: {
          ripple: '#facc15', // Yellow-400
          roll: '#ef4444', // Red-500
          slip: '#22d3ee', // Cyan-400
          slide: '#c084fc', // Purple-500
          razor: '#e879f9', // Fuchsia-400
        },

        // Status Indicators
        status: {
          success: '#22c55e', // Green-500
          warning: '#f59e0b', // Amber-500
          error: '#ef4444', // Red-500
          info: '#3b82f6', // Blue-500
        },
      },

      // Typography - Optimized for UI density
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.75rem' }], // 10px - for timeline labels
        xs: ['0.75rem', { lineHeight: '1rem' }], // 12px
        sm: ['0.875rem', { lineHeight: '1.25rem' }], // 14px
        base: ['1rem', { lineHeight: '1.5rem' }], // 16px
        lg: ['1.125rem', { lineHeight: '1.75rem' }], // 18px
      },

      // Animation Durations
      transitionDuration: {
        instant: '50ms',
        fast: '100ms',
        normal: '200ms',
        slow: '300ms',
        50: '50ms',
        250: '250ms',
        400: '400ms',
      },

      // Z-Index Layers (Systematic)
      zIndex: {
        timeline: '10',
        panel: '20',
        header: '30',
        dropdown: '40',
        modal: '50',
        toast: '60',
        tooltip: '70',
        cursor: '100', // Custom cursor must be top
      },
    },
  },
  plugins: [],
};
