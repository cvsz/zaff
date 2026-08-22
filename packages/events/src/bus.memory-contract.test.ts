import { InMemoryEventBus } from "./memory.js";
import type { BusFixture, BusContractOptions } from "./bus.contract.js";
import { describeBusContract } from "./bus.contract.js";

describeBusContract("in-memory", (options?: BusContractOptions): BusFixture => {
  const bus = new InMemoryEventBus<TestEvent>({
    retry: { maxAttempts: 3, baseDelayMs: 1 },
    ...options,
  });
  return {
    bus,
    deadLetterIds: () => bus.getDeadLetters().map((entry) => entry.event.id),
  };
});
