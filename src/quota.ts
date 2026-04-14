/**
 * STUB — owned by Agent 3. Replaced at merge. Minimal implementation here
 * so Agent 4's router tests can run in isolation.
 */

import type { DispatchResult } from "./types.js";

export class QuotaState {
  static empty(): QuotaState {
    return new QuotaState();
  }
}

export class QuotaCache {
  async getQuotaScore(_service: string): Promise<number> {
    return 1.0;
  }
  recordResult(_service: string, _result: DispatchResult): void {
    /* stub */
  }
  fullStatus(): Record<string, unknown> {
    return {};
  }
}
