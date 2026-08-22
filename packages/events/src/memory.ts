import type { EventBus, EventHandler } from "./types.js";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 25,
};

export interface DeadLetterEntry<E> {
  readonly event: E;
  readonly error: unknown;
  readonly attempts: number;
  readonly failedAt: string;
}

export interface InMemoryEventBusOptions {
  retry?: Partial<RetryPolicy>;
  deadLetterCapacity?: number;
  onDeadLetter?: (entry: DeadLetterEntry<unknown>) => void;
}

interface Subscription<E> {
  pattern: string;
  handler: EventHandler<E>;
  active: boolean;
}

function matches(pattern: string, type: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}

/**
 * In-process EventBus. Dispatch is synchronous for sync handlers; a throwing
 * handler is retried with exponential backoff (baseDelayMs * 2^(attempt-1))
 * and dead-lettered after maxAttempts total tries. Delivery is at-most-once.
 * The dead-letter list is capped; when full the oldest entry is evicted.
 */
export class InMemoryEventBus<E extends { type: string }> implements EventBus<E> {
  private readonly retry: RetryPolicy;
  private readonly capacity: number;
  private readonly onDeadLetter?: (entry: DeadLetterEntry<unknown>) => void;
  private readonly subscriptions = new Set<Subscription<E>>();
  private readonly deadLetters: DeadLetterEntry<E>[] = [];
  private readonly idleWaiters: Array<() => void> = [];
  private pendingDeliveries = 0;
  private closed = false;

  constructor(options: InMemoryEventBusOptions = {}) {
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.capacity = options.deadLetterCapacity ?? 1000;
    this.onDeadLetter = options.onDeadLetter;
  }

  async publish(event: E): Promise<void> {
    if (this.closed) throw new Error("event bus is closed");
    for (const sub of [...this.subscriptions]) {
      if (sub.active && matches(sub.pattern, event.type)) {
        this.deliver(sub, event, 1);
      }
    }
    await Promise.resolve();
  }

  subscribe(typeOrPattern: string, handler: EventHandler<E>): () => void {
    const sub: Subscription<E> = { pattern: typeOrPattern, handler, active: true };
    this.subscriptions.add(sub);
    return () => {
      sub.active = false;
      this.subscriptions.delete(sub);
    };
  }

  /** Resolves when no deliveries or retries are in flight (test/drain hook). */
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
  }

  private deliver(sub: Subscription<E>, event: E, attempt: number): void {
    this.pendingDeliveries += 1;
    this.attemptDelivery(sub, event, attempt);
  }

  private attemptDelivery(sub: Subscription<E>, event: E, attempt: number): void {
    const finish = () => this.settle();
    if (!sub.active || this.closed) return finish();
    try {
      const result = sub.handler(event);
      if (result instanceof Promise) {
        void result.then(finish, (error: unknown) =>
          this.handleFailure(sub, event, error, attempt),
        );
      } else {
        finish();
      }
    } catch (error) {
      this.handleFailure(sub, event, error, attempt);
    }
  }

  private handleFailure(
    sub: Subscription<E>,
    event: E,
    error: unknown,
    attempt: number,
  ): void {
    if (!sub.active || this.closed || attempt >= this.retry.maxAttempts) {
      if (sub.active && !this.closed) this.deadLetter(event, error, attempt);
      this.settle();
      return;
    }
    // The in-flight token is transferred to the timer; attemptDelivery
    // releases it on every exit path once the retry runs.
    const delayMs = this.retry.baseDelayMs * 2 ** (attempt - 1);
    const timer = setTimeout(() => {
      this.attemptDelivery(sub, event, attempt + 1);
    }, delayMs);
    timer.unref?.();
  }

  private settle(): void {
    this.pendingDeliveries -= 1;
    if (this.pendingDeliveries === 0) {
      while (this.idleWaiters.length > 0) this.idleWaiters.shift()?.();
    }
  }

  private deadLetter(event: E, error: unknown, attempts: number): void {
    if (this.deadLetters.length >= this.capacity) this.deadLetters.shift();
    const entry: DeadLetterEntry<E> = {
      event,
      error,
      attempts,
      failedAt: new Date().toISOString(),
    };
    this.deadLetters.push(entry);
    this.onDeadLetter?.(entry as DeadLetterEntry<unknown>);
  }
}
