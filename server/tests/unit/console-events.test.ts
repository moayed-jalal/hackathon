import { describe, expect, it, vi } from "vitest";
import { _subscriberCount, publishConsoleEvent, subscribeConsoleEvents, type ConsoleEvent } from "../../src/modules/console/events.js";

function event(overrides: Partial<ConsoleEvent> = {}): ConsoleEvent {
  return {
    id: "cevt_test_1",
    type: "payment.status_changed",
    payment_intent_id: "pi_test_1",
    merchant_id: "merchant-a",
    status: "succeeded",
    previous_status: "processing",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("console events (in-process pub/sub)", () => {
  it("delivers a published event only to subscribers of that merchant", async () => {
    const receivedA: ConsoleEvent[] = [];
    const receivedB: ConsoleEvent[] = [];
    const unsubA = subscribeConsoleEvents("merchant-a", (e) => receivedA.push(e));
    const unsubB = subscribeConsoleEvents("merchant-b", (e) => receivedB.push(e));

    publishConsoleEvent(event({ merchant_id: "merchant-a" }));
    await flushMicrotasks();

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(0);

    unsubA();
    unsubB();
  });

  it("delivers to multiple subscribers of the same merchant", async () => {
    const receivedX: ConsoleEvent[] = [];
    const receivedY: ConsoleEvent[] = [];
    const unsubX = subscribeConsoleEvents("merchant-multi", (e) => receivedX.push(e));
    const unsubY = subscribeConsoleEvents("merchant-multi", (e) => receivedY.push(e));

    publishConsoleEvent(event({ merchant_id: "merchant-multi", id: "cevt_test_multi" }));
    await flushMicrotasks();

    expect(receivedX.map((e) => e.id)).toEqual(["cevt_test_multi"]);
    expect(receivedY.map((e) => e.id)).toEqual(["cevt_test_multi"]);

    unsubX();
    unsubY();
  });

  it("stops delivering after unsubscribe and cleans up the subscriber count", async () => {
    const received: ConsoleEvent[] = [];
    const unsub = subscribeConsoleEvents("merchant-unsub", (e) => received.push(e));
    expect(_subscriberCount("merchant-unsub")).toBe(1);

    unsub();
    expect(_subscriberCount("merchant-unsub")).toBe(0);

    publishConsoleEvent(event({ merchant_id: "merchant-unsub" }));
    await flushMicrotasks();
    expect(received).toHaveLength(0);
  });

  it("publishing to a merchant with no subscribers is a no-op, not an error", () => {
    expect(() => publishConsoleEvent(event({ merchant_id: "no-one-listening" }))).not.toThrow();
  });

  it("one listener throwing does not prevent another listener on the same merchant from receiving the event", async () => {
    const received: ConsoleEvent[] = [];
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const unsubBad = subscribeConsoleEvents("merchant-throws", () => {
      throw new Error("listener boom");
    });
    const unsubGood = subscribeConsoleEvents("merchant-throws", (e) => received.push(e));

    publishConsoleEvent(event({ merchant_id: "merchant-throws" }));
    await flushMicrotasks();

    expect(received).toHaveLength(1);
    consoleErrorSpy.mockRestore();
    unsubBad();
    unsubGood();
  });

  it("delivery is asynchronous (does not run synchronously inside publish)", () => {
    const received: ConsoleEvent[] = [];
    const unsub = subscribeConsoleEvents("merchant-async", (e) => received.push(e));

    publishConsoleEvent(event({ merchant_id: "merchant-async" }));
    // Nothing delivered yet — publish must never block its caller on delivery.
    expect(received).toHaveLength(0);

    unsub();
  });
});
