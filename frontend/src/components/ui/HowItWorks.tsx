"use client";

import { useRef } from "react";
import { motion, useInView } from "framer-motion";

const steps = [
  {
    n: "01",
    label: "Launch",
    desc: "Deploy your token with a fixed 10 million supply. Mint authority is automatically revoked on graduation, with clean tokenomics from day one.",
    icon: (
      <span className="text-[1.75rem] leading-none select-none" role="img" aria-label="Rocket">
        🚀
      </span>
    ),
  },
  {
    n: "02",
    label: "Fund",
    desc: "The community contributes SOL together on a fair bonding curve. No presale. No dev bags. True community-powered launch.",
    icon: (
      <span className="text-[1.75rem] leading-none select-none" role="img" aria-label="Cash">
        💵
      </span>
    ),
  },
  {
    n: "03",
    label: "Graduate",
    desc: "Once the target is reached, your token auto-migrates to a full Omnipair GAMM pool. Instantly unlocks institutional-grade DeFi, all in one unified pool.",
    icon: (
      <span className="text-[1.75rem] leading-none select-none" role="img" aria-label="Chart with upward trend">
        📈
      </span>
    ),
  },
  {
    n: "04",
    label: "Earn & Thrive",
    desc: "Creators earn 0.5% perpetual royalties on every swap, forever. Holders gain real utility: borrow, leverage, provide liquidity, and earn yield.",
    icon: (
      <span className="text-[1.75rem] leading-none select-none" role="img" aria-label="Plant growth">
        🌱
      </span>
    ),
  },
];

function StepCard({ step, index }: { step: typeof steps[0]; index: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 40 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.6, delay: index * 0.12, ease: [0.25, 1, 0.5, 1] }}
      className="relative"
    >
      <div className="flex gap-6 sm:gap-8">
        {/* Timeline spine */}
        <div className="flex flex-col items-center flex-shrink-0">
          <motion.div
            initial={{ scale: 0.5, opacity: 0 }}
            animate={isInView ? { scale: 1, opacity: 1 } : {}}
            transition={{ duration: 0.5, delay: index * 0.12 + 0.15, ease: [0.34, 1.56, 0.64, 1] }}
            className="w-14 h-14 rounded-2xl flex items-center justify-center text-gray-900 relative overflow-hidden bg-[rgba(175,145,90,0.1)]"
          >
            <div className="w-8 h-8 relative z-10 flex items-center justify-center grayscale">{step.icon}</div>
          </motion.div>
          {index < steps.length - 1 && (
            <motion.div
              initial={{ scaleY: 0 }}
              animate={isInView ? { scaleY: 1 } : {}}
              transition={{ duration: 0.6, delay: index * 0.12 + 0.3 }}
              className="w-px flex-1 min-h-[40px] origin-top"
              style={{ background: "linear-gradient(to bottom, #E5E7EB, transparent)" }}
            />
          )}
        </div>

        {/* Content */}
        <div className="pb-10 pt-1">
          <div className="flex items-baseline gap-3 mb-2">
            <span className="text-xs font-semibold tracking-wider text-gray-300 tabular-nums">{step.n}</span>
            <h3 className="text-lg font-bold text-gray-900">
              {step.label}
            </h3>
          </div>
          <p className="text-sm text-gray-500 leading-relaxed max-w-md">
            {step.desc}
          </p>
        </div>
      </div>
    </motion.div>
  );
}

export default function HowItWorks() {
  const headerRef = useRef<HTMLDivElement>(null);
  const headerInView = useInView(headerRef, { once: true, margin: "-40px" });

  return (
    <section className="mb-20">
      <motion.div
        ref={headerRef}
        initial={{ opacity: 0, y: 20 }}
        animate={headerInView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.6, ease: [0.25, 1, 0.5, 1] }}
        className="mb-10"
      >
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">How It Works</p>
      </motion.div>

      <div className="relative">
        {steps.map((step, i) => (
          <StepCard key={step.n} step={step} index={i} />
        ))}
      </div>
    </section>
  );
}
