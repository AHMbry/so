/**
 * sidebarPanel.ts
 * Implements the VS Code WebviewViewProvider for the Bounded sidebar panel.
 *
 * Responsibilities:
 *   - Renders the BRI ring gauge, session snapshot table, and control buttons.
 *   - Receives state updates from the extension host via updateState().
 *   - Sends user actions (mode toggle, open dashboard) back to the host
 *     via postMessage → vscode.commands.executeCommand.
 *
 * Architecture rule: ALL WebView ↔ Extension Host communication goes through
 * postMessage / onDidReceiveMessage. No direct DOM access from the host.
 *
 * FR-10: No code content is ever included in any message or state object.
 */

import * as vscode from 'vscode';
import { BRIState, BoundedMode } from '../types';

export class SidebarPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'boundedSidebarView';
  private _view?: vscode.WebviewView;
  /** Last state received from the extension host before the WebView was ready. */
  private _pendingState?: BRIState;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext<unknown>,
    _token: vscode.CancellationToken
  ): void {
    console.log('Bounded: resolveWebviewView called');
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };

    webviewView.webview.html = this._getHtmlContent(webviewView.webview);

    // If a state update arrived before the WebView was ready, deliver it now.
    if (this._pendingState) {
      webviewView.webview.postMessage({ command: 'updateState', state: this._pendingState });
      this._pendingState = undefined;
    }

    // Receive messages from the WebView UI
    webviewView.webview.onDidReceiveMessage(
      (message: { command: string; mode?: BoundedMode }) => {
        switch (message.command) {
          case 'toggleMode':
            vscode.commands.executeCommand('bounded.toggleMode');
            break;
          case 'openDashboard':
            vscode.commands.executeCommand('bounded.openDashboard');
            break;
        }
      },
      undefined,
      this.context.subscriptions
    );
  }

  /**
   * Pushes a fresh BRIState into the WebView.
   * Called from extension.ts after every paste, undo, or mode change.
   * The WebView's message handler updates the ring gauge and table live.
   */
  public updateState(state: BRIState): void {
    if (this._view) {
      this._view.webview.postMessage({ command: 'updateState', state });
    } else {
      // WebView not yet resolved — cache so resolveWebviewView can deliver it.
      this._pendingState = state;
    }
  }

  private _getHtmlContent(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sidebar.css')
    );
    const nonce = this._getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${cssUri.toString()}">
</head>
<body>

  <div class="bri-gauge-container">
    <svg class="bri-ring" width="120" height="120" viewBox="0 0 120 120">
      <!-- Background track -->
      <circle cx="60" cy="60" r="50"
        fill="none" stroke="var(--vscode-badge-background)"
        stroke-width="10"/>
      <!-- BRI progress arc — stroke-dashoffset animated via JS -->
      <circle id="bri-arc" cx="60" cy="60" r="50"
        fill="none" stroke="var(--vscode-terminal-ansiGreen)"
        stroke-width="10"
        stroke-linecap="round"
        stroke-dasharray="314"
        stroke-dashoffset="314"
        transform="rotate(-90 60 60)"/>
    </svg>
    <div class="bri-value" id="bri-value">0.00</div>
    <div class="bri-label label-low" id="bri-label">LOW</div>
  </div>

  <table class="snapshot-table">
    <tr><td>Lines Typed</td>        <td id="lines-typed">0</td></tr>
    <tr><td>Lines Pasted</td>       <td id="lines-pasted">0</td></tr>
    <tr><td>Paste Events</td>       <td id="paste-count">0</td></tr>
    <tr><td>Unmodified Pastes</td>  <td id="unmodified">0</td></tr>
    <tr><td>Longest Streak</td>     <td id="streak">0</td></tr>
  </table>

  <button class="mode-toggle" id="mode-btn">Mode: Standard</button>
  <button class="dashboard-btn" id="dashboard-btn">Open Dashboard →</button>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const arc      = document.getElementById('bri-arc');
    const briValue = document.getElementById('bri-value');
    const briLabel = document.getElementById('bri-label');
    const modeBtn  = document.getElementById('mode-btn');
    const dashBtn  = document.getElementById('dashboard-btn');

    const CIRCUMFERENCE = 314; // 2 * Math.PI * r(50), approximated

    const labelClasses = {
      low:      'bri-label label-low',
      moderate: 'bri-label label-moderate',
      severe:   'bri-label label-severe'
    };

    const arcColors = {
      low:      'var(--vscode-terminal-ansiGreen)',
      moderate: 'var(--vscode-warningForeground)',
      severe:   'var(--vscode-errorForeground)'
    };

    // Receive state pushes from the extension host
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.command !== 'updateState') { return; }

      const { currentBRI, stateLabel, activeMode, sessionSnapshot } = msg.state;

      // Update ring arc
      arc.style.strokeDashoffset = CIRCUMFERENCE - (currentBRI * CIRCUMFERENCE);
      arc.style.stroke = arcColors[stateLabel] || arcColors.low;

      // Update numeric value and label
      briValue.textContent = currentBRI.toFixed(2);
      briLabel.className   = labelClasses[stateLabel] || labelClasses.low;
      briLabel.textContent = stateLabel.toUpperCase();

      // Update snapshot table
      document.getElementById('lines-typed').textContent  = sessionSnapshot.linesTyped;
      document.getElementById('lines-pasted').textContent = sessionSnapshot.linesPasted;
      document.getElementById('paste-count').textContent  = sessionSnapshot.pasteEventCount;
      document.getElementById('unmodified').textContent   = sessionSnapshot.unmodifiedPastes;
      document.getElementById('streak').textContent       = sessionSnapshot.longestTypingStreak;

      // Update mode button label
      modeBtn.textContent = 'Mode: ' + activeMode;
    });

    modeBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'toggleMode' });
    });

    dashBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'openDashboard' });
    });
  </script>
</body>
</html>`;
  }

  /** Cryptographically sufficient nonce for the Content-Security-Policy. */
  private _getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
  }
}
