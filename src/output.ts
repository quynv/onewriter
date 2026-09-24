import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function initOutput(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel('OneWriter', { log: true });
  return channel;
}

export function log(message: string): void {
  initOutput().info(message);
}

export function logError(message: string, err?: unknown): void {
  const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err ?? '');
  initOutput().error(`${message} ${detail}`.trim());
}

export function showOutput(): void {
  initOutput().show(true);
}
