import type { TargetLanguage } from '../types';

export type ChunkSource = 'selection' | 'mistake' | 'upgrade';

export interface QueuedChunk {
  id: string;
  uri: string;
  chunk: string;
  normalizedChunk: string;
  context: string;
  targetLanguage: TargetLanguage;
  nativeLanguage: string;
  level: string;
  style: string;
  source: ChunkSource;
  addedAt: number;
}

export type QueuedChunkInput = Omit<QueuedChunk, 'id' | 'normalizedChunk' | 'addedAt'>;

export interface EnrichedChunk {
  id: string;
  meaning: string;
  example: string;
  note?: string;
}
