# ADR-0002: Contracts-first design

## Status

Accepted

## Context

Many independent components will exchange domain data: services, workers, platform adapters, and (later) web clients. Without a single source of truth for entity shapes, each component drifts, and runtime validation happens ad hoc or not at all. Platform integrations are especially risky: external providers change payloads and capabilities over time.

## Decision

All cross-boundary data shapes are defined once in `packages/contracts` as zod schemas with inferred static types (`z.infer`). Producers serialize through schemas; consumers parse untrusted input through the same schemas. Capability declarations use a versioned registry type (`ProviderCapabilityMatrixSchema` with an explicit `schemaVersion`) so provider assumptions are auditable and evolvable. Contracts have zero dependencies other than zod so every workspace can consume them safely.

## Consequences

- Runtime validation and compile-time types cannot drift apart; invalid boundary data fails loudly at parse time.
- zod becomes a foundational dependency; replacing it later requires a coordinated migration in one package.
- Schema changes are reviewable as contract changes; breaking changes must bump `schemaVersion` where registries/protocols are versioned.
- Slight runtime cost for validation at boundaries, accepted in exchange for safety.
