import * as vscode from 'vscode';
import { normalizeChunk } from './selection';
import type { QueuedChunk, QueuedChunkInput } from './types';

const STORAGE_KEY = 'onewriter.chunkQueue.v1';

interface QueueEnvelope {
  version: 1;
  items: QueuedChunk[];
}

export class UnsupportedChunkQueueVersionError extends Error {
  constructor(version: number) {
    super(`Chunk queue version ${version} is not supported.`);
    this.name = 'UnsupportedChunkQueueVersionError';
  }
}

function isQueuedChunk(value: unknown): value is QueuedChunk {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string'
    && typeof item.uri === 'string'
    && typeof item.chunk === 'string'
    && typeof item.normalizedChunk === 'string'
    && typeof item.context === 'string'
    && (item.targetLanguage === 'en' || item.targetLanguage === 'ja')
    && typeof item.nativeLanguage === 'string'
    && typeof item.level === 'string'
    && typeof item.style === 'string'
    && (item.source === 'selection' || item.source === 'mistake' || item.source === 'upgrade')
    && typeof item.addedAt === 'number'
    && Number.isFinite(item.addedAt);
}

function uriString(uri: vscode.Uri | string): string {
  return typeof uri === 'string' ? uri : uri.toString();
}

export class ChunkQueueStore implements vscode.Disposable {
  private items: QueuedChunk[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  private pendingMutation: Promise<void> = Promise.resolve();
  private unsupportedVersion: number | undefined;

  readonly onDidChange = this.emitter.event;

  constructor(private readonly state: vscode.Memento) {
    const stored = state.get<unknown>(STORAGE_KEY);
    if (typeof stored !== 'object' || stored === null) return;

    const envelope = stored as { version?: unknown; items?: unknown };
    if (typeof envelope.version === 'number' && envelope.version !== 1) {
      this.unsupportedVersion = envelope.version;
      return;
    }
    if (envelope.version === 1 && Array.isArray(envelope.items)) {
      const valid = envelope.items.filter(isQueuedChunk);
      // Reserve every existing ID before generating replacements so a later
      // first occurrence also retains its identity. Persist on the next write.
      const reserved = new Set(valid.map((item) => item.id));
      const seen = new Set<string>();
      this.items = valid.map((item) => {
        let id = item.id;
        if (!id.trim() || seen.has(id)) {
          do { id = crypto.randomUUID(); } while (reserved.has(id));
          reserved.add(id);
        }
        seen.add(id);
        return { ...item, id };
      });
    }
  }

  list(uri?: vscode.Uri | string): readonly QueuedChunk[] {
    if (uri === undefined) return [...this.items];
    const value = uriString(uri);
    return this.items.filter((item) => item.uri === value);
  }

  async add(
    input: QueuedChunkInput,
  ): Promise<{ status: 'added'; item: QueuedChunk } | { status: 'duplicate'; item: QueuedChunk }> {
    return this.enqueue(async () => {
      this.assertWritable();
      const normalizedChunk = normalizeChunk(input.chunk);
      const duplicate = this.items.find(
        (item) => item.uri === input.uri && item.normalizedChunk === normalizedChunk,
      );
      if (duplicate) return { status: 'duplicate', item: duplicate };

      const item: QueuedChunk = {
        ...input,
        id: crypto.randomUUID(),
        normalizedChunk,
        addedAt: Date.now(),
      };
      await this.commit([...this.items, item]);
      return { status: 'added', item };
    });
  }

  async addMany(inputs: readonly QueuedChunkInput[]): Promise<{ added: QueuedChunk[]; duplicates: QueuedChunk[] }> {
    return this.enqueue(async () => {
      this.assertWritable();
      const next = [...this.items];
      const added: QueuedChunk[] = [];
      const duplicates: QueuedChunk[] = [];

      for (const input of inputs) {
        const normalizedChunk = normalizeChunk(input.chunk);
        const duplicate = next.find(
          (item) => item.uri === input.uri && item.normalizedChunk === normalizedChunk,
        );
        if (duplicate) {
          duplicates.push(duplicate);
          continue;
        }
        const item: QueuedChunk = {
          ...input,
          id: crypto.randomUUID(),
          normalizedChunk,
          addedAt: Date.now(),
        };
        next.push(item);
        added.push(item);
      }

      if (added.length > 0) await this.commit(next);
      return { added, duplicates };
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      this.assertWritable();
      const next = this.items.filter((item) => item.id !== id);
      if (next.length === this.items.length) return false;
      await this.commit(next);
      return true;
    });
  }

  async removeMany(ids: ReadonlySet<string>): Promise<number> {
    return this.enqueue(async () => {
      this.assertWritable();
      const next = this.items.filter((item) => !ids.has(item.id));
      const removed = this.items.length - next.length;
      if (removed > 0) await this.commit(next);
      return removed;
    });
  }

  async clear(uri: vscode.Uri | string): Promise<number> {
    return this.enqueue(async () => {
      this.assertWritable();
      const value = uriString(uri);
      const next = this.items.filter((item) => item.uri !== value);
      const removed = this.items.length - next.length;
      if (removed > 0) await this.commit(next);
      return removed;
    });
  }

  async cleanDeleted(): Promise<number> {
    return this.enqueue(async () => {
      this.assertWritable();
      const missingUris = new Set<string>();
      for (const uri of new Set(this.items.map((item) => item.uri))) {
        try {
          await vscode.workspace.fs.stat(vscode.Uri.parse(uri));
        } catch (error: unknown) {
          if (this.isFileNotFound(error)) missingUris.add(uri);
        }
      }
      if (missingUris.size === 0) return 0;

      const next = this.items.filter((item) => !missingUris.has(item.uri));
      const removed = this.items.length - next.length;
      if (removed > 0) await this.commit(next);
      return removed;
    });
  }

  dispose(): void {
    this.emitter.dispose();
    this.items = [];
  }

  private assertWritable(): void {
    if (this.unsupportedVersion !== undefined) {
      throw new UnsupportedChunkQueueVersionError(this.unsupportedVersion);
    }
  }

  private async commit(next: QueuedChunk[]): Promise<void> {
    const envelope: QueueEnvelope = { version: 1, items: next };
    await this.state.update(STORAGE_KEY, envelope);
    this.items = next;
    this.emitter.fire();
  }

  private enqueue<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.pendingMutation.then(mutation);
    this.pendingMutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private isFileNotFound(error: unknown): boolean {
    return typeof error === 'object'
      && error !== null
      && (error as { code?: unknown }).code === 'FileNotFound';
  }
}
