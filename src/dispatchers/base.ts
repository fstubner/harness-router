/**
 * STUB — owned by Agent 2 (or whichever agent writes dispatchers).
 * Replaced at merge. Minimal interface so Agent 4's router tests can run.
 */

import type { DispatchResult, QuotaInfo } from "../types.js";

export interface DispatchOpts {
  modelOverride?: string;
  timeoutMs?: number;
}

export interface Dispatcher {
  readonly id: string;
  dispatch(
    prompt: string,
    files: string[],
    workingDir: string,
    opts?: DispatchOpts,
  ): Promise<DispatchResult>;
  checkQuota(): Promise<QuotaInfo>;
  isAvailable(): boolean;
}
