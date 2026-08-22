# ADR-0004: In-process event bus behind a transport-agnostic port

- **Status:** Accepted
- **Date:** 2026-08-22

## Context

FND-4 requires a queue/event-bus abstraction for the AGENTS.md §20 domain
events (ProductDiscovered … OptimizationRequested). The platform is
self-hostable and must run on a single node today, but the event-driven
architecture (§20) anticipates Kafka/NATS-class infrastructure later. No
external message broker is available in the current zero-spend deployment,
and adding a runtime dependency now would violate the FND-4 constraint of no
new dependencies.

## Decision

Define an `EventBus` port (`publish`, `subscribe(typeOrPattern, handler)`,
`close`) in `packages/events/src/types.ts` and ship a single in-process
implementation, `InMemoryEventBus`. Domain events are zod schemas with a
discriminated union; `TypedDomainEventBus` validates payloads both on publish
(invalid events are rejected before entering the bus) and on consume
(invalid payloads are never delivered raw to handlers — they fail validation
and flow through the retry/dead-letter path).

Delivery semantics for the in-memory bus are **at-most-once**: dispatch is
synchronous for sync handlers; a failing handler is retried with exponential
backoff (configurable attempts/base delay) and then dead-lettered into a
capped internal list with an optional callback. Nothing is persisted; events
lost to process restart or dead-letter exhaustion are gone.

Upgrade path: Redis Streams / Kafka / NATS adapters implement the same port.
They will document their own semantics — typically at-least-once with
explicit ack/nack — so consumers must stay idempotent from day one. The §20
event set already carries `id` (uuid) envelopes to make deduplication
possible when a durable adapter lands. A distributed adapter will need
equivalents of the drain/DLQ hooks (`waitForIdle`, `getDeadLetters`) or the
typed wrapper will be narrowed accordingly at that time.

## Consequences

- Zero new runtime deps; works in every self-hosted environment including
  single-container deployments.
- Consumers depend only on the port and typed domain events; no
  transport-specific logic leaks (verified by tests).
- At-most-once means handler crashes can lose events permanently — acceptable
  while all producers/consumers live in one process; unacceptable for money
  paths (conversions/commissions) at scale, which is precisely when the
  durable adapter should be introduced.
- Retry/backoff and DLQ behavior is identical across adapters only where the
  adapter implements it; contract tests cover the in-memory implementation,
  future adapters will need their own contract suites.

## BK-2: Durable adapter (Redis Streams)

- **Status:** Accepted
- **Date:** 2026-08-22

### Decision

`RedisStreamsEventBus` (`packages/events/src/redis-streams.ts`, dependency
`redis` ^4) implements the same `EventBus` port over Redis Streams.

### Semantics change: at-most-once → at-least-once

- Each event type maps to its own stream (`{prefix}:events:{type}`); the
  producer registers types in a `{prefix}:event-types` set so wildcard
  subscriptions can discover streams.
- Every subscription gets its own consumer group
  (`{group}:s{subscription-order}`) created at id `0` with `MKSTREAM`, so
  events published while no consumer was running are delivered when a
  consumer first subscribes.
- A message is acked (XACK) only after its handler succeeds. Failed
  deliveries stay pending; a poll loop re-claims stale pending entries via
  `XAUTOCLAIM` once they have been idle for at least the retry base delay.
  Delivery attempts are counted in a per-message Redis counter
  (`{prefix}:attempts:{group}:{msgId}`, 7-day TTL), so attempt counts survive
  process restarts. After `maxAttempts` deliveries the entry is copied to the
  capped dead-letter stream (`{prefix}:events:{type}:dlq`), acked, trimmed
  (`XTRIM MAXLEN`), and surfaced through the same `onDeadLetter` /
  `getDeadLetters` hooks as the in-memory bus.
- Consequence: **consumers must be idempotent**. Money-path handlers
  (`ConversionRecorded`, `CommissionRecorded`) MUST wrap handlers with
  `withIdempotency(handler, { store })` backed by `RedisDedupeStore`
  (SET NX PX keyed by `event.id`; default TTL 24h). The wrapper releases the
  reservation when the handler throws, so redelivery can retry.

### Ops notes

- Consumer groups persist in Redis independently of processes; group names
  derive from `group` option plus subscription order, so keep subscription
  order stable across deployments of the same service.
- DLQ streams are capped per dead-letter event via exact `XTRIM MAXLEN`
  (`deadLetterCapacity`, default 1000); inspect with XRANGE on
  `{prefix}:events:{type}:dlq`. The in-memory mirror only reflects
  dead-letterings observed by the current process.
- Graceful close stops polling, drains in-flight handlers, then quits the
  connection; unacked messages simply remain pending for the next consumer.
- Local/dev broker runs on `redis://127.0.0.1:6380` (container `zaff-redis`);
  configure via `url` option or `ZAFF_REDIS_URL`. Never bind host port 6379.
- Retry backoff is approximated as uniform claim idle-time (XAUTOCLAIM takes
  a single min-idle-time); exponential per-attempt delays would require
  per-message timers or multiple tiers if ever needed.
