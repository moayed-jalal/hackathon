import { createHash } from "node:crypto";

/** Deterministic JSON stringification (sorted keys) so equivalent payloads always hash the same. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

export function hashRequestBody(body: unknown): string {
  return createHash("sha256").update(stableStringify(body)).digest("hex");
}
