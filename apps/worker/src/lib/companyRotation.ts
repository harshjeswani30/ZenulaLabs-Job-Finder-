import type { JobSourceSpec } from "@jobfinder/shared";
import { GREENHOUSE_SLUGS, LEVER_SLUGS, SMARTRECRUITERS_SLUGS } from "../sources/catalog";

/** Rotating company-board batches: every run picks a different slice of the
 * 1159-company catalog, so each company gets checked roughly once per
 * (catalogSize / perRunCount) hours without any DB state — the offset is
 * derived deterministically from the epoch hour. */

type RotatableType = "greenhouse" | "lever" | "smartrecruiters";

const SLUGS: Record<RotatableType, readonly string[]> = {
  greenhouse: GREENHOUSE_SLUGS,
  lever: LEVER_SLUGS,
  smartrecruiters: SMARTRECRUITERS_SLUGS,
};

export function getRotatingSpecs(type: RotatableType, offset: number, count: number): JobSourceSpec[] {
  const slugs = SLUGS[type];
  if (slugs.length === 0 || count <= 0) return [];
  const specs: JobSourceSpec[] = [];
  for (let i = 0; i < Math.min(count, slugs.length); i++) {
    specs.push({ type, slug: slugs[(offset + i) % slugs.length] });
  }
  return specs;
}

/** Deterministic per-hour offset — same across the run, different next hour. */
export function currentRotationOffset(): number {
  return Math.floor(Date.now() / 3_600_000);
}

/** The default rotation mix appended to explicit user sources.
 *  Split favors the two big catalogs (Greenhouse, SmartRecruiters) so the
 *  full 1159-company set cycles faster: 20 boards/run ≈ 60 runs ≈ 2.5 days
 *  to cover every company at a 1-hour cadence. */
export function defaultRotationSpecs(count = 20): JobSourceSpec[] {
  const offset = currentRotationOffset();
  const gh = Math.ceil(count * 0.4);   // 8 of 20 — 767-company catalog
  const sr = Math.ceil(count * 0.4);   // 8 of 20 — 217-company catalog
  const lv = count - gh - sr;          // 4 of 20 — 175-company catalog
  return [
    ...getRotatingSpecs("greenhouse", offset, gh),
    ...getRotatingSpecs("smartrecruiters", offset + 400, sr),
    ...getRotatingSpecs("lever", offset + 200, lv),
  ].slice(0, count);
}
