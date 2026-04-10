import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";

export const metadata = {
  title: "Writing — higher.run",
  description: "Articles and research on the Higher.run protocol, on-chain capital markets, and the future of token launches.",
};

export default function WritingPage() {
  return (
    <div className="max-w-2xl mx-auto px-8 py-16">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-10">Recent Writing</p>

      <div className="space-y-px">
        {/* Article 1 */}
        <article className="rounded-lg overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,0.06),0_0_0_1px_rgba(0,0,0,0.04)] bg-white">
          {/* Dark header image area */}
          <div className="bg-gray-950 flex items-center justify-center h-44">
            <span className="text-white text-4xl font-extrabold tracking-tight select-none">higher.run</span>
          </div>
          {/* Article body */}
          <div className="px-6 py-5">
            <div className="flex items-start justify-between gap-4 mb-3">
              <h2 className="text-base font-bold text-gray-900 leading-snug">
                The Higher.run Protocol: On-Chain Capital Markets for Every Token
              </h2>
              <ArrowUpRight size={16} className="text-gray-400 flex-shrink-0 mt-0.5" />
            </div>
            <p className="text-sm text-gray-500 italic leading-relaxed mb-4">
              "A token that can be borrowed against, leveraged, and shorted on day one is no longer just
              a speculative asset — it's a financial instrument."
            </p>
            <p className="text-xs text-gray-400">
              higher.run Research&nbsp;/&nbsp;Protocol Overview&nbsp;/&nbsp;Apr 2026
            </p>
          </div>
        </article>
      </div>

      {/* Full article content */}
      <div className="mt-16 space-y-10">
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Introduction</p>
          <h1 className="text-3xl font-extrabold text-gray-900 leading-tight mb-4">
            The Higher.run Protocol: On-Chain Capital Markets for Every Token
          </h1>
          <p className="text-sm text-gray-500 mb-6">
            higher.run Research&nbsp;·&nbsp;Protocol Overview&nbsp;·&nbsp;April 2026
          </p>
          <p className="text-base text-gray-700 leading-relaxed">
            Most token launches end at the launch. A bonding curve fills, the token migrates to a DEX,
            and liquidity fragments across a dozen protocols. Holders are left with a speculative asset
            and no productive use for their capital. Higher.run was built to change that.
          </p>
        </div>

        <div>
          <h2 className="text-xl font-bold text-gray-900 mb-3">What is Higher.run?</h2>
          <p className="text-base text-gray-700 leading-relaxed mb-4">
            Higher.run is a DeFi-native incubation launchpad on Solana. It lets anyone deploy a token
            with a fixed 10 million supply, raise community capital through a transparent bonding curve,
            and automatically graduate into a full Omnipair GAMM pool — all without writing a single
            line of code.
          </p>
          <p className="text-base text-gray-700 leading-relaxed">
            The result is not just a traded token. It is a capital markets instrument with spot trading,
            collateralised borrowing, leveraged positions, and native short selling — live from the
            moment the curve graduates.
          </p>
        </div>

        <div>
          <h2 className="text-xl font-bold text-gray-900 mb-3">The Bonding Curve Phase</h2>
          <p className="text-base text-gray-700 leading-relaxed mb-4">
            Every token on Higher.run starts on an automated bonding curve. There are no presales,
            no private allocations, and no insider advantage. The curve prices tokens algorithmically:
            as more SOL flows in, the price rises. When the target is reached, the raise closes
            automatically.
          </p>
          <p className="text-base text-gray-700 leading-relaxed">
            Mint authority is revoked permanently at graduation, locking the 10M supply forever.
            No inflation. No dilution. No rug.
          </p>
        </div>

        <div>
          <h2 className="text-xl font-bold text-gray-900 mb-3">Graduation: The Omnipair GAMM Pool</h2>
          <p className="text-base text-gray-700 leading-relaxed mb-4">
            Once the bonding curve target is reached, the raised SOL and a portion of the token supply
            are automatically seeded into a new Omnipair GAMM pool. This is not a simple AMM swap pool.
            It is a generalised automated market maker that collapses spot trading, lending, borrowing,
            leverage, and liquidity provision into a single unified pool per token.
          </p>
          <p className="text-base text-gray-700 leading-relaxed">
            No external lending markets. No separate perpetuals protocol. No oracle dependencies.
            Everything happens within the same isolated pool.
          </p>
        </div>

        <div>
          <h2 className="text-xl font-bold text-gray-900 mb-3">Borrow Against Your Tokens</h2>
          <p className="text-base text-gray-700 leading-relaxed mb-4">
            One of the most important primitives Higher.run unlocks is non-liquidating capital access.
            Holders can deposit their tokens as collateral and borrow SOL or USDC directly from the
            GAMM pool — without selling a single token.
          </p>
          <p className="text-base text-gray-700 leading-relaxed">
            This eliminates forced selling pressure. Believers in a project can access liquidity
            without abandoning their position. It is the same logic as a margin loan against a stock
            portfolio, applied natively to any token on Solana.
          </p>
        </div>

        <div>
          <h2 className="text-xl font-bold text-gray-900 mb-3">Leverage and Short Selling</h2>
          <p className="text-base text-gray-700 leading-relaxed mb-4">
            Through recursive borrowing, the GAMM pool supports leveraged long positions. A holder
            deposits tokens, borrows SOL, swaps that SOL for more tokens, and repeats — amplifying
            their exposure to 2x, 3x, or higher within the same pool.
          </p>
          <p className="text-base text-gray-700 leading-relaxed">
            Short selling follows the inverse path: deposit SOL as collateral, borrow the token,
            sell into the pool. If the price falls, buy back cheaper and return the tokens. Full
            short capability with isolated, per-pool risk.
          </p>
        </div>

        <div>
          <h2 className="text-xl font-bold text-gray-900 mb-3">Perpetual Creator Royalties</h2>
          <p className="text-base text-gray-700 leading-relaxed mb-4">
            Every swap in the GAMM pool carries a 1% fee. Half goes to liquidity providers.
            Half goes to the token creator — forever. This is not a one-time minting fee. It is
            a perpetual royalty stream tied to the ongoing economic activity of the token.
          </p>
          <p className="text-base text-gray-700 leading-relaxed">
            For creators, this changes the incentive structure entirely. The longer the token
            remains active and liquid, the more the creator earns.
          </p>
        </div>

        <div>
          <h2 className="text-xl font-bold text-gray-900 mb-3">The Bigger Picture</h2>
          <p className="text-base text-gray-700 leading-relaxed mb-4">
            TradFi has spent decades building infrastructure for capital formation: IPOs, secondary
            markets, margin lending, derivatives. DeFi has the primitives to replicate all of this
            — but they are fragmented across dozens of protocols, each with their own liquidity pools,
            risk parameters, and UX barriers.
          </p>
          <p className="text-base text-gray-700 leading-relaxed">
            Higher.run compresses the entire stack into a single, opinionated launchpad. Launch an
            idea. Make it liquid. Let the market decide its value — and give every participant the
            full suite of financial tools to express their conviction.
          </p>
        </div>

        <div className="pt-4 border-t border-gray-100">
          <p className="text-xs text-gray-400">
            One unified pool per token. Isolated risk. Capital efficient. No oracles. No fragmentation.
          </p>
        </div>
      </div>

      <div className="mt-16">
        <Link href="/" className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-gray-700 transition-colors">
          <ArrowLeft size={14} /> Back to higher.run
        </Link>
      </div>
    </div>
  );
}
