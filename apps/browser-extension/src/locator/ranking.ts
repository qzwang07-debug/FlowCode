import type { BrowserLocator } from "../../../../common/browser";

export interface LocatorCandidateInput {
  kind: BrowserLocator["kind"];
  value: string;
  unique: boolean;
  stable?: boolean;
}

const BASE_SCORES: Record<BrowserLocator["kind"], number> = {
  role: 100,
  label: 95,
  "test-id": 90,
  id: 85,
  placeholder: 75,
  text: 70,
  css: 30,
};

export function isStableDomId(value: string): boolean {
  if (!value || value.length > 128 || /\s/.test(value)) return false;
  if (/^\d+$/.test(value)) return false;
  if (/^[a-f\d]{16,}$/i.test(value)) return false;
  if (/^[a-f\d]{8}-[a-f\d-]{27,}$/i.test(value)) return false;
  if (/(?:^|[-_])(?:ember|react|vue|radix|headlessui)-?\d{3,}$/i.test(value)) {
    return false;
  }
  const digitRatio =
    [...value].filter((character) => /\d/.test(character)).length /
    value.length;
  return digitRatio < 0.5;
}

export function rankLocatorCandidates(
  inputs: readonly LocatorCandidateInput[],
): BrowserLocator[] {
  const seen = new Set<string>();
  const ranked: BrowserLocator[] = [];
  for (const input of inputs) {
    const value = input.value.trim().slice(0, 512);
    if (!value) continue;
    const key = `${input.kind}\0${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let score = BASE_SCORES[input.kind];
    if (!input.unique) score -= 35;
    if (input.stable === false) score -= 25;
    ranked.push({
      kind: input.kind,
      value,
      unique: input.unique,
      score: Math.max(0, Math.min(100, score)),
    });
  }
  return ranked.sort((left, right) => right.score - left.score).slice(0, 12);
}
