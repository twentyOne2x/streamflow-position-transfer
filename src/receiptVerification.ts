import bs58 from "bs58";
import nacl from "tweetnacl";
import { MessageV0, PublicKey, type Connection } from "@solana/web3.js";

import {
  EXPECTED_MAINNET_GENESIS_HASH,
  MAX_TOTAL_COST_LAMPORTS,
  STREAMFLOW_V4_PROGRAM_ID,
  type FinalizedTransferReceipt,
} from "./positionTransferSafety";
import {
  enforceSimulatedPayerDebit,
  sha256Hex,
  validateCompiledTransferMessage,
} from "./transactionSafety";

export async function verifyFinalizedTransferReceipt(
  connection: Connection,
  receipt: FinalizedTransferReceipt,
) {
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash !== EXPECTED_MAINNET_GENESIS_HASH) {
    throw new Error("Receipt verification RPC is not Solana mainnet-beta.");
  }
  const finalized = await connection.getTransaction(receipt.signature, {
    commitment: "finalized",
    maxSupportedTransactionVersion: 0,
  });
  if (!finalized) throw new Error("The finalized receipt transaction is unavailable on-chain.");
  if (!(finalized.transaction.message instanceof MessageV0)) {
    throw new Error("The finalized receipt transaction is not version 0.");
  }
  if (
    finalized.transaction.signatures.length !== 1 ||
    finalized.transaction.signatures[0] !== receipt.signature
  ) {
    throw new Error("The finalized receipt signature does not match its transaction.");
  }
  if (finalized.slot !== receipt.slot) throw new Error("The finalized receipt slot does not match on-chain data.");
  if (receipt.blockTime !== null && finalized.blockTime !== receipt.blockTime) {
    throw new Error("The finalized receipt block time does not match on-chain data.");
  }

  const messageBytes = finalized.transaction.message.serialize();
  if ((await sha256Hex(messageBytes)) !== receipt.signedMessageSha256) {
    throw new Error("The finalized receipt message hash does not match on-chain data.");
  }
  const source = new PublicKey(receipt.source);
  if (!nacl.sign.detached.verify(messageBytes, bs58.decode(receipt.signature), source.toBytes())) {
    throw new Error("The finalized receipt signature does not verify for its source wallet.");
  }

  const validation = await validateCompiledTransferMessage({
    message: finalized.transaction.message,
    streamflowProgramId: new PublicKey(STREAMFLOW_V4_PROGRAM_ID),
    authority: source,
    destination: new PublicKey(receipt.destination),
    contract: new PublicKey(receipt.contractId),
    mint: new PublicKey(receipt.mint),
  });
  if (
    validation.semanticDigest !== receipt.semanticDigest ||
    !validation.destinationAta.equals(new PublicKey(receipt.destinationAta)) ||
    !validation.tokenProgram.equals(new PublicKey(receipt.tokenProgram))
  ) {
    throw new Error("The finalized receipt instruction semantics do not match on-chain data.");
  }

  if (!finalized.meta || finalized.meta.err) {
    throw new Error("The finalized receipt transaction did not succeed.");
  }
  if (finalized.meta.fee !== receipt.feeLamports) {
    throw new Error("The finalized receipt fee does not match on-chain data.");
  }
  const payerPreBalance = finalized.meta.preBalances[0];
  const payerPostBalance = finalized.meta.postBalances[0];
  const payerDebitLamports = enforceSimulatedPayerDebit({
    preLamports: payerPreBalance,
    postLamports: payerPostBalance,
    feeLamports: finalized.meta.fee,
    expectedProgramDebitLamports: receipt.payerDebitLamports - receipt.feeLamports,
    maximumLamports: MAX_TOTAL_COST_LAMPORTS,
  });
  if (payerDebitLamports !== receipt.payerDebitLamports) {
    throw new Error("The finalized receipt payer debit does not match on-chain data.");
  }
  return { slot: finalized.slot, blockTime: finalized.blockTime ?? null };
}
