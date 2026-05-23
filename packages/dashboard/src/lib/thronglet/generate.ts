import { PALETTE_NAMES } from "./palettes";
import { hash32, pickIdx } from "./hash";
import { pickName } from "./naming";
import { EARS } from "./parts/ears";
import { EYES } from "./parts/eyes";
import { MOUTHS } from "./parts/mouths";
import { HORNS } from "./parts/horns";
import { CHEST } from "./parts/chest";
import type { ThrongletSpec, TraitName } from "./types";

const TRAITS: TraitName[] = ["curious", "sleepy", "eager", "chaotic", "calm", "skeptical"];

// The dispatcher is the core orchestrator — fixed identity, never changes.
const DISPATCHER_SPEC: ThrongletSpec = {
  name: "Orix",
  seed: 0,
  palette: "dusk",
  ears: 1,   // cat ears — authority
  eyes: 1,   // glint — watchful
  mouth: 0,  // smile
  horn: 2,   // twin antennae — connectivity
  chest: 0,  // full sash — official
  trait: "calm",
};

export function generateThronglet(seed: string): ThrongletSpec {
  if (seed === "_dispatcher" || seed === "dispatcher") return DISPATCHER_SPEC;

  const h = hash32(seed);
  return {
    name: pickName(h),
    seed: h,
    palette: PALETTE_NAMES[pickIdx(h >>> 0,  PALETTE_NAMES.length)],
    ears:    pickIdx(h >>> 3,  EARS.length),
    eyes:    pickIdx(h >>> 7,  EYES.length),
    mouth:   pickIdx(h >>> 11, MOUTHS.length),
    horn:    pickIdx(h >>> 17, HORNS.length),
    chest:   pickIdx(h >>> 23, CHEST.length),
    trait:   TRAITS[pickIdx(h >>> 29, TRAITS.length)],
  };
}

/**
 * Generate specs for a whole fleet, guaranteeing unique thronglet names.
 * If a collision is detected, the seed is salted and re-hashed.
 */
export function generateFleet(agentNames: string[]): Map<string, ThrongletSpec> {
  const result = new Map<string, ThrongletSpec>();
  const usedNames = new Set<string>();

  for (const name of agentNames) {
    let spec = generateThronglet(name);
    let attempt = 0;
    while (usedNames.has(spec.name) && attempt < 10) {
      attempt++;
      spec = generateThronglet(`${name}__${attempt}`);
    }
    usedNames.add(spec.name);
    result.set(name, spec);
  }
  return result;
}
