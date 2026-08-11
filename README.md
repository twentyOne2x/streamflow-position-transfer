# Streamflow Position Transfer

An unofficial, local-first React tool for inspecting and transferring an eligible Streamflow position on Solana mainnet. The connected wallet remains the signer; the application does not request, receive, or store private keys or recovery phrases.

> [!WARNING]
> This software is unaudited and submits irreversible mainnet transactions. Verify the contract, complete destination address, wallet prompt, estimated debit, and on-chain result yourself. Use it at your own risk.

This project is independent and is not affiliated with or endorsed by Streamflow or Solana.

## Why This Exists

This project was created to address a practical interface gap: a Streamflow position can be marked `transferableByRecipient` on-chain even when the interfaces available to its recipient do not expose a transfer action. It provides a transparent, local-first path to inspect eligibility, simulate the complete recipient change, and submit it through the current recipient's browser wallet.

This is not a bypass. It cannot make a non-transferable position transferable, transfer only part of a position, or act without authorization from the current recipient wallet.

## Initial Mainnet Case Study

This project grew out of a mainnet case completed on 2026-08-11. It changed the recipient rights for two Streamflow lock positions representing `465,000,000` tokens. It did not unlock, withdraw, or transfer the SPL tokens between wallets: the tokens remained in their Streamflow escrows, the original sender fields remained unchanged, and only the recipient and recipient-token-account fields changed.

- Mint: `FVGdJQVzAdKr8ZH7ahyhp4cvDszX3N8QYGSdzueopump`
- Previous recipient and transaction signer: `5DoKeehPR6UeqmjSRvGKZ3S49xJce6XgPsULXFQPS3qv`
- Destination and current recipient: `FTCuvRUmd3Q7MxZ5isoSVn4gABAFR6pV7996RwdNd9nr`
- Streamflow program: `strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m`
- Aggregate reviewed: `690,000,000`; eligible and reassigned: `465,000,000`; ineligible and unchanged: `225,000,000`

A finalized mint-filtered scan found exactly these three active Streamflow v4 positions. All three remained open with `withdrawnAmount=0`, and their escrow balances still matched their full deposited amounts.

### Qualifying Positions

The `75,000,000` token lock at contract `B3SLJwVYYLNvYTho2871ffLeXjipzumcLf4oJHPaWMJF` had `transferableByRecipient=true` and `transferableBySender=false`. Its recipient transfer finalized in slot `438536113` at `2026-08-11T04:14:53Z`, with a `5,000` lamport fee and no transaction error.

