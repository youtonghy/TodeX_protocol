# TodeX Protocol

Shared TypeScript protocol layer for the TodeX desktop and web clients, extracted from the retired `TodeX_app` (React Native) repository.

## Consumers

`TodeX_desktop` and `TodeX_web` compile these sources directly through `@todex/protocol/*` path aliases:

- `tsconfig.web.json` → `"@todex/protocol/*": ["./../TodeX_protocol/src/*"]`
- `vite.config.ts` / `electron.vite.config.ts` / `vitest.config.ts` → `'@todex/protocol': resolve(..., '../TodeX_protocol/src')`

Keep this repository checked out as a sibling directory (`../TodeX_protocol`) of the clients. The sources are consumed as TypeScript — there is no build artifact or npm publish step.

## Layout

- `src/` — platform-agnostic protocol sources (`v2`, `todex`, `transport`, `transportCrypto` (pairing QR parsing and the pinned key; the `todex.crypto.v1` frames are removed), `historyCrypto`, `historyEncryption` (end-to-end history: `HistoryDecryptor`, §7 command frames, grant re-wrap; spec in `TodeX_backend/docs/history-encryption.md`), `recoveryKey` (BIP39 24-word / QR recovery key), `qrCode` (local QR encoder), `deviceAuth`, `conversationRuntime`, `mobileParity`, `connectionProbe`, `connectionError`, and supporting modules). `netinfo.d.ts` is an ambient declaration for the optional React Native NetInfo dynamic import.
- `secureChannel` / `secureTransport` — transport v2 (spec: `transport-v2.md`). `secureChannel` is the pure reference implementation shared with the backend and TodexCore: key schedule, sealed records, REST record streams and inner request/response heads, the WebSocket hello handshake, and device pairing v3 (commitment, transcript, code, derived keys). `secureTransport` is the single business-facing entry point (`createSecureTransport` → `fetch` / `fetchStream` / `openSocket`) and applies the client rules: pinned key → v2 everywhere (REST via `POST /v2/sealed`), unpinned remote host → `EncryptionRequiredError`, unpinned loopback → plaintext. `fetch`/`WebSocket` and the device-auth signer are injected. `verifyTransportPolicy` is the connect-time check against `/v2/transport-policy` (a different required protocol, including `none`, asks for re-pairing; a backend without `transportVersion: 2` is outdated), `cachedSecureTransport` keeps one instance per backend profile, and `toFetchResponse` adapts an opened response to a standard `Response`. `V2ApiClient` and `probeBackendConnection` send every request through a `SecureTransport`; `socketVerification` round-trips a `server.ping` as the first sealed frame of a new socket.
- `tests/unit/` — `node --test` suites run against `tsc` output in `dist/unit/lib/`.
- `tests/fixtures/transport-v2.json` — cross-implementation transport v2 vectors (both protocols, WebSocket frames, REST streams, failure cases, pairing v3). Regenerate deterministically with `node scripts/generate-transport-v2-vectors.cjs`; the backend and TodexCore copy it verbatim.
- `scripts/check-protocol.cjs` — protocol consistency check against the compiled `todex.js`.

## Commands

```bash
npm install
npm run test:unit       # compile src/*.ts with tsc, run tests/unit/*.test.cjs
npm run check:protocol  # protocol helper consistency check
npm run typecheck       # tsc --noEmit
```

## Rules for contributors

- `src/` must stay platform-agnostic: no `react-native`, `expo-*`, DOM, or Electron imports. `@noble/*` dependencies are provided by the consuming clients (and declared here for standalone tests).
- `@react-native-community/netinfo` is only referenced through a guarded dynamic `import()` in `v2.ts`; consumers stub it.
- Wire format changes must stay backward compatible with `TodeX_backend`; see `docs/conversation-runtime.md` in that repository.
