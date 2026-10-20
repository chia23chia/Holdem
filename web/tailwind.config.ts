import type { Config } from 'tailwindcss';

// Palette tokens (docs/AUDIT_2026-10-20.md U-1).
// Six primary colors evoking card-room / felt / brass rather than SaaS slate.
// Usage rules:
//   bg       — body background (replaces slate-950)
//   surface  — panels / cards / modals
//   felt     — poker-table center; `rail` is the surrounding wood frame
//   bone     — primary text (slightly warm, reduces screen glare in dim rooms)
//   brass    — pot amount / dealer button / primary CTA / hand-rank label
//   win/loss — reserved for "your turn / profit" and "fold / loss / timer <5s"
const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        bg: '#0F1613',
        surface: '#141C19',
        felt: '#1E6B4F',
        'felt-edge': '#0F4A36',
        rail: '#2B1A0F',
        bone: '#E8E0CF',
        brass: '#C9A961',
        win: '#58C58A',
        loss: '#D45656',
      },
    },
  },
  plugins: [],
};

export default config;
