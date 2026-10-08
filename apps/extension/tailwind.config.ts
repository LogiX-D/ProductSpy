import type { Config } from 'tailwindcss';

export default {
  content: ['./popup.html', './src/popup/**/*.{ts,tsx}'],
  theme: { extend: { colors: { accent: '#0d766e' } } },
  plugins: [],
} satisfies Config;
