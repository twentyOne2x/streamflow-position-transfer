# Contributing

Contributions are welcome when they preserve the project's narrow operator flow and fail-closed mainnet safety model.

## Development Setup

Use Node.js 22 or newer and install the locked dependency graph:

```bash
npm ci
npm run dev
```

Before submitting a change, run:

```bash
npm run check
```

## Contribution Rules

- Keep simulation, wallet signing, and broadcast as explicit separate actions.
- Preserve wallet-side signing. Never add private-key, seed-phrase, wallet-export, or browser-wallet-storage access.
- Keep RPC credentials server-side and out of `VITE_*` variables.
- Default tests to generated keys, deterministic fixtures, and mocked RPC data.
- Do not sign, broadcast, spend funds, or depend on a live mainnet wallet in automated tests.
- Do not commit personal wallet, mint, contract, transaction, receipt, RPC credential, or provider-account data.
- Do not weaken network, program, account, instruction, cost, state-transition, destination-proof, recovery, or finality checks to make a test pass.
- Keep the package marked private unless npm publication is separately reviewed and authorized.

Changes to transaction construction, validation, recovery, RPC routing, wallet integration, or dependencies require focused regression tests and a clear description of the affected safety invariant.

## Pull Requests

Keep each pull request focused. Include:

- the user-visible or security-relevant behavior changed;
- the assumptions and invariants affected;
- the commands used for verification;
- whether any network request occurred; and
- confirmation that nothing signed, broadcast, or spent funds during testing.

Screenshots and logs must use generated or neutral data and must be checked for identifiers before upload. Generated builds, coverage, local environment files, browser traces, signed transactions, and receipt artifacts do not belong in commits.

## Licensing

By submitting a contribution, you agree that it may be distributed under GPL-3.0-only, the project's license. Third-party code must have compatible terms and retain all required attribution and notices.
