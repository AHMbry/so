/**
 * dashboardPanel.ts
 * Full dashboard WebView panel for the Bounded extension.
 */

import * as vscode from 'vscode';
import { SessionReport, ReportGenerator } from '../business/reportGenerator';
import { exportReportAsHTML } from '../data/reportExporter';

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private static readonly viewType = 'boundedDashboard';
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  public static async createOrShow(
    context: vscode.ExtensionContext,
    reportGenerator: ReportGenerator
  ): Promise<void> {
    const column = vscode.ViewColumn.Two;

    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel._panel.reveal(column);
      await DashboardPanel.currentPanel._update(context, reportGenerator);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      DashboardPanel.viewType,
      'Bounded - Dashboard',
      column,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'media')
        ]
      }
    );

    DashboardPanel.currentPanel = new DashboardPanel(panel, context, reportGenerator);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private context: vscode.ExtensionContext,
    private reportGenerator: ReportGenerator
  ) {
    this._panel = panel;
    this._update(context, reportGenerator);
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message: { command: string }) => {
        switch (message.command) {
          case 'generateReport': {
            const report = await reportGenerator.generateReport(context);
            this._panel.webview.postMessage({
              command: 'reportReady',
              html: reportGenerator.generateHTMLReport(report)
            });
            break;
          }
          case 'saveReport': {
            const saveReport = await reportGenerator.generateReport(context);
            const html = reportGenerator.generateHTMLReport(saveReport);
            await exportReportAsHTML(saveReport, html);
            break;
          }
        }
      },
      null,
      this._disposables
    );
  }

  private async _update(
    context: vscode.ExtensionContext,
    reportGenerator: ReportGenerator
  ): Promise<void> {
    const report = await reportGenerator.generateReport(context);
    const cssUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'media', 'dashboard.css')
    );
    const nonce = this._getNonce();
    this._panel.webview.html = this._getHtmlContent(cssUri, nonce, report);
  }

  private _getHtmlContent(
    cssUri: vscode.Uri,
    nonce: string,
    report: SessionReport
  ): string {
    const historyJson = JSON.stringify(report.history);
    const patternCards = report.patterns.map(p =>
      `<div class="pattern-card ${p.severity}">${p.description}</div>`
    ).join('') || '<p class="empty-state">No significant patterns detected this session.</p>';
    const briScore = Math.round(report.currentBRI * 100);

    const historyRows = report.history.map(s => `
      <tr>
        <td>${s.date}</td>
        <td>${Math.round(s.finalBRI * 100)}</td>
        <td>${s.linesTyped}</td>
        <td>${s.linesPasted}</td>
        <td>${s.modeActive}</td>
      </tr>
    `).join('') || '<tr><td colspan="5">No history yet.</td></tr>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${this._panel.webview.cspSource};
             script-src 'nonce-${nonce}';
             frame-src blob:;">
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <div class="dashboard-header">
    <div>
      <h1>Bounded</h1>
      <p>Session awareness for independent coding</p>
    </div>
    <div class="dashboard-tools">
      <button class="theme-toggle" id="theme-btn">Light</button>
      <div class="bri-badge ${report.stateLabel}">
        <span>BRI</span>
        <strong>${briScore}</strong>
        <em>${report.stateLabel.toUpperCase()}</em>
      </div>
    </div>
  </div>

  <section class="metric-strip">
    <div class="metric"><span>Lines Typed</span><strong>${report.snapshot.linesTyped}</strong></div>
    <div class="metric"><span>Lines Inserted</span><strong>${report.snapshot.linesPasted}</strong></div>
    <div class="metric"><span>Insert Events</span><strong>${report.snapshot.pasteEventCount}</strong></div>
    <div class="metric"><span>Writing Streak</span><strong>${report.snapshot.longestTypingStreak}</strong></div>
  </section>

  <section class="chart-container">
    <h2>BRI Trend</h2>
    <canvas id="trend-chart" width="600" height="160"></canvas>
  </section>

  <section class="patterns-section">
    <h2>Detected Patterns</h2>
    ${patternCards}
  </section>

  <section class="history-section">
    <h2>Session History</h2>
    <table class="history-table">
      <thead>
        <tr>
          <th>Date</th><th>BRI</th><th>Typed</th><th>Inserted</th><th>Mode</th>
        </tr>
      </thead>
      <tbody>${historyRows}</tbody>
    </table>
  </section>

  <div class="actions-bar">
    <button class="btn-primary" id="generate-btn">Generate Report</button>
    <button class="btn-secondary" id="save-btn">Save Report</button>
  </div>

  <div id="report-preview" class="report-preview">
    <h2>Report Preview</h2>
    <iframe id="report-frame"></iframe>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const history = ${historyJson};
    const savedState = vscode.getState() || {};

    function applyTheme(theme) {
      document.body.dataset.theme = theme;
      document.getElementById('theme-btn').textContent = theme === 'light' ? 'Dark' : 'Light';
      vscode.setState({ ...savedState, theme });
    }

    applyTheme(savedState.theme || 'dark');

    const canvas = document.getElementById('trend-chart');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const pad = 20;

    if (history.length > 1) {
      const points = history.map((s, i) => ({
        x: pad + (i / (history.length - 1)) * (W - pad * 2),
        y: H - pad - (s.finalBRI * (H - pad * 2))
      }));

      ctx.strokeStyle = 'rgba(128,128,128,0.25)';
      ctx.lineWidth = 1;
      [0.25, 0.50, 0.75].forEach(level => {
        const y = H - pad - (level * (H - pad * 2));
        ctx.beginPath();
        ctx.moveTo(pad, y);
        ctx.lineTo(W - pad, y);
        ctx.stroke();
      });

      ctx.strokeStyle = getComputedStyle(document.documentElement)
        .getPropertyValue('--vscode-charts-blue') || '#569cd6';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      ctx.stroke();

      ctx.fillStyle = ctx.strokeStyle;
      points.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
      });
    } else {
      ctx.fillStyle = 'rgba(128,128,128,0.8)';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Not enough history to show trend.', W / 2, H / 2);
    }

    document.getElementById('generate-btn').addEventListener('click', () => {
      vscode.postMessage({ command: 'generateReport' });
    });

    document.getElementById('save-btn').addEventListener('click', () => {
      vscode.postMessage({ command: 'saveReport' });
    });

    document.getElementById('theme-btn').addEventListener('click', () => {
      applyTheme(document.body.dataset.theme === 'light' ? 'dark' : 'light');
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.command === 'reportReady') {
        const preview = document.getElementById('report-preview');
        const frame = document.getElementById('report-frame');
        const blob = new Blob([msg.html], { type: 'text/html' });
        frame.src = URL.createObjectURL(blob);
        preview.style.display = 'block';
      }
    });
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    DashboardPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
  }

  private _getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
