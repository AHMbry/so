/**
 * modeManager.ts
 * Manages the active operating mode (Standard / Strict) and exposes the
 * alert threshold logic for that mode.
 *
 * Mode switches take effect immediately with no restart required (NF-07).
 * This class holds no state beyond the current mode — it is the single
 * source of truth for mode-dependent behavior thresholds.
 */

import { BoundedMode, BRIStateLabel } from '../types';

export class ModeManager {
  private mode: BoundedMode;

  constructor(initialMode: BoundedMode) {
    this.mode = initialMode;
  }

  public getMode(): BoundedMode {
    return this.mode;
  }

  /** Switches mode instantly — no restart needed (NF-07). */
  public setMode(mode: BoundedMode): void {
    this.mode = mode;
  }

  /**
   * Returns true when an alert should be shown for the given state label.
   *   Standard → alert only at 'severe'
   *   Strict   → alert at 'moderate' OR 'severe'
   */
  public shouldAlert(stateLabel: BRIStateLabel): boolean {
    if (this.mode === 'Strict') {
      return stateLabel === 'moderate' || stateLabel === 'severe';
    }
    return stateLabel === 'severe';
  }

  /**
   * Returns the BRI value at which alerts begin for the current mode.
   *   Standard → 0.75  (severe threshold)
   *   Strict   → 0.41  (moderate threshold)
   */
  public getAlertThreshold(): number {
    return this.mode === 'Strict' ? 0.41 : 0.75;
  }
}
