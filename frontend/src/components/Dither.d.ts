import type { CSSProperties } from "react";

declare const Dither: React.FC<{
  waveColor?: string | [number, number, number];
  backgroundColor?: string | [number, number, number] | "transparent";
  ditherMode?: string;
  colorNum?: number;
  pixelSize?: number;
  waveSpeed?: number;
  waveFrequency?: number;
  waveAmplitude?: number;
  mouseEffect?: string;
  mouseRadius?: number;
  enableMouseInteraction?: boolean;
  brightness?: number;
  contrast?: number;
  scale?: number;
  intro?: boolean;
  className?: string;
  style?: CSSProperties;
}>;

export default Dither;
