/**
 * STUB — owned by Agent 3. Replaced at merge. Minimal implementation here
 * so Agent 4's router tests can run in isolation.
 */

import type { ThinkingLevel } from "./types.js";

export class LeaderboardCache {
  async getQualityScore(
    _model: string | undefined,
    _thinking: ThinkingLevel | undefined,
  ): Promise<{ qualityScore: number; elo: number | null }> {
    return { qualityScore: 1.0, elo: null };
  }

  async autoTier(
    _model: string | undefined,
    _thinking: ThinkingLevel | undefined,
    fallbackTier: number,
  ): Promise<number> {
    return fallbackTier;
  }
}
