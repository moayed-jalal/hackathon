import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, isTerminal, InvalidTransitionError } from "../../src/modules/payment-intents/state-machine.js";

describe("payment state machine", () => {
  it("allows the documented happy-path transitions", () => {
    expect(canTransition("created", "processing")).toBe(true);
    expect(canTransition("created", "succeeded")).toBe(true);
    expect(canTransition("created", "failed")).toBe(true);
    expect(canTransition("created", "cancelled")).toBe(true);
    expect(canTransition("processing", "succeeded")).toBe(true);
    expect(canTransition("processing", "failed")).toBe(true);
  });

  it("rejects transitions out of terminal states", () => {
    expect(canTransition("succeeded", "failed")).toBe(false);
    expect(canTransition("succeeded", "processing")).toBe(false);
    expect(canTransition("failed", "succeeded")).toBe(false);
    expect(canTransition("cancelled", "processing")).toBe(false);
  });

  it("rejects skipping straight from processing back to created", () => {
    expect(canTransition("processing", "created")).toBe(false);
  });

  it("treats succeeded, failed, and cancelled as terminal", () => {
    expect(isTerminal("succeeded")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("created")).toBe(false);
    expect(isTerminal("processing")).toBe(false);
  });

  it("assertTransition throws a typed error on an invalid transition", () => {
    expect(() => assertTransition("succeeded", "cancelled")).toThrow(InvalidTransitionError);
  });

  it("assertTransition is a no-op on a valid transition", () => {
    expect(() => assertTransition("created", "processing")).not.toThrow();
  });
});
