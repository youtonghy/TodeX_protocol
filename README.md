# TodeX Protocol

<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a></p>

The shared client side of TodeX: everything a TodeX app needs to talk to a TodeX backend (`todex-agentd`) safely. [TodeX Desktop](https://github.com/youtonghy/TodeX_desktop), [TodeX Web](https://github.com/youtonghy/TodeX_web) and [TodeX Native](https://github.com/youtonghy/TodeX_native) all build on it, so pairing, encryption and conversations behave the same in every client.

## What it provides

- **Device pairing**: the pairing flow where a user compares a code between the client and the backend. Approval enrolls the device's signing key and pins the backend's transport key in one step; there is no manual key import. Includes key fingerprints for display and clear error codes for each failure.
- **Encrypted transport**: every request and the live connection to a paired backend are encrypted (X25519 or post-quantum ML-KEM-768), loopback included. The client refuses plaintext to remote hosts, asks for re-pairing when the backend's key or policy changes, and retries clock-skew and busy responses safely.
- **End-to-end encrypted history**: reading and writing encrypted conversation history, granting access to new devices, and 24-word / QR recovery keys.
- **Backend client**: a typed client for the backend's `/v2` API and live conversation events, with connection probes, diagnostics for common connection errors and jittered reconnect delays.
- **Conversation runtime**: turning the backend's event stream into what the apps display: messages, tool steps, approvals, plans, terminal output, with realtime events batched per animation frame.
- **Backend groups**: signed member lists, invites and join codes, presence, relays and the order a client tries a group member's addresses in.
- **Shared app logic**: config sync, Agent Calling, agent desktop tools, SSH, path mappings, `@` reference menus, plan review, Markdown and other helpers the clients have in common.

It is platform-agnostic TypeScript with no UI, DOM, Electron or React Native dependencies.

## Use it in a client

The clients compile these sources directly; there is no package to publish or install. Check this repository out next to the client:

```
parent/
  TodeX_desktop/   (or TodeX_web, TodeX_native)
  TodeX_protocol/
```

The clients import it as `@todex/protocol/*` through a path alias to `../TodeX_protocol/src`. Desktop's CI checks out `main` of this repository, so push protocol changes before the client changes that need them.

## Development

```bash
npm install
npm test                # compile and run the unit tests
npm run check:protocol  # protocol consistency check
npm run typecheck
```

Changes on the wire must stay compatible with [TodeX Backend](https://github.com/youtonghy/TodeX_backend). Cross-implementation test vectors live in `tests/fixtures/` (transport v2 and backend groups) and are shared verbatim with the backend.

Module-by-module notes, fixture regeneration and contributor rules: [docs/MODULES.md](docs/MODULES.md).
