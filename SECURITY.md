# Security Policy

## Mainnet Warning

Streamflow Position Transfer constructs and can broadcast irreversible Solana mainnet transactions. It is unaudited software. Its validation checks do not guarantee protocol correctness, RPC integrity, wallet integrity, asset value, or recovery of funds sent to an incorrect destination.

Use a trusted machine, browser profile, wallet extension, and RPC provider. Independently verify every complete address and wallet prompt before signing or broadcasting.

## Supported Versions

Security fixes are applied to the current `main` branch. Older commits, forks, modified builds, and third-party deployments are not supported by this project.

## Reporting A Vulnerability

Use GitHub's private vulnerability reporting flow from the repository's **Security** tab. Do not open a public issue for a suspected vulnerability.

Include:

- the affected commit and environment;
- a concise impact statement;
- reproducible steps using generated accounts or public test fixtures;
- the expected and observed behavior; and
- a suggested mitigation, if known.

Do not include private keys, seed phrases, wallet exports, RPC credentials, personal wallet addresses, live signed transactions, or information that could put funds at risk. Redact screenshots and logs. A maintainer will respond on a best-effort basis and coordinate disclosure after a fix is available.

## Relevant Security Boundaries

Reports are especially useful when they concern:

- instruction, account, program, or signer validation bypasses;
- simulation-to-signing or signing-to-broadcast inconsistencies;
- destination-control proof bypasses;
- incorrect fee, rent, debit, or state-transition validation;
- tampering with pending transaction recovery or finalized receipt records;
- unsafe RPC proxy behavior or credential exposure;
- cross-site scripting or dependency supply-chain compromise; or
- unintended signing, broadcast, or duplicate submission.

General Streamflow or Solana protocol issues should be reported to their respective maintainers unless this application's behavior creates or amplifies the issue.

## Secret Handling

This application must never request or process a private key, seed phrase, mnemonic, recovery code, wallet export, password, or one-time code. Signing belongs in the user's wallet. RPC credentials must remain server-side and must never use a `VITE_*` variable.

If a secret is exposed, stop using the affected credential, rotate it through its provider, and remove it from any public history. If a signed transaction is pending, verify its status before clearing local browser data.

## Dependency And Build Integrity

Install dependencies with `npm ci` from the committed lockfile. Review dependency updates, especially wallet, Solana, Streamflow, cryptography, and build-tool changes. Build the application from a reviewed commit and avoid untrusted hosted copies.
