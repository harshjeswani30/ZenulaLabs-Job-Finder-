import { describe, it, expect } from "vitest";
import { makeJobHash, snippet } from "../src/lib/hash";

describe("makeJobHash", () => {
  it("is stable across case/whitespace differences", async () => {
    const a = await makeJobHash("remotive", "Senior  React Dev ", "Acme Corp", "https://x.co/1");
    const b = await makeJobHash("Remotive", "senior react dev", "acme   corp", "https://x.co/1");
    expect(a).toBe(b);
  });
  it("differs when url differs", async () => {
    const a = await makeJobHash("remotive", "React Dev", "Acme", "https://x.co/1");
    const b = await makeJobHash("remotive", "React Dev", "Acme", "https://x.co/2");
    expect(a).not.toBe(b);
  });
  it("returns 64-char hex", async () => {
    const h = await makeJobHash("s", "t", "c", "u");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("snippet", () => {
  it("collapses whitespace and strips basic entities", () => {
    expect(snippet("Hello&nbsp;<b>world</b>\n\n   foo")).toBe("Hello world foo");
  });
  it("truncates to max with ellipsis", () => {
    expect(snippet("x".repeat(900), 800)).toHaveLength(801);
    expect(snippet("x".repeat(900), 800)!.endsWith("…")).toBe(true);
  });
});
