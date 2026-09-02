# Security Policy

gavel submits `execTransaction` calls against Safe multisigs holding real funds. A
defect in `src/assemble.mjs` can broadcast a malformed or hostile payload against
someone's treasury. Please treat findings here as material.

## Supported versions
| Version | Supported |
|---|---|
| latest (`main`) | ✅ |

## Reporting a vulnerability
**Do not open a public issue.** Instead:

- Email **edy.cu@live.com**, or
- Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability).

You will get an acknowledgment within 48 hours.

## The security properties this project claims

Each is enforced in `src/assemble.mjs` and covered by a test — assertions backed
by code, not paragraphs.

| Claim | Invariant | Test |
|---|---|---|
| Never executes below threshold, including when the chain raised it after signing | I1 | `assemble.test.mjs`, `security.test.mjs#2` |
| Never executes a payload whose nonce has moved | I2 | `assemble.test.mjs` |
| Never executes against a Safe not on the opt-in roster | I3 | `security.test.mjs#6` |
| **Never executes a refund transaction** — a hostile `gasToken` + `refundReceiver` is a drain vector aimed at whoever executes | I4 | `assemble.test.mjs` |
| Never delegatecalls a treasury | I5 | `assemble.test.mjs` |
| Every confirming owner is still an owner on chain | I6 | `assemble.test.mjs` |
| **Splices EOA/eth_sign signatures only**, checked on the `v` byte rather than an optional label. `v=0` would make `checkSignatures` call an attacker-supplied address | I7 | `security.test.mjs#3` |
| Exactly `threshold` signatures, strictly ascending, deduplicated | I8 | `assemble.test.mjs` |
| The decision surface performs zero I/O | I10 | `assemble.test.mjs`, CI `purity` job |
| Exactly one candidate per run | I11 | `assemble.test.mjs` |

## Known posture

- **Nothing broadcasts without three gates**: `assemble` → local `eth_call` → the
  platform's own `simulate`. Any failure stops the run.
- **The executor holds no authority.** It is not an owner of any Safe in the
  roster; `isOwner()` returns `false` on chain. A test asserts this against the
  resolved cast addresses.
- **Credentials never enter this repository.** They are read from `~/.config/`.
  `gitleaks` scans full history on every push.
