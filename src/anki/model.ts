import { AnkiClient } from './client';
import { log } from '../output';
import { t } from '../i18n';

export const FIELDS = ['Chunk', 'Meaning', 'Context', 'Corrected', 'Note', 'Source'] as const;

/**
 * Chunk là field đầu tiên vì AnkiConnect dedup theo first field, dù mặt trước
 * card hiển thị Meaning. Hướng nghĩa → cụm là hướng luyện tạo câu, không phải
 * luyện nhận mặt chữ.
 */
const FRONT = `{{Meaning}}
<div class="ctx">{{Context}}</div>`;

const BACK = `{{FrontSide}}
<hr id="answer">
<div class="chunk">{{Chunk}}</div>
{{#Corrected}}<div class="corrected">{{Corrected}}</div>{{/Corrected}}
{{#Note}}<div class="note">{{Note}}</div>{{/Note}}
{{#Source}}<div class="src">{{Source}}</div>{{/Source}}`;

const CSS = `.card {
  font-family: -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
  font-size: 20px;
  text-align: left;
  color: #1f1f1f;
  background: #fbfbfa;
  padding: 24px;
  line-height: 1.6;
}
.nightMode.card { color: #e8e8e8; background: #22262b; }
.ctx { margin-top: 14px; font-size: 16px; color: #6b6b6b; }
.nightMode .ctx { color: #9aa0a6; }
.chunk { font-size: 26px; font-weight: 600; margin: 4px 0 10px; }
.corrected { font-size: 17px; color: #2e7d32; }
.nightMode .corrected { color: #81c995; }
.note { margin-top: 10px; font-size: 15px; color: #6b6b6b; }
.nightMode .note { color: #9aa0a6; }
.src { margin-top: 16px; font-size: 12px; color: #9a9a9a; }
hr#answer { border: none; border-top: 1px solid #dcdcdc; margin: 16px 0; }
.nightMode hr#answer { border-top-color: #3c4043; }`;

/**
 * Chỉ tạo model khi chưa có. Không gọi updateModelTemplates ở mỗi lần chạy, vì
 * làm vậy sẽ ghi đè CSS mà người dùng tự chỉnh trong Anki.
 */
export async function ensureModel(client: AnkiClient, modelName: string): Promise<void> {
  const models = await client.modelNames();
  if (models.includes(modelName)) {
    return;
  }
  log(`Creating note type "${modelName}".`);
  await client.createModel(modelName, [...FIELDS], CSS, [
    { Name: t('anki.templateName'), Front: FRONT, Back: BACK },
  ]);
}

export async function ensureDeck(client: AnkiClient, deck: string): Promise<void> {
  const decks = await client.deckNames();
  if (!decks.includes(deck)) {
    log(`Creating deck "${deck}".`);
    await client.createDeck(deck);
  }
}
