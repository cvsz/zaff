import { describe, expect, it, vi } from "vitest";
import { InMemoryEventBus } from "./memory.js";

interface TestEvent {
  type: string;
  id: string;
}

const event = (type: string, id: string): TestEvent => ({ type, id });
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function makeBus(options?: ConstructorParameters<typeof InMemoryEventBus<TestEvent>>[0]) {
  return new InMemoryEventBus<TestEvent>(options);
}

describe("InMemoryEventBus", () => {
  it("delivers a published event to a matching subscriber", async () => {
    const bus = makeBus();
    const handler = vi.fn();
    bus.subscribe("ProductDiscovered", handler);

    await bus.publish(event("ProductDiscovered", "e1"));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ type: "ProductDiscovered", id: "e1" });
    await bus.close();
  });

  it("supports wildcard patterns and multiple subscribers", async () => {
    const bus = makeBus();
    const exact = vi.fn();
    const wildcard = vi.fn();
    const other = vi.fn();
    bus.subscribe("ContentPublished", exact);
    bus.subscribe("Content*", wildcard);
    bus.subscribe("ClickRecorded", other);

    await bus.publish(event("ContentPublished", "e2"));
    await bus.waitForIdle();

    expect(exact).toHaveBeenCalledOnce();
    expect(wildcard).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
    await bus.close();
  });

  it("stops delivery after unsubscribe", async () => {
    const bus = makeBus();
    const handler = vi.fn();
    const unsubscribe = bus.subscribe("*", handler);
    unsubscribe();

    await bus.publish(event("ProductRanked", "e3"));

    expect(handler).not.toHaveBeenCalled();
    await bus.close();
  });

  it("retries a throwing handler with backoff then dead-letters after maxAttempts", async () => {
    const bus = makeBus({
      retry: { maxAttempts: 3, baseDelayMs: 1 },
      deadLetterCapacity: 10,
    });
    let calls = 0;
    bus.subscribe("ContentFailed", () => {
      calls += 1;
      throw new Error("boom");
    });

    await bus.publish(event("ContentFailed", "e4"));
    await bus.waitForIdle();

    expect(calls).toBe(3);
    const deadLetters = bus.getDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]?.attempts).toBe(3);
    expect(deadLetters[0]?.event.id).toBe("e4");
    expect((deadLetters[0]?.error as Error).message).toBe("boom");
    await bus.close();
  });

  it("notifies the optional dead-letter handler", async () => {
    const onDeadLetter = vi.fn();
    const bus = makeBus({
      retry: { maxAttempts: 1, baseDelayMs: 1 },
      onDeadLetter,
    });
    bus.subscribe("ContentFailed", () => {
      throw new Error("fail");
    });

    await bus.publish(event("ContentFailed", "e5"));
    await bus.waitForIdle();

    expect(onDeadLetter).toHaveBeenCalledOnce();
    expect(onDeadLetter.mock.calls[0]?.[0].event.id).toBe("e5");
    await bus.close();
  });

  it("caps the dead-letter list by evicting the oldest entry", async () => {
    const bus = makeBus({
      retry: { maxAttempts: 1, baseDelayMs: 1 },
      deadLetterCapacity: 2,
    });
    bus.subscribe("ContentFailed", () => {
      throw new Error("always");
    });

    for (const id of ["f1", "f2", "f3"]) {
      await bus.publish(event("ContentFailed", id));
    }
    await bus.waitForIdle();

    const ids = bus.getDeadLetters().map((entry) => entry.event.id);
    expect(ids).toEqual(["f2", "f3"]);
    await bus.close();
  });

  it("does not deliver to handlers removed while a retry is pending", async () => {
    const bus = makeBus({ retry: { maxAttempts: 3, baseDelayMs: 1 } });
    const handler = vi.fn(() => {
      throw new Error("transient");
    });
    const unsubscribe = bus.subscribe("ContentFailed", handler);

    void bus.publish(event("ContentFailed", "g1"));
    unsubscribe();
    await bus.waitForIdle();

    expect(handler).toHaveBeenCalledOnce();
    expect(bus.getDeadLetters()).toHaveLength(0);
    await bus.close();
  });

  it("rejects publish after close and closes idempotently", async () => {
    const bus = makeBus();
    await bus.publish(event("ProductDiscovered", "h1"));
    await flush();
    await bus.close();

    await expect(bus.publish(event("ProductDiscovered", "h2"))).rejects.toThrow(
      /closed/,
    );
    await expect(bus.close()).resolves.toBeUndefined();
  });
});
