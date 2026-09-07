import { describe, it, expect } from "vitest";
import { getRotatingSpecs, defaultRotationSpecs } from "../src/lib/companyRotation";
import { GREENHOUSE_SLUGS, LEVER_SLUGS, SMARTRECRUITERS_SLUGS } from "../src/sources/catalog";

describe("getRotatingSpecs", () => {
  it("returns requested count of slug specs", () => {
    const specs = getRotatingSpecs("greenhouse", 0, 2);
    expect(specs).toHaveLength(2);
    expect(specs[0]).toEqual({ type: "greenhouse", slug: GREENHOUSE_SLUGS[0] });
    expect(specs[1]).toEqual({ type: "greenhouse", slug: GREENHOUSE_SLUGS[1] });
  });
  it("wraps around the catalog circularly", () => {
    const offset = GREENHOUSE_SLUGS.length - 1;
    const specs = getRotatingSpecs("greenhouse", offset, 2);
    expect(specs[0].slug).toBe(GREENHOUSE_SLUGS[offset]);
    expect(specs[1].slug).toBe(GREENHOUSE_SLUGS[0]);
  });
  it("count larger than catalog wraps without duplicates", () => {
    const specs = getRotatingSpecs("lever", 3, LEVER_SLUGS.length + 5);
    expect(specs).toHaveLength(LEVER_SLUGS.length);
    const unique = new Set(specs.map((s) => s.slug));
    expect(unique.size).toBe(LEVER_SLUGS.length);
  });
  it("count 0 → empty", () => {
    expect(getRotatingSpecs("smartrecruiters", 0, 0)).toEqual([]);
  });
});

describe("defaultRotationSpecs", () => {
  it("mixes greenhouse/lever/smartrecruiters up to count", () => {
    const specs = defaultRotationSpecs(6);
    expect(specs).toHaveLength(6);
    expect(specs.filter((s) => s.type === "greenhouse")).toHaveLength(2);
    expect(specs.filter((s) => s.type === "lever")).toHaveLength(2);
    expect(specs.filter((s) => s.type === "smartrecruiters")).toHaveLength(2);
    expect(SMARTRECRUITERS_SLUGS.length).toBe(217);
  });
});
