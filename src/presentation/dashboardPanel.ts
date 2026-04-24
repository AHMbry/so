/**
 * dashboardPanel.ts
 * Full dashboard WebView panel for the Bounded extension.
 *
 * Displays BRI trend line chart (canvas), session history table,
 * behavioral pattern cards, and an on-demand HTML report preview
 * rendered inside an iframe from a local blob URL.
 *
 * Architecture: Presentation layer only — never reads from data layer directly.
 * All data flows through ReportGenerator (business layer).
 * postMessage / onDidReceiveMessage is the only channel between
 * this WebView and the extension host (architectural hard rule).
 *
 * FR-10: No code content is ever stored, logged, or rendered here.
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
      'Bounded — Dashboard',
      column,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'media')
        ]
      }
    );

    DashboardPanel.currentPanel = new DashboardPanel(
      panel, context, reportGenerator
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private context: vscode.ExtensionContext,
    private reportGenerator: ReportGenerator
  ) {
    this._panel = panel;
    this._update(context, reportGenerator);
    this._panel.onDidDispose(
      () => this.dispose(),
      null,
      this._disposables
    );

    // Handle messages from dashboard WebView
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
    this._panel.webview.html = this._getHtmlContent(
      cssUri, nonce, report, reportGenerator
    );
  }

  private _getHtmlContent(
    cssUri: vscode.Uri,
    nonce: string,
    report: SessionReport,
    reportGenerator: ReportGenerator
  ): string {
    const historyJson = JSON.stringify(report.history);
    const patternCards = report.patterns.map(p =>
      `<div class="pattern-card ${p.severity}">${p.description}</div>`
    ).join('') || '<p>No significant patterns detected this session.</p>';

    const historyRows = report.history.map(s => `
      <tr>
        <td>${s.date}</td>
        <td>${s.finalBRI.toFixed(2)}</td>
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
    <h1>Bounded Dashboard</h1>
    <span class="session-badge">
      BRI: ${report.currentBRI.toFixed(2)} — ${report.stateLabel.toUpperCase()}
    </span>
  </div>

  <div class="chart-container">
    <h2>BRI Trend</h2>
    <canvas id="trend-chart" width="600" height="160"></canvas>
  </div>

  <div class="patterns-section">
    <h2>Detected Patterns</h2>
    ${patternCards}
  </div>

  <h2>Session History</h2>
  <table class="history-table">
    <thead>
      <tr>
        <th>Date</th><th>BRI</th>
        <th>Typed</th><th>Pasted</th><th>Mode</th>
      </tr>
    </thead>
    <tbody>${historyRows}</tbody>
  </table>

  <div class="actions-bar">
    <button class="btn-primary" id="generate-btn">Generate Report</button>
    <button class="btn-secondary" id="save-btn">Save as PDF</button>
  </div>

  <div id="report-preview" style="display:none; margin-top:24px;">
    <h2>Report Preview</h2>
    <iframe id="report-frame"
      style="width:100%;height:500px;border:none;background:#1e1e1e;">
    </iframe>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const history = ${historyJson};

    // Draw BRI trend line chart on canvas
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

      // Draw grid lines at 0.25, 0.50, 0.75
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.lineWidth = 1;
      [0.25, 0.50, 0.75].forEach(level => {
        const y = H - pad - (level * (H - pad * 2));
        ctx.beginPath();
        ctx.moveTo(pad, y);
        ctx.lineTo(W - pad, y);
        ctx.stroke();
      });

      // Draw trend line
      ctx.strokeStyle = '#569cd6';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      ctx.stroke();

      // Draw dots
      ctx.fillStyle = '#569cd6';
      points.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
      });
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '13px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('Not enough history to show trend.', W / 2, H / 2);
    }

    // Generate report button
    document.getElementById('generate-btn').addEventListener('click', () => {
      vscode.postMessage({ command: 'generateReport' });
    });

    // Save PDF button
    document.getElementById('save-btn').addEventListener('click', () => {
      vscode.postMessage({ command: 'saveReport' });
    });

    // Receive report HTML and show preview in iframe via blob URL
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
    const possible =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