- Transaction: `4tsEviwRmBdnXLbc6UbcYGsgxDD25AZsNoVdiE5sJc6uhydEwdvxeBwZBJqwFy43asMgpz8jxfYV3HbMfb1GcyYt` ([Solana Explorer](https://explorer.solana.com/tx/4tsEviwRmBdnXLbc6UbcYGsgxDD25AZsNoVdiE5sJc6uhydEwdvxeBwZBJqwFy43asMgpz8jxfYV3HbMfb1GcyYt))

The `390,000,000` token lock at contract `242w1mxR2rq6Uoi9UV3pb7qg96Wt2BKM17EwMji5TwYQ` had the same flags. Its recipient transfer finalized in slot `438536312` at `2026-08-11T04:16:15Z`, also with a `5,000` lamport fee and no transaction error.

- Transaction: `618bRtj3n4BEQjJccEbF31v8Phjf2Zx4bBWYSFHok4sAaVdsgcYy9xk96imqZWZ5Yxhz4S6vDquwYuMbxpvBS5CP` ([Solana Explorer](https://explorer.solana.com/tx/618bRtj3n4BEQjJccEbF31v8Phjf2Zx4bBWYSFHok4sAaVdsgcYy9xk96imqZWZ5Yxhz4S6vDquwYuMbxpvBS5CP))

Both finalized transactions were signed only by the previous recipient, invoked Streamflow's `TransferRecipient` instruction, and left the escrow token balances unchanged.

### Position That Did Not Qualify

The `225,000,000` Team vesting position at contract `F62qBH5nJbFAqhVvhWWFgdGiXrigWr1BKKy51Sea1Cjq` had `transferableByRecipient=false` and `transferableBySender=false`. Its unsigned simulation returned `TransferNotAllowed` with Streamflow custom error `103`. No transfer transaction was signed or broadcast, and its recipient remains `5DoKeehPR6UeqmjSRvGKZ3S49xJce6XgPsULXFQPS3qv`.

### How It Was Tested

1. The three original contracts were decoded from mainnet and checked for the expected Streamflow program owner, account layout, mint, type, amount, authority, and transfer flags.
2. Unsigned simulations against the original accounts predicted success for both eligible locks and error `103` for the ineligible vesting position.
3. A devnet lifecycle test exercised both a transferable position and an error-`103` non-transferable control.
4. A separate disposable one-token mainnet canary completed the same recipient transition in transaction `4gPpMTXAsJ4BGkLjHydKzpLYg8yEG7qcLyFdkYohyMRq65Lvcopcqkoufc6pD6k6mpgXXU3G96qCoN19tkPMQZy4` ([Solana Explorer](https://explorer.solana.com/tx/4gPpMTXAsJ4BGkLjHydKzpLYg8yEG7qcLyFdkYohyMRq65Lvcopcqkoufc6pD6k6mpgXXU3G96qCoN19tkPMQZy4)).
5. A disposable, randomly named mainnet token then reproduced the three position types, schedules, and flags with scaled amounts. The two eligible replicas transferred successfully; the ineligible replica failed signed simulation with error `103` and was not broadcast. Raw readback confirmed that only the recipient fields changed.
6. Each original transfer passed a fresh destination-specific simulation, destination-control message signature, wallet-side transaction signature, signature-verifying simulation, immediate pre-broadcast account readback, explicit broadcast, finality confirmation, and finalized contract readback.
7. The extracted generic application is covered by deterministic tests that never sign or broadcast, plus clean-install, production-build, browser, RPC-proxy, and recovery checks.

The replica used source `JBxb1G45EoNxp1JjSht5rt6FmFMgV2vrufaYfyraF1DL`, destination `8Wn1gGtXcvGTKvS1XRibhpEggdZ4dNBrJnD561v265hv`, and mint `4ayGEcrc7g3DzyhLuxr8kB3LjfbovE64zGD7oNgyHeCr`. Its eligible replica contracts and finalized transfer transactions were:

- Contract `Fs1Kk7uVnKGLpdfb25LMtJ5c2wxBRuEJY7gG6BaFq1Lj`; transaction `3yEhB4NabaDbCdNSSAt9z6LQJFNd8q2cdc8Yhjcm4m1JAZtBawba7QfZt8i5zsFndcZFJeGVvZnPawuKXuktKcUR` ([Solana Explorer](https://explorer.solana.com/tx/3yEhB4NabaDbCdNSSAt9z6LQJFNd8q2cdc8Yhjcm4m1JAZtBawba7QfZt8i5zsFndcZFJeGVvZnPawuKXuktKcUR))
- Contract `HFTRoJZ4bNo463Xn7fNvK2zFaLJEpvfE7kAczmBm8mpp`; transaction `3RHn5Z6bqdYLCZ7JN9NbKgxDAvLejzGnhUZdZpyFBn1dSypZJa3uzAP3tEQFdKLnCDWgSPiAo1PwNxwtYn45CJ9y` ([Solana Explorer](https://explorer.solana.com/tx/3RHn5Z6bqdYLCZ7JN9NbKgxDAvLejzGnhUZdZpyFBn1dSypZJa3uzAP3tEQFdKLnCDWgSPiAo1PwNxwtYn45CJ9y))

The ineligible replica contract `8bDtZKnTvLZxiqeksbSqFm4FrAKvnAZbHayiJksXPN8J` was never broadcast as a recipient transfer because its signed simulation returned error `103`.

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
