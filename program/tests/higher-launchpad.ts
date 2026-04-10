import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { HigherLaunchpad } from "../target/types/higher_launchpad";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { assert } from "chai";

describe("higher-launchpad", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.HigherLaunchpad as Program<HigherLaunchpad>;

  const creator = provider.wallet as anchor.Wallet;
  const mintKeypair = Keypair.generate();

  let platformPda: PublicKey;
  let tokenStatePda: PublicKey;
  let mintAuthorityPda: PublicKey;
  let solVaultPda: PublicKey;
  let tokenVaultAta: PublicKey;

  before(async () => {
    [platformPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("platform")],
      program.programId
    );
    [tokenStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_state"), mintKeypair.publicKey.toBuffer()],
      program.programId
    );
    [mintAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority"), mintKeypair.publicKey.toBuffer()],
      program.programId
    );
    [solVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("sol_vault"), mintKeypair.publicKey.toBuffer()],
      program.programId
    );
    tokenVaultAta = await getAssociatedTokenAddress(
      mintKeypair.publicKey,
      solVaultPda,
      true
    );
  });

  it("Initializes the platform", async () => {
    const platformFeeRecipient = Keypair.generate().publicKey;

    await program.methods
      .initializePlatform(platformFeeRecipient)
      .accounts({
        platform: platformPda,
        authority: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const platform = await program.account.platformState.fetch(platformPda);
    assert.ok(platform.authority.equals(creator.publicKey));
    assert.equal(platform.totalTokensCreated.toNumber(), 0);
    console.log("✅ Platform initialized");
  });

  it("Creates a new token on the bonding curve", async () => {
    const metadataPda = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s").toBuffer(),
        mintKeypair.publicKey.toBuffer(),
      ],
      new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")
    )[0];

    await program.methods
      .createToken({
        name: "Test Higher Token",
        symbol: "TEST",
        uri: "https://arweave.net/test-metadata-hash",
        creatorFeeRecipient: creator.publicKey,
      })
      .accounts({
        tokenState: tokenStatePda,
        mint: mintKeypair.publicKey,
        mintAuthority: mintAuthorityPda,
        solVault: solVaultPda,
        tokenVault: tokenVaultAta,
        metadata: metadataPda,
        platform: platformPda,
        creator: creator.publicKey,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        metadataProgram: new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"),
      })
      .signers([mintKeypair])
      .rpc();

    const tokenState = await program.account.tokenState.fetch(tokenStatePda);
    assert.ok(tokenState.mint.equals(mintKeypair.publicKey));
    assert.equal(tokenState.totalSupply.toNumber(), 10_000_000_000_000);
    assert.deepEqual(tokenState.phase, { bonding: {} });
    console.log("✅ Token created:", mintKeypair.publicKey.toBase58());
    console.log("   Total supply: 10,000,000 (with 6 decimals)");
  });

  it("Buys tokens from the bonding curve", async () => {
    const buyer = creator; // use creator as buyer for simplicity
    const buyerAta = await getAssociatedTokenAddress(
      mintKeypair.publicKey,
      buyer.publicKey
    );

    const solBefore = await provider.connection.getBalance(buyer.publicKey);

    const solIn = new anchor.BN(1_000_000_000); // 1 SOL
    const minOut = new anchor.BN(0); // accept any amount for test

    await program.methods
      .buy(solIn, minOut)
      .accounts({
        tokenState: tokenStatePda,
        mint: mintKeypair.publicKey,
        solVault: solVaultPda,
        tokenVault: tokenVaultAta,
        userTokenAccount: buyerAta,
        user: buyer.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    const tokenState = await program.account.tokenState.fetch(tokenStatePda);
    const buyerBalance = await provider.connection.getTokenAccountBalance(buyerAta);

    assert.isAbove(tokenState.solRaised.toNumber(), 0);
    assert.isAbove(Number(buyerBalance.value.amount), 0);
    console.log("✅ Buy successful");
    console.log("   SOL raised:", tokenState.solRaised.toNumber() / 1e9, "SOL");
    console.log("   Tokens bought:", buyerBalance.value.uiAmount);
  });

  it("Calculates correct bonding curve price", async () => {
    const tokenState = await program.account.tokenState.fetch(tokenStatePda);
    const pricePerToken =
      tokenState.virtualSolReserve.toNumber() /
      tokenState.virtualTokenReserve.toNumber();
    console.log("✅ Current price per token:", pricePerToken.toFixed(10), "SOL");
    assert.isAbove(pricePerToken, 0);
  });
});
