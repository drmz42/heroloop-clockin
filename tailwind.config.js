/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        px: {
          bg:      '#0c0800',
          panel:   '#1a1005',
          panel2:  '#241808',
          border:  '#5c3f08',
          gold:    '#c8840e',
          bright:  '#f5c518',
          text:    '#f0d060',
          dim:     '#8a6428',
          orange:  '#e87a00',
          red:     '#c02010',
          green:   '#3a8a28',
          purple:  '#7040b8',
          teal:    '#2a8870',
        },
      },
      fontFamily: {
        pixel: ['"Press Start 2P"', 'monospace'],
        vt:    ['"VT323"', '"Courier New"', 'monospace'],
        mono:  ['"Courier New"', 'Courier', 'monospace'],
      },
      boxShadow: {
        'px':     '4px 4px 0 #3d2008',
        'px-sm':  '2px 2px 0 #3d2008',
        'px-in':  'inset 2px 2px 0 rgba(0,0,0,0.5)',
        'px-gold':'4px 4px 0 #8a5808',
        'px-active': '1px 1px 0 #3d2008',
      },
      backgroundImage: {
        'px-btn': 'linear-gradient(180deg, #4a2e08 0%, #2e1c04 100%)',
        'px-btn-hover': 'linear-gradient(180deg, #5a3810 0%, #3a2408 100%)',
        'px-hero': 'linear-gradient(180deg, #241808 0%, #100c02 100%)',
        'scanlines': 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.15) 2px, rgba(0,0,0,0.15) 4px)',
      },
      animation: {
        'jitter': 'jitter 0.15s steps(2) infinite',
        'bounce-px': 'bounce-px 0.6s cubic-bezier(0.36, 0.07, 0.19, 0.97)',
        'scanline': 'scanline 8s linear infinite',
        'flicker': 'flicker 4s ease-in-out infinite',
        'pixel-glow': 'pixel-glow 1.5s ease-in-out infinite',
        'press': 'press 0.1s ease-out',
      },
      keyframes: {
        jitter: {
          '0%,100%': { transform: 'translate(0,0)' },
          '25%': { transform: 'translate(1px,-1px)' },
          '75%': { transform: 'translate(-1px,1px)' },
        },
        'bounce-px': {
          '0%,100%': { transform: 'scale(1)' },
          '40%': { transform: 'scale(1.18) translateY(-4px)' },
          '70%': { transform: 'scale(0.95) translateY(2px)' },
        },
        scanline: {
          '0%': { backgroundPosition: '0 0' },
          '100%': { backgroundPosition: '0 400px' },
        },
        flicker: {
          '0%,97%,100%': { opacity: '1' },
          '98%': { opacity: '0.85' },
          '99%': { opacity: '0.95' },
        },
        'pixel-glow': {
          '0%,100%': { boxShadow: '0 0 8px 2px rgba(200,132,14,0.5), 4px 4px 0 #3d2008' },
          '50%': { boxShadow: '0 0 16px 4px rgba(245,197,24,0.7), 4px 4px 0 #3d2008' },
        },
        press: {
          '0%': { transform: 'translate(0,0)' },
          '50%': { transform: 'translate(2px,2px)' },
          '100%': { transform: 'translate(0,0)' },
        },
      },
    },
  },
  plugins: [],
};
