import { cn } from "@/lib/utils";

type DotGridProps = {
  className?: string;
  /** Dot color as CSS color */
  dot?: string;
  gap?: number;
  fade?: "radial" | "vertical" | "none";
};

export default function DotGrid({
  className,
  dot = "rgba(255,255,255,0.14)",
  gap = 14,
  fade = "radial",
}: DotGridProps) {
  const mask =
    fade === "radial"
      ? "radial-gradient(ellipse 85% 75% at 50% 45%, black 15%, transparent 72%)"
      : fade === "vertical"
        ? "linear-gradient(to bottom, transparent, black 8%, black 92%, transparent)"
        : undefined;

  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute inset-0", className)}
      style={{
        backgroundImage: `radial-gradient(circle, ${dot} 1px, transparent 1px)`,
        backgroundSize: `${gap}px ${gap}px`,
        WebkitMaskImage: mask,
        maskImage: mask,
      }}
    />
  );
}