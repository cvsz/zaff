import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createClient } from "redis";
import { ContentFailedSchema, type DomainEvent } from "./domain.js";
import {
  RedisDedupeStore,
  RedisStreamsEventBus,
  withIdempotency,
  type IdempotencyStore,
  type RedisStreamsEventBusOptions,
} from "./redis-streams.js";
import { describeBusContract, testEvent, type BusFixture, type TestEvent } from "./bus.contract.js";
import { EventValidationError, TypedDomainEventBus } from "./typed-bus.js";

const REDIS_URL = process.env.ZAFF_TEST_REDIS_URL ?? "redis://127.0.0.1:6380";

let redisAvailable = false;
try {
  const probe = createClient({ url: REDIS_URL });
  probe.on("error", () => undefined);
  await probe.connect();
  await probe.ping();
  await probe.disconnect();
  redisAvailable = true;
} catch {
  redisAvailable = false;
}

interface Fixture extends BusFixture {
  bus: RedisStreamsEventBus<TestEvent>;
  prefix: string;
}

function makeRedisBus(
  overrides: Partial<RedisStreamsEventBusOptions> = {},
): Fixture {
  const prefix = overrides.prefix ?? `t:${randomUUID()}`;
  const bus = new RedisStreamsEventBus<TestEvent>({
    url: REDIS_URL,
    prefix,
    group: `g:${randomUUID()}`,
    pollIntervalMs: 10,
    retry: { maxAttempts: 3, baseDelayMs: 5 },
    ...overrides,
  });
  return {
    bus,
    prefix,
    deadLetterIds: () => bus.getDeadLetters().map((entry) => (entry.event as TestEvent).id),
  };
}

const suite = describe.skipIf(!redisAvailable);

suite("RedisStreamsEventBus contract", () => {
  describeBusContract("redis", (options) => makeRedisBus(options));
});

