import { expect, it, vi } from "vitest";
import type { EventBus } from "./types.js";

export interface TestEvent {
  type: string;
  id: string;
}

export const testEvent = (type: string, id: string): TestEvent => ({ type, id });

export interface BusContractOptions {
  retry?: { maxAttempts: number; baseDelayMs: number };
  deadLetterCapacity?: number;
  onDeadLetter?: (entry: unknown) => void;
}

export interface BusFixture {
  bus: EventBus<TestEvent>;
  deadLetterIds(): string[] | Promise<string[]>;
}

/**
 * Behavioral contract shared by every EventBus adapter (ADR-0004). Both the
 * in-memory bus and durable adapters must pass this suite.
 */
export function describeBusContract(
  prefix: string,
  makeBus: (options?: BusContractOptions) => BusFixture,
): void {
  it(`${prefix}: delivers a published event to a matching subscriber`, async () => {
    const { bus } = makeBus();
    const handler = vi.fn();
    bus.subscribe("ProductDiscovered", handler);

    await bus.publish(testEvent("ProductDiscovered", "e1"));

    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(handler).toHaveBeenCalledWith({ type: "ProductDiscovered", id: "e1" });
    await bus.close();
  });

  it(`${prefix}: supports wildcard patterns and multiple subscribers`, async () => {
    const { bus } = makeBus();
    const exact = vi.fn();
    const wildcard = vi.fn();
    const other = vi.fn();
    bus.subscribe("ContentPublished", exact);
    bus.subscribe("Content*", wildcard);
    bus.subscribe("ClickRecorded", other);

    await bus.publish(testEvent("ContentPublished", "e2"));

    await vi.waitFor(() => expect(exact).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(wildcard).toHaveBeenCalledOnce());
    expect(other).not.toHaveBeenCalled();
    await bus.close();
  });

  it(`${prefix}: stops delivery after unsubscribe`, async () => {
    const { bus } = makeBus();
    const handler = vi.fn();
    const unsubscribe = bus.subscribe("*", handler);
    unsubscribe();

    await bus.publish(testEvent("ProductRanked", "e3"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handler).not.toHaveBeenCalled();
    await bus.close();
  });

  it(`${prefix}: retries a throwing handler then dead-letters after maxAttempts`, async () => {
    const { bus, deadLetterIds } = makeBus();
    let calls = 0;
    bus.subscribe("ContentFailed", () => {
      calls += 1;
      throw new Error("boom");
    });

    await bus.publish(testEvent("ContentFailed", "e4"));

    await vi.waitFor(async () => expect(await deadLetterIds()).toContain("e4"));
    expect(calls).toBe(3);
    await bus.close();
  });

  it(`${prefix}: notifies the optional dead-letter callback with entry parity`, async () => {
    const onDeadLetter = vi.fn();
    const { bus } = makeBus({ onDeadLetter });
    bus.subscribe("ContentFailed", () => {
      throw new Error("fail");
    });

    await bus.publish(testEvent("ContentFailed", "e5"));

    await vi.waitFor(() => expect(onDeadLetter).toHaveBeenCalledOnce());
    expect(onDeadLetter.mock.calls[0]?.[0].event.id).toBe("e5");
    await bus.close();
  });

  it(`${prefix}: caps dead letters by evicting the oldest entry`, async () => {
    const { bus, deadLetterIds } = makeBus({ deadLetterCapacity: 2 });
    bus.subscribe("ContentFailed", () => {
      throw new Error("always");
    });

    for (const id of ["f1", "f2", "f3"]) {
      await bus.publish(testEvent("ContentFailed", id));
    }

    await vi.waitFor(async () => {
      const ids = await deadLetterIds();
      expect(ids).toEqual(["f2", "f3"]);
    });
    await bus.close();
  });

  it(`${prefix}: rejects publish after close and closes idempotently`, async () => {
    const { bus } = makeBus();
    await bus.publish(testEvent("ProductDiscovered", "h1"));
    await bus.close();

    await expect(bus.publish(testEvent("ProductDiscovered", "h2"))).rejects.toThrow(/closed/);
    await expect(bus.close()).resolves.toBeUndefined();
  });
}
