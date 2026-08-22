import { describe, expect, it, vi } from "vitest";
import { ContentFailedSchema, type DomainEvent } from "./domain.js";
import { createTypedDomainEventBus } from "./typed-bus.js";
import { EventValidationError } from "./typed-bus.js";

const uuid = "9b2f1a4e-3c5d-4e8f-9a0b-1c2d3e4f5a6b";
const uuid2 = "1c2d3e4f-5a6b-4c8d-9e0f-a1b2c3d4e5f6";

function validEvent(): DomainEvent {
  return ContentFailedSchema.parse({
    type: "ContentFailed",
    id: uuid,
    orgId: uuid2,
    occurredAt: new Date().toISOString(),
    actor: "system",
    contentId: uuid2,
    reason: "render failed",
    attempt: 1,
  });
}

describe("TypedDomainEventBus", () => {
  it("delivers a valid published event to a typed subscriber", async () => {
    const { typed } = createTypedDomainEventBus();
    const handler = vi.fn();
    typed.subscribe("ContentFailed", handler);

    const event = validEvent();
    await typed.publish(event);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(event);
    await typed.close();
  });

  it("rejects an invalid event at publish without notifying subscribers", async () => {
    const { typed } = createTypedDomainEventBus();
    const handler = vi.fn();
    typed.subscribe("*", handler);

    const invalid = { ...validEvent(), reason: "" };
    await expect(typed.publish(invalid)).rejects.toBeInstanceOf(EventValidationError);
    expect(handler).not.toHaveBeenCalled();
    expect(typed.getDeadLetters()).toHaveLength(0);
    await typed.close();
  });

  it("routes a consume-side invalid payload to the dead-letter path, never to the handler", async () => {
    const { bus, typed } = createTypedDomainEventBus({
      retry: { maxAttempts: 2, baseDelayMs: 1 },
    });
    const handler = vi.fn();
    typed.subscribe("ContentFailed", handler);
    await typed.publish(validEvent());

    const corrupted = { ...validEvent(), attempt: 0 } as unknown as DomainEvent;
    void bus.publish(corrupted).catch(() => undefined);
    await bus.waitForIdle();

    expect(handler).toHaveBeenCalledOnce();
    const deadLetters = bus.getDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]?.error).toBeInstanceOf(EventValidationError);
    expect((deadLetters[0]?.error as EventValidationError).scope).toBe("consume");
    expect((deadLetters[0]?.attempts ?? 0) > 1).toBe(true);
    await typed.close();
  });

  it("matches wildcard subscriptions on the typed layer", async () => {
    const { typed } = createTypedDomainEventBus();
    const handler = vi.fn();
    typed.subscribe("Creative*", handler);

    await typed.publish(
      ContentFailedSchema.parse({
        type: "ContentFailed",
        id: uuid,
        orgId: uuid,
        occurredAt: new Date().toISOString(),
        actor: uuid2,
        contentId: uuid,
        reason: "x",
        attempt: 3,
      }),
    );

    expect(handler).not.toHaveBeenCalled();
    await typed.close();
  });
});
