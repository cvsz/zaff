# CONTRIBUTING.md

How to work in this repo. Execution governance lives in `AGENTS.md` and
`exec-planning.md`; this file covers mechanics.

## Requirements

- **Node.js >= 20.19** (enforced by `engines` in root `package.json`; CI runs
  Node 22 — see `.github/workflows/ci.yml`).
- Docker (only for a disposable local Postgres).
- No production credentials are ever needed; everything runs on dev-only
  defaults documented below.

## Setup

```bash
npm ci            # install all workspaces
```

### Disposable Postgres (for db/auth/api integration tests)

Tests target `postgres://postgres:zaff_dev_only@127.0.0.1:5433/zaff`
(default of `ZAFF_TEST_DATABASE_URL`, `packages/db/test/db.integration.test.ts:19-21`).
Integration suites skip themselves automatically if the DB is unreachable,
so gates still pass without Docker — but run it locally to exercise them:

```bash
docker run -d --name zaff-postgres -p 5433:5432 \
  -e POSTGRES_PASSWORD=zaff_dev_only -e POSTGRES_DB=zaff postgres:17-alpine
```

(The CI service container uses the same image/credentials/ports —
`.github/workflows/ci.yml:11-23`.) The credential is disposable/local-only;
never reuse it elsewhere (`SECURITY.md` rule 6).

## Quality gates

Run all four from the repo root before considering any change done:

```bash
npm run lint        # eslint (flat config, eslint.config.js)
npm run typecheck   # tsc project references
npm run build       # tsc -b --force
npm test            # vitest across all workspaces
```

CI (`.github/workflows/ci.yml`) runs exactly this sequence on push/PR plus a
Postgres service. Do not disable or weaken a security-relevant gate to get
green CI — fix the code instead.

## Conventions

- **Language/toolchain:** TypeScript ESM (`"type": "module"`), strict TS,
  zero new runtime dependencies unless a work item justifies them (several
  Phase-1 items were explicitly "zero new deps").
- **SQL:** parameterized postgresjs tagged templates only. Never interpolate
  values into SQL strings (ADR-0003). The migrator's `tx.unsafe()` is for
  repo-owned migration files only.
- **Secrets:** never commit secrets; dev defaults like
  `zaff_dev_state_secret_change_me` exist solely for local runs and must be
  overridden outside development (`SECURITY.md`, THREAT-MODEL gaps).
- **Logging:** no raw tokens/passwords/cookies in logs; the observability
  package redacts by default but do not rely on it for new sensitive fields.
- **Commits/branches:** short-lived feature branches per bounded work item;
  imperative commit messages referencing the item ID (e.g., `FND-x: ...`,
  `BK-n: ...`). Squash-style, self-contained commits preferred.
- **Docs:** user-facing docs live at repo root (`README`, `SECURITY`,
  `THREAT-MODEL`, `PRIVACY`, `COMPLIANCE`, `CHANGELOG`); architecture notes
  under `docs/architecture/`; decisions as ADRs in `docs/adr/`.

## Loop-engineering workflow (executor ≠ verifier)

This repo is developed via the loop-engineering-kit contract:

1. Read `exec-planning.md`; pick the highest-priority bounded incomplete item.
   Confirm dependencies are DONE.
2. Implement the minimum production change that satisfies the item's
   **Acceptance Criteria** (they are the contract — do not reinterpret them
   unilaterally; amend the plan first if they must change).
3. Run all quality gates. Add tests first where practical.
4. **Independent verification:** the executor must not be the sole verifier.
   Verification evidence goes into the Verification log table in
   `IMPLEMENTATION-CHECKLIST.md` ("tests at ship" + independent probe
   results).
5. Update, on every landed item:
   - `exec-planning.md` (status flip + changelog row),
   - `IMPLEMENTATION-CHECKLIST.md` (checkbox + verification log),
   - `CHANGELOG.md`.
6. Never mark unverified work complete. If blocked, record the blocker in
   `exec-planning.md` and stop rather than improvising scope.

## Pull request rules

1. **No secrets** in diffs, fixtures, or test data (secret scanning applies).
2. **No disabled security gates**, skipped tests without justification, or
   weakened validation to make checks pass.
3. Every PR maps to an open work item in `exec-planning.md` with its
   acceptance criteria met and evidence linked.
4. Security-adjacent changes (auth, storage keys/signing, SQL, logging) must
   update `SECURITY.md` / `THREAT-MODEL.md` if they alter the control surface
   or add accepted gaps.
5. Keep PRs bounded: one work item per PR.

## Security reporting

**TODO placeholder:** set up a private contact (security.txt / monitored
mailbox / GitHub private vulnerability reporting) before any public
deployment. Until then, do NOT open public issues for suspected
vulnerabilities — raise them privately with the maintainers.
