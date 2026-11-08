import { formatUSD } from "@/lib/utils";

export function lamportsStrToSol(lamportsStr: string | undefined): number {
  if (lamportsStr == null || lamportsStr === "") return 0;
  try {
    return Number(BigInt(lamportsStr.trim())) / 1e9;
  } catch {
    return 0;
  }
}

/** 24h volume in USD from summed lamports + SOL/USD rate; `$0.00` when no rate or no volume. */
export function volume24hUsdFormatted(
  lamportsStr: string | undefined,
  solUsd: number | null | undefined
): string {
  const sol = lamportsStrToSol(lamportsStr);
  if (typeof solUsd === "number" && solUsd > 0) {
    return formatUSD(sol * solUsd);
  }
  return "$0.00";
}
