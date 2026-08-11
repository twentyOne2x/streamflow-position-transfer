import {
  ACCOUNT_SIZE,
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type Mint,
} from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";
import { Buffer } from "buffer";
import { describe, expect, it } from "vitest";

import {
  assertDestinationTokenAccountUsable,
  assertNewDestinationTokenAccountUsable,
  getDestinationAtaSize,
} from "./tokenAccountSafety";

function extensionTlv(type: ExtensionType, data = Buffer.alloc(0)) {
  const tlv = Buffer.alloc(4 + data.length);
  tlv.writeUInt16LE(type, 0);
  tlv.writeUInt16LE(data.length, 2);
  data.copy(tlv, 4);
  return tlv;
}

describe("getDestinationAtaSize", () => {
  it("uses the classic SPL account size", () => {
    expect(getDestinationAtaSize(Buffer.alloc(0), TOKEN_PROGRAM_ID)).toBe(ACCOUNT_SIZE);
  });

  it("includes Token-2022's mandatory ImmutableOwner extension", () => {
    expect(getDestinationAtaSize(Buffer.alloc(0), TOKEN_2022_PROGRAM_ID)).toBe(170);
  });

  it("ignores mint-only extensions when sizing the destination ATA", () => {
    expect(
      getDestinationAtaSize(extensionTlv(ExtensionType.MetadataPointer), TOKEN_2022_PROGRAM_ID),
    ).toBe(170);
  });

  it("includes account extensions required by the mint", () => {
    expect(
      getDestinationAtaSize(extensionTlv(ExtensionType.TransferFeeConfig), TOKEN_2022_PROGRAM_ID),
    ).toBe(182);
  });

  it("rejects unknown token programs", () => {
    expect(() => getDestinationAtaSize(Buffer.alloc(0), Keypair.generate().publicKey)).toThrow("unsupported");
  });
});

describe("destination token-account usability", () => {
  it("accepts only initialized, unfrozen existing accounts", () => {
    expect(() =>
      assertDestinationTokenAccountUsable({ isInitialized: true, isFrozen: false }),
    ).not.toThrow();
    expect(() =>
      assertDestinationTokenAccountUsable({ isInitialized: false, isFrozen: false }),
    ).toThrow("not initialized");
    expect(() =>
      assertDestinationTokenAccountUsable({ isInitialized: true, isFrozen: true }),
    ).toThrow("frozen");
  });

  it("rejects Token-2022 mints whose new accounts default to frozen", () => {
    const frozenMint = {
      tlvData: extensionTlv(
        ExtensionType.DefaultAccountState,
        Buffer.from([AccountState.Frozen]),
      ),
    };
    expect(() =>
      assertNewDestinationTokenAccountUsable(frozenMint as Mint, TOKEN_2022_PROGRAM_ID),
    ).toThrow("frozen state");
  });

  it("rejects an uninitialized Token-2022 default account state", () => {
    const invalidMint = {
      tlvData: extensionTlv(
        ExtensionType.DefaultAccountState,
        Buffer.from([AccountState.Uninitialized]),
      ),
    };
    expect(() =>
      assertNewDestinationTokenAccountUsable(invalidMint as Mint, TOKEN_2022_PROGRAM_ID),
    ).toThrow("invalid default");
  });

  it("accepts classic mints and initialized Token-2022 defaults", () => {
    const initializedMint = {
      tlvData: extensionTlv(
        ExtensionType.DefaultAccountState,
        Buffer.from([AccountState.Initialized]),
      ),
    };
    expect(() =>
      assertNewDestinationTokenAccountUsable(initializedMint as Mint, TOKEN_2022_PROGRAM_ID),
    ).not.toThrow();
    expect(() =>
      assertNewDestinationTokenAccountUsable(initializedMint as Mint, TOKEN_PROGRAM_ID),
    ).not.toThrow();
  });
});
