"use client";

import { useRef } from "react";
import { motion, useInView } from "framer-motion";

const capabilities = [
  {
    title: "Spot Trading",
    desc: "Deep, instant on-chain liquidity. No orderbook required.",
    icon: (
      <svg viewBox="0 0 32 32" fill="none" className="w-full h-full">
        <path d="M6 22l6-8 5 4 9-12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="26" cy="6" r="2.5" fill="currentColor" opacity="0.2" />
      </svg>
    ),
    accent: "from-teal-500/10 to-teal-500/0",
  },
  {
    title: "Borrow Without Selling",
    desc: "Deposit tokens as collateral and borrow SOL or USDC — keep your bags, access liquidity.",
    icon: (
      <svg viewBox="0 0 32 32" fill="none" className="w-full h-full">
        <rect x="6" y="10" width="20" height="14" rx="3" stroke="currentColor" strokeWidth="1.5" opacity="0.4" />
        <circle cx="16" cy="17" r="4" stroke="currentColor" strokeWidth="1.5" />
        <path d="M14 17h4M16 15v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M10 10V8a6 6 0 0112 0v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
    accent: "from-amber-500/10 to-amber-500/0",
  },
  {
    title: "Leveraged Long",
    desc: "Amplify your position up to multiple x inside the pool. No external margin protocol.",
    icon: (
      <svg viewBox="0 0 32 32" fill="none" className="w-full h-full">
        <path d="M8 24l8-16 8 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.3" />
        <path d="M10 20l6-12 6 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <text x="13" y="18" fontSize="6" fontWeight="700" fill="currentColor" opacity="0.5">x</text>
      </svg>
    ),
    accent: "from-emerald-500/10 to-emerald-500/0",
  },
  {
    title: "Short Selling",
    desc: "Native short capability — borrow the token, sell into the pool, and profit from downside.",
    icon: (
      <svg viewBox="0 0 32 32" fill="none" className="w-full h-full">
        <path d="M6 8l6 8 5-4 9 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="26" cy="24" r="2.5" fill="currentColor" opacity="0.2" />
      </svg>
    ),
    accent: "from-rose-500/10 to-rose-500/0",
  },
  {
    title: "Supply & Earn",
    desc: "Provide liquidity and collect swap fees, lending interest, and creator royalty distributions.",
    icon: (
      <svg viewBox="0 0 32 32" fill="none" className="w-full h-full">
        <circle cx="16" cy="16" r="10" stroke="currentColor" strokeWidth="1.5" opacity="0.2" />
        <circle cx="16" cy="16" r="5" stroke="currentColor" strokeWidth="1.5" opacity="0.4" />
        <path d="M16 6v4M16 22v4M6 16h4M22 16h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.3" />
        <circle cx="16" cy="16" r="1.5" fill="currentColor" opacity="0.5" />
      </svg>
    ),
    accent: "from-violet-500/10 to-violet-500/0",
  },
];

function CapabilityCard({ item, index }: { item: typeof capabilities[0]; index: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-40px" });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 30 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5, delay: index * 0.08, ease: [0.25, 1, 0.5, 1] }}
      className="group relative"
    >
      <div className="relative rounded-xl bg-white p-6 h-full overflow-hidden transition-all duration-300 hover:shadow-md hover:-translate-y-0.5">
        <div className={`absolute inset-0 bg-gradient-to-br ${item.accent} opacity-0 group-hover:opacity-100 transition-opacity duration-500`} />

        <div className="relative z-10">
          <div className="w-10 h-10 mb-4 text-gray-900 transition-transform duration-300 group-hover:scale-110">
            {item.icon}
          </div>
          <h3 className="text-sm font-bold text-gray-900 mb-1.5">{item.title}</h3>
          <p className="text-sm text-gray-400 leading-relaxed">{item.desc}</p>
        </div>
      </div>
    </motion.div>
  );
}

export default function AfterGraduation() {
  const headerRef = useRef<HTMLDivElement>(null);
  const headerInView = useInView(headerRef, { once: true, margin: "-40px" });
  const closingRef = useRef<HTMLDivElement>(null);
  const closingInView = useInView(closingRef, { once: true, margin: "-40px" });

  return (
    <section className="mb-20">
      <motion.div
        ref={headerRef}
        initial={{ opacity: 0, y: 20 }}
        animate={headerInView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.6, ease: [0.25, 1, 0.5, 1] }}
        className="mb-8"
      >
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">After Graduation</p>
        <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-2 max-w-lg">
          Once it graduates, your token becomes a real capital markets instrument.
        </h2>
      </motion.div>

      <div className="grid sm:grid-cols-2 gap-3 mb-3">
        {capabilities.slice(0, 2).map((item, i) => (
          <CapabilityCard key={item.title} item={item} index={i} />
        ))}
      </div>
      <div className="grid sm:grid-cols-3 gap-3 mb-8">
        {capabilities.slice(2).map((item, i) => (
          <CapabilityCard key={item.title} item={item} index={i + 2} />
        ))}
      </div>

      <motion.div
        ref={closingRef}
        initial={{ opacity: 0, y: 16 }}
        animate={closingInView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.6, delay: 0.2 }}
        className="text-center py-6"
      >
        <p className="text-sm text-gray-400 leading-relaxed max-w-md mx-auto">
          One unified Omnipair GAMM pool per token.
          <br />
          <span className="text-gray-500">Isolated risk. Capital efficient. No oracles. No fragmentation.</span>
          <br />
          <span className="font-semibold text-gray-900 text-base mt-1 inline-block">Just higher utility.</span>
        </p>
      </motion.div>
    </section>
  );
}
