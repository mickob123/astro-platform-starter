/** @type {import('tailwindcss').Config} */
const colors = require('tailwindcss/colors');
const defaultTheme = require('tailwindcss/defaultTheme');
const fs = require('fs');

const noiseBitmap = fs.readFileSync('./src/assets/noise.png', { encoding: 'base64' });
const noiseDataUri = 'data:image/png;base64,' + noiseBitmap;

export default {
    content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
    theme: {
        extend: {
            backgroundImage: {
                'grid-pattern': `linear-gradient(to bottom, theme('colors.neutral.950 / 0%'), theme('colors.neutral.950 / 100%')), url('${noiseDataUri}')`
            },
            colors: {
                neutral: colors.neutral,
                vault: '#0C1220',
                ledger: '#F7F5F0',
                'agent-indigo': '#6C5CE7',
                'indigo-hover': '#A29BFE',
                mint: '#00C9A7',
                amber: '#FFB020',
                coral: '#FF6B6B',
                steel: '#6B7280',
                fog: '#D1D5DB',
                cloud: '#F9FAFB',
            },
            fontFamily: {
                sans: ['"Plus Jakarta Sans"', ...defaultTheme.fontFamily.sans],
                mono: ['"IBM Plex Mono"', ...defaultTheme.fontFamily.mono],
            },
            maxWidth: {
                'content': '1200px',
            },
            boxShadow: {
                'docubot-xs': '0 1px 2px rgba(12, 18, 32, 0.04)',
                'docubot': '0 1px 4px rgba(12, 18, 32, 0.06), 0 1px 2px rgba(12, 18, 32, 0.04)',
                'docubot-md': '0 4px 12px rgba(12, 18, 32, 0.08)',
                'docubot-lg': '0 8px 24px rgba(12, 18, 32, 0.10)',
            },
        }
    },
    daisyui: {
        themes: [
            {
                docubot: {
                    'primary': '#6C5CE7',
                    'primary-focus': '#5A4BD6',
                    'primary-content': '#FFFFFF',
                    'secondary': '#6B7280',
                    'secondary-content': '#FFFFFF',
                    'accent': '#6C5CE7',
                    'accent-content': '#FFFFFF',
                    'neutral': '#0C1220',
                    'neutral-content': '#F7F5F0',
                    'base-100': '#FFFFFF',
                    'base-200': '#F7F5F0',
                    'base-300': '#F9FAFB',
                    'base-content': '#1F2937',
                    'info': '#6C5CE7',
                    'info-content': '#FFFFFF',
                    'success': '#00C9A7',
                    'success-content': '#FFFFFF',
                    'warning': '#FFB020',
                    'warning-content': '#1F2937',
                    'error': '#FF6B6B',
                    'error-content': '#FFFFFF',
                    '--rounded-box': '12px',
                    '--rounded-btn': '8px',
                    '--rounded-badge': '9999px',
                    '--tab-radius': '8px',
                    '--btn-text-case': 'none',
                },
            },
        ],
    },
    plugins: [require('daisyui')]
};
