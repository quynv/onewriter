import * as vscode from 'vscode';
import { ResolvedConfig, ReviewMode, TargetLanguage } from './types';
import { LEVELS_BY_LANGUAGE } from './levels';
import { parseFrontMatter } from './front-matter';

export { parseFrontMatter, stripFrontMatter } from './front-matter';

interface TargetSetting {
  language: TargetLanguage;
  level: string;
  style?: string;
}

export function getTargets(): TargetSetting[] {
  const raw = vscode.workspace
    .getConfiguration('onewriter')
    .get<TargetSetting[]>('targets', []);
  const valid = raw.filter((t) => t && (t.language === 'en' || t.language === 'ja'));
  return valid.length > 0 ? valid : [{ language: 'en', level: 'B1', style: 'polite' }];
}

/**
 * Gộp settings global với front matter của file. Front matter thắng, vì một
 * workspace có thể chứa cả bài tiếng Anh lẫn tiếng Nhật.
 */
export function resolveConfig(document?: vscode.TextDocument): ResolvedConfig {
  const cfg = vscode.workspace.getConfiguration('onewriter');
  const front = document ? parseFrontMatter(document.getText()) : {};

  const targets = getTargets();
  const activeLanguage = cfg.get<string>('activeTarget', 'en');
  const activeTarget =
    targets.find((target) => target.language === activeLanguage) ?? targets[0];
  const requestedLanguage = front.lang || front.language;
  const language: TargetLanguage =
    requestedLanguage === 'en' || requestedLanguage === 'ja'
      ? requestedLanguage
      : activeTarget.language;
  const matchingTarget = targets.find((target) => target.language === language);
  const allowed = LEVELS_BY_LANGUAGE[language];
  const frontLevel = front.level?.toUpperCase();
  const level = allowed.includes(frontLevel ?? '')
    ? (frontLevel as string)
    : allowed.includes(matchingTarget?.level ?? '')
      ? matchingTarget!.level
      : allowed[1];
  const style =
    front.style === 'plain' || front.style === 'polite' || front.style === 'formal'
      ? front.style
      : matchingTarget?.style || activeTarget.style || 'polite';

  return {
    nativeLanguage: cfg.get<string>('nativeLanguage', 'vi'),
    targetLanguage: language,
    level,
    style,
    explanationLanguage: cfg.get<'native' | 'target'>('review.explanationLanguage', 'native'),
    showBetter: cfg.get<boolean>('review.showBetter', true),
    maxChunks: cfg.get<number>('llm.maxChunks', 8),
    reviewMode: cfg.get<ReviewMode>('review.mode', 'codelens'),
    topic: front.topic,
  };
}

export function deckName(config: Pick<ResolvedConfig, 'targetLanguage' | 'level'>): string {
  const pattern = vscode.workspace
    .getConfiguration('onewriter')
    .get<string>('anki.deckPattern', 'OneWriter::{language}');
  return pattern
    .replace(/\{language\}/g, config.targetLanguage)
    .replace(/\{level\}/g, config.level);
}

/** File này có phải bài luyện viết không. Quyết định việc hiện nút chấm bài. */
export function isPracticeFile(document: vscode.TextDocument): boolean {
  if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
    return false;
  }
  const glob = vscode.workspace
    .getConfiguration('onewriter')
    .get<string>('practiceGlob', '**/*.md');
  return vscode.languages.match({ pattern: glob }, document) > 0;
}
