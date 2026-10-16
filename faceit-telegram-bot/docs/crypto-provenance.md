# TeamSpeak encryption and vendored code

## Runtime constraints

Telegram Serverless documents only its `sdk`, application modules, and
ECMAScript runtime. It does not document a secure secret store, WebCrypto,
runtime environment variables, filesystem access, timers, or transactions.
This implementation does not assume these capabilities.

Source: [official Telegram Serverless reference](https://core.telegram.org/bots/serverless).
Checked on 2026-10-15 against the machine-readable `/bots/serverless.md` and
the SDK reference bundled with `@tgcloud/cli` 0.2.0.

## Key handling and security boundary

Generate the 32-byte encryption key locally using Node's cryptographic RNG.
The deployment-specific private configuration module is excluded from Git,
but intentionally uploaded as an application module by the Telegram CLI.
It must never be printed, logged, or pasted into chat. Do not share CLI
`diff`, `pull`, or cloud source snapshots containing that module.

This is not a managed secret vault: the bot owner, people with cloud source
access, and the hosting platform can access deployed key material. Encryption
protects a database-only disclosure, not compromise of the whole application.
Keep a secure backup of the key; losing it makes saved settings unrecoverable.

The encryption key is separate from both the FACEIT API key and the Telegram
CLI access token. Never reuse any of them as an encryption key.

## Algorithm and nonce allocation

`credentials.js` uses AES-256-GCM-SIV from `@noble/ciphers`, with authenticated
additional data binding the payload to its chat, format version, and key ID.
Copying an encrypted database value to another chat does not decrypt.
Only ciphertext, public nonce, and public key ID belong in the database.

The 96-bit nonce contains the signed 64-bit chat ID and a 32-bit monotonic
settings version. The storage service must allocate versions atomically and
must not reset them while retaining the same key. Version exhaustion fails
closed. GCM-SIV was chosen rather than GCM because it is resistant to nonce
reuse; this is defense in depth for accidental rollback, not permission to
deliberately reuse versions. Group migrations must decrypt with the old chat
ID and reseal with the new chat ID and a newly allocated version.

Source: [noble-ciphers algorithm guidance](https://github.com/paulmillr/noble-ciphers#picking-a-cipher)
and [RFC 8452](https://www.rfc-editor.org/rfc/rfc8452).

No custom encryption primitive is implemented. The local UTF-8 and hex
helpers only encode and decode values. Runtime code does not rely on
`crypto`, `TextEncoder`, `TextDecoder`, `Buffer`, or external packages.

## Pinned source and fingerprints

- Source package: `@noble/ciphers` **2.4.0**, MIT license.
- Source archive: [ciphers-2.4.0.tgz](https://registry.npmjs.org/@noble/ciphers/-/ciphers-2.4.0.tgz).
- Registry SHA-512 integrity, verified before extraction:
  `sha512-AnjFn0Jv92laAkvMrghlFZq4qQCIN/4DxFV/eooqtC2YTjB7kBeLMS2T9KJX4Dn+ZVXLOwK0lSgqDtx9gvxtiw==`.
- Archive SHA-256:
  `4a398bcc280c8742d474f9162f6d3c153e52ab1078e8ab592b4720410fb3c3e9`.
- Build tool: `esbuild` **0.28.2**, with neutral ES2022 ESM output and tree shaking.
- Vendored output: `tgcloud/lib/vendor/noble-gcmsiv.js`.
- Output SHA-256:
  `18111b021a9dc63eb82f1c65200f725b9c57b7c0b0ca5ef9f5bb6ece69672137`.
- Full original license: `docs/licenses/noble-ciphers-LICENSE.txt`.

The package publishes registry provenance attestations. Registry integrity
was checked; independently authenticating the publisher's signing identity
and the whole build provenance was not performed.

The library documents an independent Cure53 audit of **1.0.0** in September
2024. This does not imply an independent audit of the pinned **2.4.0** release.
See [upstream security statement](https://github.com/paulmillr/noble-ciphers#security).

## Rebuilding

After installing the exact locked development dependencies:

```bash
node scripts/build-crypto.mjs
shasum -a 256 tgcloud/lib/vendor/noble-gcmsiv.js
npm test
```

The generated file is a direct runtime dependency and belongs in source
control. Do not remove the license or edit the generated file by hand.
