/** Injectable clock so tests control "now" deterministically. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Years between two instants using ACT/365 fixed. Negative -> 0. */
export function act365FixedYears(from: Date, to: Date): number {
  const years = (to.getTime() - from.getTime()) / (365 * 24 * 60 * 60 * 1000);
  return Math.max(0, years);
}
