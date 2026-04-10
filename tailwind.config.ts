import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        teal: {
          DEFAULT: "#00D4C8",
          dark: "#00B5AA",
          light: "#E0FAF9",
          50: "#F0FFFE",
          100: "#E0FAF9",
          200: "#B3F4F1",
          300: "#66E8E3",
          400: "#00D4C8",
          500: "#00B5AA",
          600: "#009690",
          700: "#007A75",
          800: "#005E5A",
          900: "#003D3A",
        },
        cream: "#FAFAF8",
        navy: {
          DEFAULT: "#0D1B2A",
          mid: "#1A2E42",
          light: "#2D4A65",
        },
        gold: {
          DEFAULT: "#F5C842",
          light: "#FEF3C7",
          dark: "#D4A017",
        },
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "monospace"],
      },
      borderRadius: {
        "2xl": "16px",
        "3xl": "24px",
        "4xl": "32px",
      },
      boxShadow: {
        card: "0 4px 24px rgba(13, 27, 42, 0.08)",
        "card-hover": "0 12px 40px rgba(0, 212, 200, 0.15)",
        teal: "0 4px 20px rgba(0, 212, 200, 0.3)",
        "teal-lg": "0 8px 40px rgba(0, 212, 200, 0.4)",
      },
      backgroundImage: {
        "gradient-teal": "linear-gradient(135deg, #00D4C8 0%, #00B5AA 100%)",
        "gradient-hero": "linear-gradient(135deg, #F0FFFE 0%, #FAFAF8 50%, #FEF3C7 100%)",
        "gradient-card": "linear-gradient(145deg, #FFFFFF 0%, #F7FFFE 100%)",
      },
      animation: {
        "fade-in": "fadeIn 0.5s ease-in-out",
        "slide-up": "slideUp 0.4s ease-out",
        "float": "float 6s ease-in-out infinite",
      },
      keyframes: {
        fadeIn: { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        slideUp: { "0%": { transform: "translateY(20px)", opacity: "0" }, "100%": { transform: "translateY(0)", opacity: "1" } },
        float: { "0%, 100%": { transform: "translateY(0px)" }, "50%": { transform: "translateY(-10px)" } },
      },
    },
  },
  plugins: [],
};

export default config;
