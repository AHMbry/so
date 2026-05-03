/**
 * reportGenerator.ts
 * Assembles a structured SessionReport from all live business-layer sources
 * and generates a self-contained HTML string for local export.
 *
 * Architecture: Business layer only — reads from data layer (sessionHistoryStore)
 * and queries the other business modules. Never calls presentation code.
 * FR-10: No code content is ever included in any output.
 */

import * as vscode from 'vscode';
import { BRIStateLabel, BoundedMode, SessionSnapshot, SessionRecord } from '../types';
import { SessionTracker } from './sessionTracker';
import { BRICalculator } from './briCalculator';
import { ModeManager } from './modeManager';
import { readSessionHistory } from '../data/sessionHistoryStore';

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface BehavioralPattern {
  id: string;
  description: string;
  severity: 'info' | 'warning' | 'critical';
}

export interface SessionReport {
  generatedAt: string;
  sessionId: string;
  currentBRI: number;
  stateLabel: BRIStateLabel;
  activeMode: BoundedMode;
  snapshot: SessionSnapshot;
  history: SessionRecord[];
  patterns: BehavioralPattern[];
}

// ── ReportGenerator ───────────────────────────────────────────────────────────

export class ReportGenerator {
  constructor(
    private sessionTracker: SessionTracker,
    private briCalculator: BRICalculator,
    private modeManager: ModeManager
  ) {}

  /** Assembles the full report from all live sources and persisted history. */
  public async generateReport(context: vscode.ExtensionContext): Promise<SessionReport> {
    const history = await readSessionHistory(context);
    const snapshot = this.sessionTracker.getSnapshot();
    const patterns = this.detectPatterns(snapshot, history);

    return {
      generatedAt: new Date().toISOString(),
      sessionId: this.sessionTracker.getSessionId(),
      currentBRI: this.briCalculator.getCurrentBRI(),
      stateLabel: this.briCalculator.getStateLabel(),
      activeMode: this.modeManager.getMode(),
      snapshot,
      history: history.slice(-10),
      patterns,
    };
  }

  /** Detects behavioral patterns from the current snapshot and session history. */
  private detectPatterns(
    snapshot: SessionSnapshot,
    history: SessionRecord[]
  ): BehavioralPattern[] {
    const patterns: BehavioralPattern[] = [];

    // Pattern 1: High inserted-code ratio this session (>60% of all lines were inserted)
    const totalLines = snapshot.linesTyped + snapshot.linesPasted;
    if (totalLines > 0 && snapshot.linesPasted / totalLines > 0.6) {
      const pct = Math.round((snapshot.linesPasted / totalLines) * 100);
      patterns.push({
        id: 'high-paste-ratio',
        description: `${pct}% of lines this session were inserted. Try writing the next block from scratch.`,
        severity: pct >= 80 ? 'critical' : 'warning',
      });
    }

    // Pattern 2: BRI trending upward across the last 3 sessions
    if (history.length >= 3) {
      const [a, b, c] = history.slice(-3);
      if (c.finalBRI > b.finalBRI && b.finalBRI > a.finalBRI) {
        patterns.push({
          id: 'bri-upward-trend',
          description:
            `Your BRI has increased across your last 3 sessions ` +
            `(${Math.round(a.finalBRI * 100)} → ${Math.round(b.finalBRI * 100)} → ${Math.round(c.finalBRI * 100)}). ` +
            `Aim to write more code independently.`,
          severity: c.finalBRI >= 0.75 ? 'critical' : 'warning',
        });
      }
    }

    // Pattern 3: No typing at all this session
    if (snapshot.linesTyped === 0 && snapshot.linesPasted > 0) {
      patterns.push({
        id: 'no-typing',
        description: 'No lines were typed this session — all input came from inserted code events.',
        severity: 'critical',
      });
    }

    // Fallback: healthy session
    if (patterns.length === 0) {
      patterns.push({
        id: 'healthy-session',
        description: 'No concerning patterns detected this session. Keep it up!',
        severity: 'info',
      });
    }

    return patterns;
  }

  /**
   * Generates a self-contained HTML string from a SessionReport.
   * Suitable for saving to disk as a portable report file.
   * FR-10: No code content is included — only counters, scores, timestamps.
   */
  public generateHTMLReport(report: SessionReport): string {
    const historyRows = report.history
      .map(
        (r) => `
        <tr>
          <td>${r.date}</td>
          <td>${Math.round(r.finalBRI * 100)}</td>
          <td>${r.linesTyped}</td>
          <td>${r.linesPasted}</td>
          <td>${r.modeActive}</td>
        </tr>`
      )
      .join('');

    const patternItems = report.patterns
      .map((p) => {
        const color =
          p.severity === 'critical' ? '#e74c3c' :
          p.severity === 'warning'  ? '#f39c12' : '#3498db';
        return `<div style="padding:10px;margin-bottom:8px;border-left:3px solid ${color};background:#f8f8f8;font-size:0.9rem;">${this._escapeHtml(p.description)}</div>`;
      })
      .join('');

    const totalLines = report.snapshot.linesTyped + report.snapshot.linesPasted;
    const pasteRatio = totalLines > 0
      ? `${Math.round((report.snapshot.linesPasted / totalLines) * 100)}%`
      : 'N/A';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Bounded Session Report</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 32px; max-width: 820px; margin: auto; color: #222; }
    h1   { font-size: 1.6rem; margin-bottom: 4px; }
    h2   { font-size: 1.1rem; margin-top: 28px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
    .meta { color: #666; font-size: 0.85rem; margin-bottom: 24px; }
    .badge { display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 0.8rem;
             background: #eee; margin-left: 8px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th { background: #f0f0f0; padding: 7px 10px; text-align: left; font-size: 0.85rem; }
    td { padding: 7px 10px; font-size: 0.85rem; border-bottom: 1px solid #eee; }
  </style>
</head>
<body>
  <h1>Bounded Session Report <span class="badge">${report.stateLabel.toUpperCase()}</span></h1>
  <p class="meta">
    Generated: ${report.generatedAt} &nbsp;|&nbsp;
    Session: ${report.sessionId} &nbsp;|&nbsp;
    Mode: ${report.activeMode}
  </p>

  <h2>Current BRI</h2>
  <p><strong>${Math.round(report.currentBRI * 100)}</strong> — ${report.stateLabel}</p>

  <h2>Session Snapshot</h2>
  <table>
    <tr><th>Metric</th><th>Value</th></tr>
    <tr><td>Lines Typed</td><td>${report.snapshot.linesTyped}</td></tr>
    <tr><td>Lines Inserted</td><td>${report.snapshot.linesPasted}</td></tr>
    <tr><td>Inserted Ratio</td><td>${pasteRatio}</td></tr>
    <tr><td>Insert Events</td><td>${report.snapshot.pasteEventCount}</td></tr>
    <tr><td>Longest Typing Streak</td><td>${report.snapshot.longestTypingStreak} lines</td></tr>
    <tr><td>BRI Change This Session</td><td>${report.snapshot.briDeltaSinceStart >= 0 ? '+' : ''}${Math.round(report.snapshot.briDeltaSinceStart * 100)}</td></tr>
  </table>

  <h2>Behavioral Patterns</h2>
  ${patternItems || '<p>No patterns detected.</p>'}

  <h2>Session History (last ${report.history.length})</h2>
  <table>
    <tr><th>Date</th><th>Final BRI</th><th>Typed</th><th>Inserted</th><th>Mode</th></tr>
    ${historyRows || '<tr><td colspan="5">No history yet.</td></tr>'}
  </table>
</body>
</html>`;
  }

  private _escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
