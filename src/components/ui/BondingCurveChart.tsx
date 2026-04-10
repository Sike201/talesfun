"use client";

import { useMemo } from "react";

interface Props {
  solRaised: number;
  targetSOL: number;
  tokensSold: number;
  totalSupply: number;
}

export default function BondingCurveChart({ solRaised, targetSOL, tokensSold, totalSupply }: Props) {
  const points = useMemo(() => {
    const steps = 100;
    const result: { x: number; y: number }[] = [];
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      result.push({ x: i, y: f * f });
    }
    return result;
  }, []);

  const currentStep = Math.floor((tokensSold / totalSupply) * 100);
  const W = 400, H = 120, P = 8;

  const sx = (x: number) => P + (x / 100) * (W - 2 * P);
  const sy = (y: number) => H - P - y * (H - 2 * P);

  const fullPath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(" ");
  const soldPath = points.filter(p => p.x <= currentStep).map((p, i) => `${i === 0 ? "M" : "L"} ${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(" ");
  const areaPath = soldPath + ` L ${sx(currentStep).toFixed(1)} ${sy(0)} L ${sx(0)} ${sy(0)} Z`;

  return (
    <div className="w-full bg-gray-50 rounded-xl p-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22C55E" stopOpacity="0.15" />
            <stop offset="100%" stopColor="#22C55E" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map(y => (
          <line key={y} x1={P} y1={sy(y)} x2={W - P} y2={sy(y)} stroke="#E5E7EB" strokeWidth="0.5" />
        ))}
        <path d={areaPath} fill="url(#areaFill)" />
        <path d={fullPath} fill="none" stroke="#E5E7EB" strokeWidth="1" strokeDasharray="3 3" />
        {currentStep > 0 && <path d={soldPath} fill="none" stroke="#22C55E" strokeWidth="2" strokeLinecap="round" />}
        {currentStep > 0 && currentStep < 100 && (() => {
          const cp = points[currentStep];
          return <circle cx={sx(cp.x)} cy={sy(cp.y)} r="4" fill="#22C55E" stroke="white" strokeWidth="2" />;
        })()}
      </svg>
      <div className="flex justify-between text-[10px] text-gray-400 mt-1 px-1">
        <span>0 SOL</span>
        <span className="text-green-600 font-medium">{solRaised.toFixed(1)} SOL</span>
        <span>{targetSOL} SOL</span>
      </div>
    </div>
  );
}