suite("RedisStreamsEventBus durability", () => {
  const cleanupClients: Array<ReturnType<typeof createClient>> = [];

  afterAll(async () => {
    await Promise.all(cleanupClients.map((client) => client.quit().catch(() => undefined)));
  });

  it("processes events published while the consumer was offline", async () => {
    const { prefix } = makeRedisBus();
    const offline = makeRedisBus({ prefix });
    const handler = vi.fn();

    await offline.bus.publish(testEvent("ConversionRecorded", "offline-1"));
    await offline.bus.publish(testEvent("ConversionRecorded", "offline-2"));
    await offline.bus.close();

    const restarted = makeRedisBus({ prefix, retry: { maxAttempts: 3, baseDelayMs: 5 } });
    restarted.bus.subscribe("ConversionRecorded", handler);

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(handler.mock.calls.map(([event]) => event.id).sort()).toEqual(["offline-1", "offline-2"]);
    await restarted.bus.close();
  });

  it("recovers unacked pending entries after a restart", async () => {
    const { prefix } = makeRedisBus();
    const group = `g:${randomUUID()}`;
    const failingHandler = vi.fn(() => {
      throw new Error("crash before ack");
    });
    const failing = makeRedisBus({
      prefix,
      group,
      retry: { maxAttempts: 50, baseDelayMs: 60_000 },
      consumerName: "crashed-consumer",
    });
    failing.bus.subscribe("CommissionRecorded", failingHandler);
    await failing.bus.publish(testEvent("CommissionRecorded", "pending-1"));
    await vi.waitFor(() => expect(failingHandler).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await failing.bus.close();

    const recovered = makeRedisBus({
      prefix,
      group,
      retry: { maxAttempts: 3, baseDelayMs: 20 },
      consumerName: "restarted-consumer",
    });
    const handler = vi.fn();
    recovered.bus.subscribe("CommissionRecorded", handler);

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(handler.mock.calls[0]?.[0].id).toBe("pending-1");
    await recovered.bus.close();
  });

  it("routes consume-side invalid payloads to the dead-letter path", async () => {
    const prefix = `t:${randomUUID()}`;
    const inner = new RedisStreamsEventBus<DomainEvent>({
      url: REDIS_URL,
      prefix,
      group: `g:${randomUUID()}`,
      pollIntervalMs: 10,
      retry: { maxAttempts: 2, baseDelayMs: 5 },
    });
    const typed = new TypedDomainEventBus(inner);
    const handler = vi.fn();
    typed.subscribe("ContentFailed", handler);

    const validEvent = (): DomainEvent =>
      ContentFailedSchema.parse({
        type: "ContentFailed",
        id: randomUUID(),
        orgId: randomUUID(),
        occurredAt: new Date().toISOString(),
        actor: "system",
        contentId: randomUUID(),
        reason: "render failed",
        attempt: 1,
      });

    await typed.publish(validEvent());
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce(), { timeout: 5000 });

    const corrupted = { ...validEvent(), attempt: 0 } as unknown as DomainEvent;
    await inner.publish(corrupted);
    await vi.waitFor(() => expect(typed.getDeadLetters()).toHaveLength(1), { timeout: 5000 });
    const deadLetters = typed.getDeadLetters();
    expect(deadLetters[0]?.error).toBeInstanceOf(EventValidationError);
    expect((deadLetters[0]?.error as EventValidationError).scope).toBe("consume");
    await typed.close();
  });

  it("dedupes redeliveries with the Redis-backed idempotency store", async () => {
    const client = createClient({ url: REDIS_URL });
    client.on("error", () => undefined);
    await client.connect();
    cleanupClients.push(client);

    const store = new RedisDedupeStore({ client, prefix: `t:${randomUUID()}` });
    const handler = vi.fn();
    const wrapped = withIdempotency(handler, { store });
    const event = { type: "CommissionRecorded", id: "money-1" };

    await wrapped(event);
    await wrapped(event);
    await wrapped(event);

    expect(handler).toHaveBeenCalledOnce();
    expect(await store.reserve("money-1")).toBe(false);
  });

  it("expires idempotency reservations after the configured TTL", async () => {
    const client = createClient({ url: REDIS_URL });
    client.on("error", () => undefined);
    await client.connect();
    cleanupClients.push(client);

    const store = new RedisDedupeStore({ client, prefix: `t:${randomUUID()}`, ttlMs: 50 });
    expect(await store.reserve("ttl-1")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await store.reserve("ttl-1")).toBe(true);
  });

  it("keeps exactly-once effectiveness under concurrent redelivery", async () => {
    const client = createClient({ url: REDIS_URL });
    client.on("error", () => undefined);
    await client.connect();
    cleanupClients.push(client);

    const store = new RedisDedupeStore({ client, prefix: `t:${randomUUID()}` });
    const applied: string[] = [];
    const wrapped = withIdempotency<{ id: string }>(async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      applied.push(event.id);
    }, { store });

    await Promise.all(Array.from({ length: 8 }, () => wrapped({ id: "race-1" })));
    expect(applied).toEqual(["race-1"]);
  });
});

describe("withIdempotency (store-agnostic)", () => {
  it("invokes the handler once per event id and skips redeliveries", async () => {
    const reserved = new Set<string>();
    const store: IdempotencyStore = {
      reserve: async (key) => {
        if (reserved.has(key)) return false;
        reserved.add(key);
        return true;
      },
    };
    const handler = vi.fn();
    const wrapped = withIdempotency<TestEvent>(handler, { store });

    await wrapped(testEvent("ClickRecorded", "k1"));
    await wrapped(testEvent("ClickRecorded", "k1"));
    await wrapped(testEvent("ClickRecorded", "k2"));

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("releases the reservation when the handler fails so redelivery can retry", async () => {
    const reserved = new Set<string>();
    const store: IdempotencyStore = {
      reserve: async (key) => {
        if (reserved.has(key)) return false;
        reserved.add(key);
        return true;
      },
      release: async (key) => {
        reserved.delete(key);
      },
    };
    let attempts = 0;
    const wrapped = withIdempotency<TestEvent>(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
    }, { store });

    await expect(wrapped(testEvent("ClickRecorded", "k1"))).rejects.toThrow("transient");
    await wrapped(testEvent("ClickRecorded", "k1"));
    expect(attempts).toBe(2);
  });
});
