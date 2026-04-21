import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  console.log('Bounded extension activated');

  // TODO: Phase 2 — initialize BRI state store and session tracker

  const openDashboard = vscode.commands.registerCommand('bounded.openDashboard', () => {
    // TODO: Phase 2 — open WebView dashboard panel
    vscode.window.showInformationMessage('Bounded: Dashboard coming soon.');
  });

  const toggleMode = vscode.commands.registerCommand('bounded.toggleMode', () => {
    // TODO: Phase 2 — switch between Standard and Strict modes via ModeManager
    vscode.window.showInformationMessage('Bounded: Mode toggle coming soon.');
  });

  const generateReport = vscode.commands.registerCommand('bounded.generateReport', () => {
    // TODO: Phase 3 — invoke ReportGenerator to produce session PDF/JSON summary
    vscode.window.showInformationMessage('Bounded: Report generation coming soon.');
  });

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBar.text = '$(pulse) BRI: --';
  statusBar.tooltip = 'Bounded — Behavioral Reliance Index';
  statusBar.command = 'bounded.openDashboard';
  statusBar.show();

  // TODO: Phase 2 — update statusBar.text dynamically as BRI is calculated

  context.subscriptions.push(openDashboard, toggleMode, generateReport, statusBar);
}

export function deactivate(): void {
  console.log('Bounded extension deactivated');
}
