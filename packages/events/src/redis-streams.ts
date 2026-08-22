import { createClient, type RedisClientOptions } from "redis";
import { DEFAULT_RETRY_POLICY, type DeadLetterEntry, type RetryPolicy } from "./memory.js";
import type { EventBus, EventHandler } from "./types.js";

export interface IdempotencyStore {
  /** Returns true if the key was newly reserved; false when it already exists. */
  reserve(key: string, ttlMs?: number): Promise<boolean>;
  /** Optional release after handler failure so redelivery can retry. */
  release?(key: string): Promise<void>;
}

export interface RedisDedupeStoreOptions {
  client: RedisStreamsClient;
  prefix?: string;
  ttlMs?: number;
}

/**
 * SET NX PX-backed reservation store. Consumers of at-least-once delivery
 * (money paths such as ConversionRecorded/CommissionRecorded) wrap handlers
 * with `withIdempotency` so redeliveries are exactly-once-effective.
 */
export class RedisDedupeStore implements IdempotencyStore {
  private readonly client: RedisStreamsClient;
  private readonly prefix: string;
  readonly ttlMs: number;

  constructor(options: RedisDedupeStoreOptions) {
    this.client = options.client;
    this.prefix = options.prefix ?? "zaff:dedupe";
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  }

  async reserve(key: string, ttlMs = this.ttlMs): Promise<boolean> {
    const result = await this.client.set(`${this.prefix}:${key}`, "1", { PX: ttlMs, NX: true });
    return result === "OK";
  }

  async release(key: string): Promise<void> {
    await this.client.del(`${this.prefix}:${key}`);
  }
}

/** Skips redeliveries already processed within the dedupe TTL window. */
export function withIdempotency<E extends { id: string }>(
  handler: EventHandler<E>,
  options: { store: IdempotencyStore; ttlMs?: number },
): EventHandler<E> {
  return async (event: E) => {
    const fresh = await options.store.reserve(event.id, options.ttlMs);
    if (!fresh) return;
    try {
      await handler(event);
    } catch (error) {
      // release so a redelivery can retry the handler
      await options.store.release?.(event.id);
      throw error;
    }
  };
}

type StreamEntry = { id: string; message: Record<string, string | Buffer> };

/** Minimal subset of the node-redis client used by the bus (test seam). */
export interface RedisStreamsClient {
  connect(): Promise<unknown>;
  quit(): Promise<string>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  set(key: string, value: string, options?: { PX?: number; NX?: true }): Promise<string | null>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  del(...keys: string[]): Promise<number>;
  sAdd(key: string, member: string): Promise<number>;
  sMembers(key: string): Promise<string[]>;
  xAdd(key: string, id: string, fields: Record<string, string>): Promise<string>;
  xGroupCreate(key: string, group: string, id: string, options?: { MKSTREAM?: boolean }): Promise<"OK">;
  xReadGroup(
    group: string,
    consumer: string,
    streams: Array<{ key: string; id: string }> | { key: string; id: string },
    options?: { COUNT?: number; BLOCK?: number },
  ): Promise<Array<{ name: string; messages: Array<{ id: string; message: Record<string, string> }> }> | null>;
  xAutoClaim(
    key: string,
    group: string,
    consumer: string,
    minIdleTime: number,
    start: string,
    options?: { COUNT?: number },
  ): Promise<{ nextId: string; messages: Array<StreamEntry | null> }>;
  xAck(key: string, group: string, id: string | Array<string>): Promise<number>;
  xTrim(key: string, strategy: "MAXLEN" | "MINID", threshold: number, options?: { strategyModifier?: "=" | "~"; LIMIT?: number }): Promise<number>;
  xRange(key: string, start: string, end: string, count?: number): Promise<Array<{ id: string; message: Record<string, string> }>>;
  xLen(key: string): Promise<number>;
}

export interface RedisStreamsEventBusOptions {
  url?: string;
  clientOptions?: RedisClientOptions;
  client?: RedisStreamsClient;
  prefix?: string;
  group?: string;
  consumerName?: string;
  retry?: Partial<RetryPolicy>;
  deadLetterCapacity?: number;
  onDeadLetter?: (entry: DeadLetterEntry<unknown>) => void;
  pollIntervalMs?: number;
  batchSize?: number;
}

interface Subscription<E> {
  pattern: string;
  handler: EventHandler<E>;
  active: boolean;
  group: string;
  streams: Set<string>;
}

function matches(pattern: string, type: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}

function defaultConsumerName(): string {
  return (
    process.env.ZAFF_EVENT_CONSUMER_NAME ??
    `${process.env.HOSTNAME ?? "localhost"}:${process.pid}`
  );
}

