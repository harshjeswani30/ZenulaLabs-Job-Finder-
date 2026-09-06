import type { JobSourceSpec } from "@jobfinder/shared";
import type { SourceParser } from "./types";
import { parseRemotive } from "./remotive";
import { parseArbeitnow } from "./arbeitnow";
import { parseRemoteOK } from "./remoteok";
import { parseGreenhouse } from "./greenhouse";
import { parseLever } from "./lever";

const PARSERS: Record<JobSourceSpec["type"], SourceParser | undefined> = {
  remotive: parseRemotive, arbeitnow: parseArbeitnow, remoteok: parseRemoteOK,
  greenhouse: parseGreenhouse, lever: parseLever, adzuna: undefined,
};

export function getSourceParser(type: JobSourceSpec["type"]): SourceParser {
  const p = PARSERS[type];
  if (!p) throw new Error(`No parser for source type: ${type}`);
  return p;
}
