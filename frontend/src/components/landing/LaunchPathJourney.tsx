"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence, useMotionValue, useTransform, animate } from "framer-motion";
import { GRADUATION_SOL } from "@/types";
import { cn } from "@/lib/utils";

type Phase = "bonding" | "graduated";

type Props = {
  /** Shorter hero strip for top of launch page */
  compact?: boolean;
};

export default function LaunchPathJourney({ compact = false }: Props) {
  const [phase, setPhase] = useState<Phase>("bonding");
  const [loop, setLoop] = useState(0);
  const progress = useMotionValue(0);
  const solLabel = useTransform(progress, v => `${Math.round(v)} SOL`);
  const pct = useTransform(progress, v => `${Math.min(100, (v / GRADUATION_SOL) * 100)}%`);

  useEffect(() => {
    setPhase("bonding");
    progress.set(0);
    const controls = animate(progress, GRADUATION_SOL, {
      duration: 4.2,
      ease: [0.22, 1, 0.36, 1],
      onComplete: () => {
        setPhase("graduated");
        window.setTimeout(() => setLoop(n => n + 1), 3200);
      },
    });
    return () => controls.stop();
  }, [loop, progress]);

  return (
    <section className="space-y-4">
      <div
        className="relative overflow-hidden rounded-[1.25rem]"
        style={{ minHeight: compact ? 240 : 340 }}
      >
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            backgroundImage: "url(/process-banner.png)",
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        />
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.55) 55%, rgba(0,0,0,0.78) 100%)",
          }}
        />

        <div
          className={cn(
            "relative z-[1] flex h-full flex-col justify-between p-5 sm:p-7",
            compact ? "min-h-[240px]" : "min-h-[340px]"
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/45">
                The path
              </p>
              <h2
                className="font-fraunces mt-2 max-w-sm text-[1.55rem] font-medium leading-tight tracking-[-0.03em] text-white"
                style={{
                  fontFamily:
                    "var(--font-fraunces), Fraunces, ui-serif, Georgia, serif",
                  fontVariationSettings: '"SOFT" 55, "WONK" 1, "opsz" 120',
                }}
              >
                {phase === "bonding"
                  ? "Bonding curve to graduation"
                  : "Graduated into the GAMM pool"}
              </h2>
            </div>
            <div className="rounded-full bg-black/45 px-3 py-1.5 text-sm font-semibold tabular-nums text-white backdrop-blur-sm">
              <AnimatePresence mode="wait">
                {phase === "bonding" ? (
                  <motion.span
                    key="sol"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                  >
                    <motion.span>{solLabel}</motion.span>
                    <span className="text-white/40"> / {GRADUATION_SOL}</span>
                  </motion.span>
                ) : (
                  <motion.span
                    key="gamm"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="text-[#c8e6ff]"
                  >
                    GAMM live
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between text-[11px] text-white/45">
              <span>0 SOL</span>
              <span>{GRADUATION_SOL} SOL · graduate</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
              <motion.div
                className="h-full rounded-full"
                style={{
                  width: pct,
                  background:
                    phase === "graduated"
                      ? "linear-gradient(90deg, #93c5fd, #e2e8f0)"
                      : "linear-gradient(90deg, #fbbf24, #fde68a)",
                }}
              />
            </div>

            <AnimatePresence mode="wait">
              {phase === "bonding" ? (
                <motion.p
                  key="bond-copy"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="mt-3 max-w-md text-sm leading-relaxed text-white/65"
                >
                  Raise from 0 to {GRADUATION_SOL} SOL on the curve. Fair launch,
                  fixed supply — then the market opens.
                </motion.p>
              ) : (
                <motion.div
                  key="gamm-copy"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="mt-3"
                >
                  <p className="max-w-md text-sm leading-relaxed text-white/70">
                    Liquidity migrates into Omnipair&apos;s GAMM pool. Traders get
                    leverage built in.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {["Long", "Short", "Borrow"].map((label, i) => (
                      <motion.span
                        key={label}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.12 * i }}
                        className={cn(
                          "rounded-full px-3 py-1 text-xs font-semibold",
                          label === "Long" &&
                            "bg-emerald-400/15 text-emerald-300",
                          label === "Short" && "bg-rose-400/15 text-rose-300",
                          label === "Borrow" && "bg-sky-400/15 text-sky-300"
                        )}
                      >
                        {label}
                      </motion.span>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {!compact ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            {
              step: "01",
              title: "0 → curve",
              body: "Launch on a bonding curve with fixed supply.",
              active: phase === "bonding",
            },
            {
              step: "02",
              title: `${GRADUATION_SOL} SOL`,
              body: "Hit the target and graduate off the curve.",
              active: phase === "bonding",
            },
            {
              step: "03",
              title: "GAMM pool",
              body: "Long, short, and borrow on Omnipair.",
              active: phase === "graduated",
            },
          ].map(item => (
            <div
              key={item.step}
              className={cn(
                "rounded-2xl p-4 transition-colors",
                item.active ? "bg-white/[0.07]" : "bg-white/[0.03]"
              )}
            >
              <p className="text-[11px] font-semibold tracking-wide text-white/35">
                {item.step}
              </p>
              <p className="mt-2 text-sm font-semibold text-white">{item.title}</p>
              <p className="mt-1.5 text-xs leading-relaxed text-white/45">
                {item.body}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