function decode(entry: StreamEntry | null): { id: string; event: unknown } | null {
  if (!entry) return null;
  const payload = entry.message?.payload;
  if (typeof payload !== "string") return null;
  try {
    return { id: entry.id, event: JSON.parse(payload) };
  } catch {
    return null;
  }
}

/**
 * Durable EventBus adapter over Redis Streams. Semantics are
 * **at-least-once**: each event type lives in its own stream
 * (`{prefix}:events:{type}`), subscriptions use per-subscription consumer
 * groups, and a message is acked only after its handler succeeds. Failed
 * deliveries stay pending and are re-claimed with XAUTOCLAIM once they have
 * been idle for longer than the backoff window; after `maxAttempts`
 * deliveries the entry is copied to the capped dead-letter stream
 * `{prefix}:events:{type}:dlq`, acked, and surfaced through
 * `onDeadLetter`/`getDeadLetters` like the in-memory bus.
 *
 * Because redelivery can happen across process restarts, money-path
 * consumers MUST wrap handlers in `withIdempotency`.
 */
export class RedisStreamsEventBus<E extends { type: string }> implements EventBus<E> {
  private readonly retry: RetryPolicy;
  private readonly capacity: number;
  private readonly onDeadLetter?: (entry: DeadLetterEntry<unknown>) => void;
  private readonly prefix: string;
  private readonly groupBase: string;
  private readonly consumer: string;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly subscriptions = new Set<Subscription<E>>();
  private readonly deadLetters: DeadLetterEntry<E>[] = [];
  private readonly idleWaiters: Array<() => void> = [];
  private readonly timers: Set<NodeJS.Timeout> = new Set();
  private pendingDeliveries = 0;
  private closed = false;
  private subSeq = 0;

  private clientPromise?: Promise<RedisStreamsClient>;

  constructor(private readonly options: RedisStreamsEventBusOptions = {}) {
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.capacity = options.deadLetterCapacity ?? 1000;
    this.onDeadLetter = options.onDeadLetter;
    this.prefix = options.prefix ?? "zaff";
    this.groupBase = options.group ?? "zaff-group";
    this.consumer = options.consumerName ?? defaultConsumerName();
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
    this.batchSize = options.batchSize ?? 25;
  }

  streamKey(type: string): string {
    return `${this.prefix}:events:${type}`;
  }

  dlqStreamKey(type: string): string {
    return `${this.streamKey(type)}:dlq`;
  }

