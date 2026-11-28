import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { BN, type Program } from "@coral-xyz/anchor";
import { TOTAL_FEE_BPS } from "@/types";
import { priceSolFromRaw } from "@/lib/utils";
import {
  calculateSolOut,
  calculateTokensOut,
  getFeeEscrowPDA,
  getMintAuthorityPDA,
  getPlatformPDA,
  getSolVaultPDA,
  getTokenStatePDA,
} from "@/lib/program";
import {
  lamportsFromSolUiSafe,
  maxBuyGrossLamportsWithinInventory,
} from "@/lib/bondingCurveQuote";

export type BondingSwapFill = {
  signature: string;
  side: "buy" | "sell";
  sol_amount_raw: string;
  token_amount_raw: string;
  price_sol: number;
  timestamp: string;
};

type BondingProgram = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  methods: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  account: any;
};

/**
 * Execute a bonding-curve buy or sell via the launchpad program.
 * `amountUi` is SOL for buys and project tokens for sells.
 */
export async function sendBondingSwapTx(params: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: Program<any> | BondingProgram;
  mint: string;
  user: PublicKey;
  side: "buy" | "sell";
  amountUi: number;
  /** Optional override for sell raw amount (avoids float drift). */
  tokenAmountRaw?: string;
}): Promise<BondingSwapFill> {
  const { program, mint: mintStr, user, side, amountUi, tokenAmountRaw } =
    params;

  const mint = new PublicKey(mintStr);
  const [tokenState] = getTokenStatePDA(mint);
  const [solVault] = getSolVaultPDA(mint);
  const [feeEscrow] = getFeeEscrowPDA(mint);
  const [mintAuthority] = getMintAuthorityPDA(mint);
  const [platformPda] = getPlatformPDA();
  const tokenVault = getAssociatedTokenAddressSync(mint, solVault, true);
  const userTokenAccount = getAssociatedTokenAddressSync(mint, user, false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const platformRow = await (program.account as any).platformState.fetch(
    platformPda
  );
  const platformFeeRecipient = platformRow.feeRecipient as PublicKey;

  const tradeAccounts = {
    tokenState,
    mint,
    solVault,
    tokenVault,
    userTokenAccount,
    user,
    feeEscrow,
    mintAuthority,
    platform: platformPda,
    platformFeeRecipient,
    gammPoolPlaceholder: PublicKey.default,
    systemProgram: SystemProgram.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onChain = await (program.account as any).tokenState.fetch(tokenState);
  const virtualSolReserve = new BN(onChain.virtualSolReserve.toString());
  const virtualTokenReserve = new BN(onChain.virtualTokenReserve.toString());

  if (side === "buy") {
    const buyLamportsStr = lamportsFromSolUiSafe(amountUi);
    if (buyLamportsStr == null) throw new Error("Invalid SOL amount");
    const solLamportsDesired = new BN(buyLamportsStr);
    const realTokRem = new BN(onChain.realTokenReserve.toString());
    const solLamports = maxBuyGrossLamportsWithinInventory(
      solLamportsDesired,
      virtualSolReserve,
      virtualTokenReserve,
      realTokRem
    );
    if (solLamports.lte(new BN(0))) {
      throw new Error("No tokens available on this bonding curve");
    }
    const curveFee = solLamports.mul(new BN(TOTAL_FEE_BPS)).div(new BN(10_000));
    const netSol = solLamports.sub(curveFee);
    const expectedTokensOut = calculateTokensOut(
      virtualSolReserve,
      virtualTokenReserve,
      netSol
    );
    const outCapped = BN.min(expectedTokensOut, realTokRem);
    const minTokensOut = outCapped.mul(new BN(99)).div(new BN(100));

    const signature: string = await program.methods
      .buy(solLamports, minTokensOut)
      .accountsPartial(tradeAccounts)
      .rpc();

    return {
      signature,
      side: "buy",
      sol_amount_raw: solLamports.toString(),
      token_amount_raw: outCapped.toString(),
      price_sol: priceSolFromRaw(
        solLamports.toString(),
        outCapped.toString()
      ),
      timestamp: new Date().toISOString(),
    };
  }

  let rawStr = tokenAmountRaw;
  if (!rawStr) {
    const raw = Math.floor(amountUi * 1e6);
    if (!(raw > 0)) throw new Error("Invalid token amount");
    rawStr = String(raw);
  }
  const tokenRaw = new BN(rawStr);
  if (tokenRaw.lte(new BN(0))) throw new Error("Enter an amount");

  const expectedSolOut = calculateSolOut(
    virtualSolReserve,
    virtualTokenReserve,
    tokenRaw
  );
  const minSolOut = expectedSolOut.mul(new BN(99)).div(new BN(100));

  const signature: string = await program.methods
    .sell(tokenRaw, minSolOut)
    .accountsPartial(tradeAccounts)
    .rpc();

  return {
    signature,
    side: "sell",
    sol_amount_raw: expectedSolOut.toString(),
    token_amount_raw: tokenRaw.toString(),
    price_sol: priceSolFromRaw(
      expectedSolOut.toString(),
      tokenRaw.toString()
    ),
    timestamp: new Date().toISOString(),
  };
}
