"use client";

import { useId, useState, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { cn } from "@/lib/utils";

/** Compact “?” with hover/focus explanation — matches dark trading UI. */
export function FieldHint({
  text,
  className,
}: {
  text: ReactNode;
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <span
      className={cn("relative inline-flex shrink-0 align-middle", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <button
        type="button"
        aria-describedby={open ? id : undefined}
        aria-label="More info"
        className="inline-flex size-3.5 items-center justify-center rounded-full text-white/35 transition-colors hover:text-white/70 focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
      >
        <CircleHelp size={12} strokeWidth={2} />
      </button>
      {open ? (
        <span
          id={id}
          role="tooltip"
          className="absolute bottom-[calc(100%+6px)] left-1/2 z-40 w-52 -translate-x-1/2 rounded-lg border border-white/10 bg-[#141414] px-2.5 py-2 text-left text-[11px] font-normal leading-snug text-white/70 shadow-xl normal-case tracking-normal"
        >
          {text}
        </span>
      ) : null}
    </span>
  );
}

export function LabelWithHint({
  children,
  hint,
  className,
}: {
  children: ReactNode;
  hint: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {children}
      <FieldHint text={hint} />
    </span>
  );
}
