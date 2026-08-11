import {
  ACCOUNT_SIZE,
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAccountLen,
  getAccountTypeOfMintType,
  getDefaultAccountState,
  getExtensionTypes,
  type Account,
  type Mint,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";

export function getDestinationAtaSize(mintTlvData: Buffer, tokenProgram: PublicKey) {
  if (tokenProgram.equals(TOKEN_PROGRAM_ID)) return ACCOUNT_SIZE;
  if (!tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error("Cannot size an ATA for an unsupported token program.");
  }
  const requiredAccountExtensions = new Set(
    getExtensionTypes(mintTlvData)
      .map(getAccountTypeOfMintType)
      .filter((extension) => extension !== ExtensionType.Uninitialized),
  );
  requiredAccountExtensions.add(ExtensionType.ImmutableOwner);
  return getAccountLen([...requiredAccountExtensions]);
}

export function assertDestinationTokenAccountUsable(
  account: Pick<Account, "isInitialized" | "isFrozen">,
) {
  if (!account.isInitialized) throw new Error("Destination token account is not initialized.");
  if (account.isFrozen) throw new Error("Destination token account is frozen.");
}

export function assertNewDestinationTokenAccountUsable(
  mint: Mint,
  tokenProgram: PublicKey,
) {
  if (tokenProgram.equals(TOKEN_PROGRAM_ID)) return;
  if (!tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error("Cannot validate a destination ATA for an unsupported token program.");
  }
  const defaultState = getDefaultAccountState(mint);
  if (!defaultState) return;
  if (defaultState.state === AccountState.Frozen) {
    throw new Error("Token-2022 mint creates destination token accounts in a frozen state.");
  }
  if (defaultState.state !== AccountState.Initialized) {
    throw new Error("Token-2022 mint has an invalid default destination token-account state.");
  }
}