  private async client(): Promise<RedisStreamsClient> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        if (this.options.client) return this.options.client;
        const client = createClient({
          url: this.options.url ?? process.env.ZAFF_REDIS_URL ?? "redis://127.0.0.1:6379",
          ...this.options.clientOptions,
        }) as unknown as RedisStreamsClient;
        client.on("error", () => undefined);
        await client.connect();
        return client;
      })();
      this.clientPromise.catch(() => {
        this.clientPromise = undefined;
      });
    }
    return this.clientPromise;
  }

  async publish(event: E): Promise<void> {
    if (this.closed) throw new Error("event bus is closed");
    const client = await this.client();
    await client.sAdd(`${this.prefix}:event-types`, event.type);
    await client.xAdd(this.streamKey(event.type), "*", { payload: JSON.stringify(event) });
  }

  subscribe(typeOrPattern: string, handler: EventHandler<E>): () => void {
    const subscription: Subscription<E> = {
      pattern: typeOrPattern,
      handler,
      active: true,
      group: `${this.groupBase}:s${++this.subSeq}`,
      streams: new Set(),
    };
    this.subscriptions.add(subscription);
    void this.pump(subscription);
    return () => {
      subscription.active = false;
      this.subscriptions.delete(subscription);
    };
  }

  /** Resolves when no handler invocations are in flight (test/drain hook). */
  async waitForIdle(): Promise<void> {
    if (this.pendingDeliveries === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  getDeadLetters(): readonly DeadLetterEntry<E>[] {
    return [...this.deadLetters];
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.subscriptions.clear();
    while (this.idleWaiters.length > 0) this.idleWaiters.shift()?.();
    try {
      const client = await this.clientPromise;
      await client?.quit();
    } catch {
      // connection may already be broken; closing must not throw
    }
  }

  private settle(): void {
    this.pendingDeliveries -= 1;
    if (this.pendingDeliveries <= 0) {
      while (this.idleWaiters.length > 0) this.idleWaiters.shift()?.();
    }
  }

  private schedule(fn: () => void, delayMs: number): void {
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, delayMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  private async pump(subscription: Subscription<E>): Promise<void> {
    if (!subscription.active || this.closed) return;
    try {
      await this.pumpOnce(subscription);
    } catch {
      // transient broker errors are retried on the next tick
    }
    this.schedule(() => this.pump(subscription), this.pollIntervalMs);
  }

  private async pumpOnce(subscription: Subscription<E>): Promise<void> {
    const client = await this.client();
    const types = await client.sMembers(`${this.prefix}:event-types`);
    const targetTypes = types.filter((type) => matches(subscription.pattern, type));
    for (const type of targetTypes) {
      if (!subscription.streams.has(type)) {
        try {
          await client.xGroupCreate(this.streamKey(type), subscription.group, "0", { MKSTREAM: true });
        } catch (error) {
          if (!(error instanceof Error && error.message.includes("BUSYGROUP"))) throw error;
        }
        subscription.streams.add(type);
      }
    }
    if (subscription.streams.size === 0) return;
    const streams = [...subscription.streams].map((type) => ({
      key: this.streamKey(type),
      id: ">",
    }));
    const batches = await client.xReadGroup(
      subscription.group,
      this.consumer,
      streams,
      { COUNT: this.batchSize },
    );
    for (const batch of batches ?? []) {
      for (const raw of batch.messages ?? []) {
        const parsed = decode({ id: raw.id, message: raw.message });
        if (parsed) await this.deliver(subscription, batch.name, parsed.id, parsed.event as E);
      }
    }
    await this.reclaimPending(subscription, client);
  }

  private async reclaimPending(subscription: Subscription<E>, client: RedisStreamsClient): Promise<void> {
    const minIdleMs = Math.max(0, this.retry.baseDelayMs);
    for (const type of subscription.streams) {
      const key = this.streamKey(type);
      let cursor = "0-0";
      for (let page = 0; page < 10; page += 1) {
        const claim = await client.xAutoClaim(
          key,
          subscription.group,
          this.consumer,
          minIdleMs,
          cursor,
          { COUNT: this.batchSize },
        );
        for (const entry of claim.messages ?? []) {
          const parsed = decode(entry);
          if (parsed) await this.deliver(subscription, key, parsed.id, parsed.event as E);
        }
        cursor = claim.nextId;
        if (cursor === "0-0") break;
      }
    }
  }

  private async deliver(
    subscription: Subscription<E>,
    streamKey: string,
    messageId: string,
    event: E,
  ): Promise<void> {
    if (!subscription.active || this.closed) return;
    const client = await this.client();
    const attemptKey = `${this.prefix}:attempts:${subscription.group}:${messageId}`;
    const attempts = (await client.incr(attemptKey)) || 1;
    await client.expire(attemptKey, 7 * 24 * 60 * 60);

    if (attempts > this.retry.maxAttempts) {
      await this.deadLetter(client, subscription, streamKey, messageId, attemptKey, event, attempts - 1, new Error(`handler failed ${attempts - 1} time(s)`));
      return;
    }

    this.pendingDeliveries += 1;
    try {
      await subscription.handler(event);
    } catch (error) {
      if (attempts >= this.retry.maxAttempts) {
        await this.deadLetter(client, subscription, streamKey, messageId, attemptKey, event, attempts, error);
      }
      // otherwise leave pending so XAUTOCLAIM re-delivers after the backoff window
      return;
    } finally {
      this.settle();
    }
    if (!this.closed) await client.xAck(streamKey, subscription.group, messageId);
    await client.del(attemptKey);
  }

  private async deadLetter(
    client: RedisStreamsClient,
    subscription: Subscription<E>,
    streamKey: string,
    messageId: string,
    attemptKey: string,
    event: E,
    attempts: number,
    error: unknown,
  ): Promise<void> {
    const type = event.type;
    const entry: DeadLetterEntry<E> = {
      event,
      error,
      attempts,
      failedAt: new Date().toISOString(),
    };
    const dlqKey = this.dlqStreamKey(type);
    await client.xAdd(dlqKey, "*", {
      payload: JSON.stringify(event),
      sourceId: messageId,
      error: error instanceof Error ? error.message : String(error),
      attempts: String(attempts),
      failedAt: entry.failedAt,
    });
    await client.xTrim(dlqKey, "MAXLEN", this.capacity);
    await client.xAck(streamKey, subscription.group, messageId);
    await client.del(attemptKey);
    if (this.deadLetters.length >= this.capacity) this.deadLetters.shift();
    this.deadLetters.push(entry);
    this.onDeadLetter?.(entry as DeadLetterEntry<unknown>);
  }

  async dlqEntries(type: string, count = 100): Promise<Array<{ id: string; fields: Record<string, string> }>> {
    const client = await this.client();
    const entries = await client.xRange(this.dlqStreamKey(type), "-", "+", count);
    return entries.map((entry) => ({ id: entry.id, fields: entry.message }));
  }

  async dlqLength(type: string): Promise<number> {
    const client = await this.client();
    return client.xLen(this.dlqStreamKey(type));
  }
}
