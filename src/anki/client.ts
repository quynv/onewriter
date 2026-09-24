import * as vscode from 'vscode';
import { log } from '../output';
import { t } from '../i18n';

export interface AnkiNote {
  deckName: string;
  modelName: string;
  fields: Record<string, string>;
  tags: string[];
  options?: {
    allowDuplicate?: boolean;
    duplicateScope?: 'deck' | 'collection';
  };
}

export class AnkiError extends Error {
  constructor(
    message: string,
    readonly offline = false,
  ) {
    super(message);
  }
}

/**
 * AnkiConnect chỉ nghe trên localhost và chặn request có Origin lạ, nên toàn bộ
 * lời gọi phải xuất phát từ Node của extension host. Gọi từ webview sẽ bị từ chối.
 */
export class AnkiClient {
  private get url(): string {
    return vscode.workspace
      .getConfiguration('onewriter')
      .get<string>('anki.url', 'http://127.0.0.1:8765');
  }

  async invoke<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, version: 6, params }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      log(`AnkiConnect unreachable: ${(err as Error).message}`);
      throw new AnkiError(t('anki.offline'), true);
    }

    if (!response.ok) {
      throw new AnkiError(t('anki.httpError', { status: response.status }));
    }

    const body = (await response.json()) as { result: T; error: string | null };
    if (body.error) {
      throw new AnkiError(t('anki.error', { message: body.error }));
    }
    return body.result;
  }

  async version(): Promise<number> {
    return this.invoke<number>('version');
  }

  async deckNames(): Promise<string[]> {
    return this.invoke<string[]>('deckNames');
  }

  async createDeck(deck: string): Promise<void> {
    await this.invoke('createDeck', { deck });
  }

  async modelNames(): Promise<string[]> {
    return this.invoke<string[]>('modelNames');
  }

  async canAddNotes(notes: AnkiNote[]): Promise<boolean[]> {
    if (notes.length === 0) {
      return [];
    }
    return this.invoke<boolean[]>('canAddNotes', { notes });
  }

  async addNotes(notes: AnkiNote[]): Promise<Array<number | null>> {
    if (notes.length === 0) {
      return [];
    }
    return this.invoke<Array<number | null>>('addNotes', { notes });
  }

  async createModel(
    modelName: string,
    inOrderFields: string[],
    css: string,
    cardTemplates: Array<{ Name: string; Front: string; Back: string }>,
  ): Promise<void> {
    await this.invoke('createModel', { modelName, inOrderFields, css, cardTemplates });
  }
}
