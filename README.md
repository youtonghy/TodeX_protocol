# TodeX Protocol

Shared TypeScript protocol layer for the TodeX desktop and web clients, extracted from the retired `TodeX_app` (React Native) repository.

## Consumers

`TodeX_desktop` and `TodeX_web` compile these sources directly through `@todex/protocol/*` path aliases:

- `tsconfig.web.json` → `"@todex/protocol/*": ["./../TodeX_protocol/src/*"]`
- `vite.config.ts` / `electron.vite.config.ts` / `vitest.config.ts` → `'@todex/protocol': resolve(..., '../TodeX_protocol/src')`

Keep this repository checked out as a sibling directory (`../TodeX_protocol`) of the clients. The sources are consumed as TypeScript — there is no build artifact or npm publish step.

## Layout

- `src/` — platform-agnostic protocol sources (`v2`, `todex`, `transport`, `transportCrypto`, `deviceAuth`, `conversationRuntime`, `mobileParity`, `connectionProbe`, `connectionError`, and supporting modules). `netinfo.d.ts` is an ambient declaration for the optional React Native NetInfo dynamic import.
- `tests/unit/` — `node --test` suites run against `tsc` output in `dist/unit/lib/`.
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
