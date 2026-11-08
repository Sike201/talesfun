import { Geist, Fraunces } from "next/font/google";

export const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
});

export const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  axes: ["SOFT", "WONK", "opsz"],
  display: "swap",
});
