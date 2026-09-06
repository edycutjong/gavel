# Contributing

Thanks for your interest in gavel.

## Getting started
```bash
git clone https://github.com/edycutjong/gavel.git
cd gavel && npm install
npm test          # 64 tests, no network, no credentials
```

Anything beyond `npm test` touches a real chain. See `DEMO.md` for the credential
surface — nothing lives in this repo; credentials are read from `~/.config/`.

## The one rule that matters

`src/assemble.mjs` decides whether to move someone else's money. It is:

- **pure** — no I/O, no clock, no randomness, no dependencies (invariant I10)
- **injected verbatim** into a sandboxed workflow node by `scripts/sync.mjs`

So a change there must keep it pure. CI asserts this, and `sync.mjs` refuses to
emit a workflow if it stops being true. If you need data, take it as an argument.

**Guards must read bytes, not labels.** A previous version refused EIP-1271
signatures by reading an optional `signatureType` field, which a hostile payload
simply omits. Check the thing that cannot be left out.

## Before you open a PR
- `npm test` passes.
- New behaviour has a test. A fixed defect gets a test **named after the defect**
  (see `test/security.test.mjs` for the convention).
- Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`.

## Reporting bugs
Use the issue templates. For anything security-relevant, read `SECURITY.md`
first — please do not open a public issue.
