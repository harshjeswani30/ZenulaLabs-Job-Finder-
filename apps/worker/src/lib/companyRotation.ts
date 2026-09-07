import type { JobSourceSpec } from "@jobfinder/shared";
import { GREENHOUSE_SLUGS, LEVER_SLUGS, SMARTRECRUITERS_SLUGS } from "../sources/catalog";

/** Rotating company-board batches: every run picks a different slice of the
 * 1205-company catalog, so each company gets checked roughly once per
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

/** The default rotation mix appended to explicit user sources. */
export function defaultRotationSpecs(count = 6): JobSourceSpec[] {
  const offset = currentRotationOffset();
  return [
    ...getRotatingSpecs("greenhouse", offset, Math.ceil(count / 3)),
    ...getRotatingSpecs("lever", offset + 200, Math.ceil(count / 3)),
    ...getRotatingSpecs("smartrecruiters", offset + 400, Math.floor(count / 3)),
  ].slice(0, count);
}
