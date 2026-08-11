# Streamflow Position Transfer

An unofficial, local-first React tool for inspecting and transferring an eligible Streamflow position on Solana mainnet. The connected wallet remains the signer; the application does not request, receive, or store private keys or recovery phrases.

> [!WARNING]
> This software is unaudited and submits irreversible mainnet transactions. Verify the contract, complete destination address, wallet prompt, estimated debit, and on-chain result yourself. Use it at your own risk.

This project is independent and is not affiliated with or endorsed by Streamflow or Solana.

## Scope

The application is intentionally narrow. It:

- accepts a Streamflow contract address and destination wallet at runtime;
- requires the connected wallet to be the position's current recipient;
- handles only positions marked transferable by the recipient;
- transfers the complete remaining position, not a partial amount;
- supports the Solana token programs accepted by its transaction validator;
- targets Solana mainnet-beta and rejects a mismatched network;
- signs through a compatible browser wallet adapter; and
- records pending recovery data and finalized receipts in the browser's local storage, then authenticates retained receipts against mainnet on reload.

It does not custody assets, export wallet secrets, operate a hosted signing service, or guarantee that a position is transferable.

## Safety Model

Simulation, signing, and broadcasting are separate actions:

1. **Simulate** reads the contract, validates its owner and layout, builds the recipient-transfer instructions, checks the destination, estimates fees and token-account rent, and verifies the simulated state transition.
2. **Prove destination control** asks the destination wallet to sign a human-readable message. This is not a transaction and does not move assets.
3. **Sign** asks the current recipient wallet to sign the exact simulated transaction. Signing alone does not submit it to the network.
4. **Broadcast** submits the previously verified signed bytes. This is the action that can irreversibly transfer the complete position.
5. **Finalize** verifies the transaction and reads the contract back from mainnet before recording a local receipt.

The application pins reviewed protocol and transaction semantics and fails closed when those assumptions change. Those checks reduce specific risks; they are not a substitute for an independent audit or operator review.

## Requirements

- Node.js 22 or newer
- npm
- A browser with a compatible Solana wallet that supports message and transaction signing
- A mainnet RPC endpoint that supports transaction simulation and account readback
- Enough SOL in the current recipient wallet for transaction fees and any required destination token-account rent

Never paste a seed phrase, private key, wallet export, or RPC credential into the application.

## Install And Run

```bash
npm ci
npm run dev
```

Open `http://127.0.0.1:4178` in the browser profile that contains your wallet extension.

For a production-mode local check:

```bash
npm run build
npm run preview
```

Open `http://127.0.0.1:4179`. Opening `dist/index.html` directly is not supported because RPC requests use a same-origin proxy.

## RPC Configuration

The Vite development and preview servers proxy browser requests from `/solana-rpc` to the configured mainnet endpoint. The proxy accepts only same-origin loopback browser requests, single JSON-RPC calls from the application's exact method allowlist, bounded request and response bodies, and a limited request rate. To use a private provider, set the server-side environment variable before starting the process:

```bash
export SOLANA_RPC_HTTP_URL_MAINNET='<your-mainnet-rpc-url>'
npm run dev
```

The default is Solana's public mainnet endpoint, which may be rate-limited. Keep provider credentials out of `VITE_*` variables because those values are exposed to browser code. Do not commit local environment files.

A hosted deployment must provide an equivalent authenticated or same-origin RPC proxy, update the loopback-only origin policy for its exact host, and preserve the method, size, concurrency, rate, response-validation, and credential-redaction controls. It must also reproduce the CSP and other security headers configured by Vite; those headers do not travel with files copied from `dist/`. The static bundle alone is not a complete deployment.

## Operator Flow

1. Connect the wallet that currently receives the Streamflow position.
2. Enter the Streamflow contract address and the complete destination wallet address.
3. Run the simulation and review the position, destination, state-change summary, and estimated debit.
4. Connect the destination wallet and sign the destination-control message.
5. Reconnect the current recipient wallet, re-enter the complete destination, and acknowledge the irreversible transfer.
6. Sign the transaction in the wallet and inspect the verified local transaction identifier.
7. Choose **Broadcast signed transfer** only after the final review.
8. Keep the page open until finalized readback succeeds, then verify the transaction independently with a trusted explorer or RPC.

Reject any wallet prompt whose network, accounts, instructions, or costs differ from what you reviewed.

## Pending Transaction Recovery

Before initial submission, the application writes the exact signed transaction and validation metadata as an **unarmed draft**. Under one global Web Lock, it validates the exact persisted bytes and then promotes them to the **armed** pending record. A prepared-only draft never auto-submits after a crash or reload; the UI can discard it only while holding the same lock and only when no armed record exists.

An armed record blocks new transfers. On reload, recovery acquires the global lock, revalidates and re-reads the exact durable record before every submission or clear, checks transaction status, and may rebroadcast only the same signed bytes while the blockhash and reviewed on-chain baseline remain valid. A processed or confirmed error is retained until finalized. A status-null transaction past blockhash expiry is cleared only after a finalized contract read proves that its raw pre-state is unchanged; otherwise the record remains quarantined for operator reconciliation.

Recovery never creates a replacement transaction or asks for a new signature. Keep one operator page open until finality and do not clear site data while a broadcast is unresolved. First reconcile the displayed transaction identifier through a trusted RPC or explorer.

Local storage contains public transaction and account data plus signed transaction bytes. Use a private browser profile on a trusted machine and treat exported browser data as sensitive operational material.

Finalized receipt entries are schema-checked and reauthenticated on reload against the finalized transaction's signature, message, transfer semantics, slot, fee, and payer debit. The contract readback hashes in the journal record what the application observed at finalization; they are not independently reconstructed from historical account data on reload. A failed receipt check is visibly quarantined and can be retried or the local record can be discarded. Discarding a local receipt does not change on-chain state.

## Development

```bash
npm run typecheck
npm test
npm run build
```

Run the complete local verification suite with:

```bash
npm run check
npm run audit:production
```

Tests must remain deterministic and must not sign, broadcast, spend funds, or require a live wallet. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

The browser-only install uses `legacy-peer-deps=true` to avoid installing the wallet adapter's unused React Native peer graph. Required browser peers are pinned directly in `package.json`.

## Dependency Advisories

As of 2026-08-11, `npm audit --omit=dev` reports advisories inherited through the latest Streamflow SDK and its pinned Solana 1.x dependencies. The high-severity root advisory is the native `bigint-buffer` conversion path; the production browser bundle resolves that package to its pure-JavaScript browser implementation. The remaining UUID advisory concerns caller-provided buffers in UUID v3/v5, while this application does not expose those APIs.

There is no compatible upstream upgrade that clears the current audit without replacing or downgrading the protocol SDK. This reachability review narrows the known exposure but does not prove the dependency graph safe. `npm run audit:production` fails closed unless the exact reviewed advisory IDs, packages, dependency paths, severities, and counts remain unchanged; any drift requires an explicit review and allowlist update. CI runs that gate in addition to the deterministic tests and production build.

## License

This project is licensed under GPL-3.0-only. Third-party packages remain under their respective licenses; see `LICENSE` and [NOTICE](NOTICE).
