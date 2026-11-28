import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { IDL as OmnipairIdl } from "@omnipair/program-interface";
import { OMNIPAIR_PROGRAM_ID } from "./src/lib/omnipairProgram";
import fs from "fs";

async function main() {
  const connection = new Connection(process.env.NEXT_PUBLIC_SOLANA_RPC_URL!, "confirmed");
  const kp = Keypair.generate();
  const wallet = { publicKey: kp.publicKey, signTransaction: async (t:any)=>t, signAllTransactions: async (t:any)=>t };
  const idl = { ...OmnipairIdl, address: OMNIPAIR_PROGRAM_ID.toBase58() };
  const program = new Program(idl as any, new AnchorProvider(connection, wallet as any, { commitment: "confirmed" }));
  const pair = new PublicKey("BQimVDPMiU3zcadJDwQ2WpZFGKC9Xpeu36YJAP31P6gK");
  const acct = await (program.account as any).pair.fetch(pair);
  const keys = Object.keys(acct).filter(k => !k.startsWith("_"));
  console.log("keys", keys);
  for (const k of keys) {
    const v = acct[k];
    if (v && typeof v === "object" && v.toString && !(v instanceof PublicKey) && !Array.isArray(v)) {
      // BN-like
      try { console.log(k, v.toString?.() ?? v); continue; } catch {}
    }
    if (typeof v === "object" && v?.toBase58) console.log(k, v.toBase58());
    else if (typeof v === "object") console.log(k, JSON.stringify(v, (_,x)=> typeof x==="bigint"?x.toString(): (x?.toString?.() ?? x)));
    else console.log(k, v);
  }
}
main();
