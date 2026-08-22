export type EventHandler<E> = (event: E) => void | Promise<void>;

/**
 * Transport-agnostic port for moving domain events between producers and
 * consumers. Delivery semantics are implementation-defined: the bundled
 * in-memory bus is at-most-once (a handler that keeps failing exhausts its
 * retries and the event lands on the dead-letter list; nothing is persisted
 * or redelivered across process restarts). Distributed adapters behind this
 * port must document their own semantics (typically at-least-once + ack).
 */
export interface EventBus<E extends { type: string }> {
  publish(event: E): Promise<void>;
  subscribe(typeOrPattern: string, handler: EventHandler<E>): () => void;
  close(): Promise<void>;
}
