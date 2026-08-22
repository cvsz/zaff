import type { z } from "zod";
import { DomainEventSchema, type DomainEvent } from "./domain.js";
import { InMemoryEventBus, type DeadLetterEntry } from "./memory.js";
import type { EventBus } from "./types.js";

/**
 * Any EventBus over domain events, optionally exposing the drain/DLQ hooks
 * (the in-memory bus has them; adapters may implement their own equivalents).
 */
export type TypedInnerBus = EventBus<DomainEvent> & {
  waitForIdle?: () => Promise<void>;
  getDeadLetters?: () => readonly DeadLetterEntry<DomainEvent>[];
};

export class EventValidationError extends Error {
  readonly scope: "publish" | "consume";
  readonly issues: z.ZodIssue[];

  constructor(scope: "publish" | "consume", issues: z.ZodIssue[]) {
    super(`domain event validation failed at ${scope}: ${issues.length} issue(s)`);
    this.name = "EventValidationError";
    this.scope = scope;
    this.issues = issues;
  }
}

function validate(event: unknown, scope: "publish" | "consume"): DomainEvent {
  const result = DomainEventSchema.safeParse(event);
  if (!result.success) throw new EventValidationError(scope, result.error.issues);
  return result.data;
}

/**
 * EventBus wrapper for AGENTS.md §20 domain events. Payloads are
 * schema-validated on publish (invalid events are rejected before entering
 * the bus) and again on consume (an invalid event is never delivered raw to
 * a handler; it fails validation and flows through the inner bus's
 * retry/dead-letter path instead).
 */
export class TypedDomainEventBus {
  private readonly inner: TypedInnerBus;

  constructor(inner: TypedInnerBus) {
    this.inner = inner;
  }

  async publish(event: DomainEvent): Promise<void> {
    const parsed = validate(event, "publish");
    await this.inner.publish(parsed);
  }

  subscribe(
    typeOrPattern: string,
    handler: (event: DomainEvent) => void | Promise<void>,
  ): () => void {
    return this.inner.subscribe(typeOrPattern, (event) => handler(validate(event, "consume")));
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  waitForIdle(): Promise<void> {
    return this.inner.waitForIdle?.() ?? Promise.resolve();
  }

  getDeadLetters(): readonly DeadLetterEntry<DomainEvent>[] {
    return this.inner.getDeadLetters?.() ?? [];
  }
}

export function createTypedDomainEventBus(
  options?: ConstructorParameters<typeof InMemoryEventBus<DomainEvent>>[0],
): { bus: InMemoryEventBus<DomainEvent>; typed: TypedDomainEventBus } {
  const bus = new InMemoryEventBus<DomainEvent>(options);
  return { bus, typed: new TypedDomainEventBus(bus) };
}
