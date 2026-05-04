/**
 * sessionHistoryStore.ts
 * Data-layer module responsible for reading and appending completed session
 * records to session-history.json inside VS Code's globalStorage directory.
 *
 * Guarantees:
 *   - Never stores or transmits code content (FR-10).
 *   - Returns [] on first launch or file corruption.
 *   - Enforces a rolling window of the 90 most recent sessions.
 *   - All I/O is async.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { SessionRecord } from '../types';

const FILE_NAME = 'session-history.json';
const MAX_HISTORY = 90;

// ── Path helper ───────────────────────────────────────────────────────────────

/**
 * Returns the absolute path to session-history.json inside VS Code's
 * per-extension globalStorage folder.
 */
function getSessionHistoryPath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, FILE_NAME);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Reads all session records from disk.
 * Returns [] if the file is missing or cannot be parsed.
 */
export async function readSessionHistory(
  context: vscode.ExtensionContext
): Promise<SessionRecord[]> {
  const filePath = getSessionHistoryPath(context);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as SessionRecord[];
  } catch (err: unknown) {
    const isNotFound =
      typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isNotFound) {
      console.warn('Bounded: session-history.json is corrupt — treating history as empty.', err);
    }
    return [];
  }
}

/**
 * Appends a completed SessionRecord to disk.
 * Enforces a rolling window: only the last MAX_HISTORY records are kept.
 * Creates the globalStorage directory if it does not exist (first launch).
 */
export async function appendSessionRecord(
  context: vscode.ExtensionContext,
  record: SessionRecord
): Promise<void> {
  const dir = context.globalStorageUri.fsPath;
  await fs.mkdir(dir, { recursive: true });

  const history = await readSessionHistory(context);
  history.push(record);

  // Enforce rolling window
  const trimmed = history.slice(-MAX_HISTORY);

  await fs.writeFile(
    getSessionHistoryPath(context),
    JSON.stringify(trimmed, null, 2),
    'utf-8'
  );
}
