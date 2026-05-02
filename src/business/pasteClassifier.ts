/**
 * pasteClassifier.ts
 * Determines whether a VS Code TextDocumentChangeEvent qualifies as a paste,
 * and if so, whether that paste originated from within the same workspace
 * (internal) or from an external source (external).
 *
 * FR-04: Internal pastes must never affect BRI.
 * FR-10: No code content is ever logged, stored, or transmitted.
 *        Only metadata (lineCount, isInternal, IDs, timestamps) is extracted.
 */

import * as vscode from 'vscode';
import { BehavioralEvent } from '../types';

/** Minimum number of inserted lines for a change to be treated as a paste. */
const MIN_PASTE_LINES = 3;

/**
 * Checks whether pastedText exists verbatim in any open workspace document
 * other than the document that was just changed.
 * The changed document is excluded because the text was already written into
 * it by the time this event fires.
 *
 * FR-10: pastedText is read here for comparison only — it is never stored.
 */
function isInternalPaste(
  pastedText: string,
  excludeDoc: vscode.TextDocument
): boolean {
  for (const doc of vscode.workspace.textDocuments) {
    if (doc === excludeDoc) {
      continue; // skip the document that was just edited
    }
    if (doc.getText().includes(pastedText)) {
      return true;
    }
  }
  return false;
}

/**
 * Classifies a TextDocumentChangeEvent as a BehavioralEvent or returns null.
 *
 * A change qualifies as a paste when:
 *   - It contains exactly one content-change entry
 *   - The inserted text spans MIN_PASTE_LINES or more lines
 *   - The inserted text is not whitespace-only
 *
 * FR-10: The inserted text itself is used only for the internal-paste check
 *        and is never attached to the returned BehavioralEvent.
 */
export function classifyPasteEvent(
  change: vscode.TextDocumentChangeEvent,
  sessionId: string
): BehavioralEvent | null {
  if (change.contentChanges.length !== 1) {
    return null;
  }

  const contentChange = change.contentChanges[0];
  const insertedText = contentChange.text;

  if (insertedText.trim() === '') {
    return null;
  }

  // Count only non-empty lines — blank lines must not inflate BRI or the threshold.
  const lineCount = insertedText
    .split('\n')
    .filter((l) => l.trim() !== '').length;

  if (lineCount < MIN_PASTE_LINES) {
    return null;
  }

  const internal = isInternalPaste(insertedText, change.document);

  // Only metadata leaves this function — FR-10
  return {
    eventId: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    sessionId,
    occurredAt: new Date().toISOString(),
    eventType: 'PASTE',
    lineCount,
    isInternal: internal,
    isUndone: false,
    modificationDepth: 0.0, // TODO: Phase 4 — BRI Calculator will update this after modification analysis
  };
}
