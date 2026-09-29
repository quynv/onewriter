# OneWriter

OneWriter is a VS Code extension for practicing foreign-language writing. Write a passage, ask an LLM to review it, and turn useful phrases into Anki cards without leaving the editor.

It currently supports English (A2–C1) and Japanese (N4–N1). The runtime interface is available in English, Vietnamese, and Japanese.

## Development

```bash
npm install
npm run build
```

Open this directory in VS Code and press `F5`. VS Code will start an Extension Development Host with OneWriter installed.

To create an installable package:

```bash
npx vsce package     # creates onewriter-0.1.0.vsix
```

## Setup

### LLM providers

OneWriter calls provider REST APIs directly. A fresh installation uses **Gemini** with `gemini-3.8-flash` by default.

Open the Command Palette and run **OneWriter: Enter API key** (`onewriter.setApiKey`), then choose one of the five supported providers: **Gemini**, **OpenAI**, **Qwen**, **DeepSeek**, or **Claude**. Keys entered through this command are stored in VS Code **SecretStorage**, never in `settings.json`.

If a matching environment variable is already set, OneWriter uses it when SecretStorage has no key for that provider. A key in SecretStorage always takes precedence.

| Provider | Model setting and default | Environment fallback |
|---|---|---|
| Gemini | `onewriter.llm.gemini.model` (`gemini-3.8-flash`) | `GEMINI_API_KEY` |
| OpenAI | `onewriter.llm.openai.model` (`gpt-5.6-luna`) | `OPENAI_API_KEY` |
| Qwen | `onewriter.llm.qwen.model` (`qwen3.8-max`) | `DASHSCOPE_API_KEY` |
| DeepSeek | `onewriter.llm.deepseek.model` (`deepseek-v4-flash`) | `DEEPSEEK_API_KEY` |
| Claude | `onewriter.llm.claude.model` (`claude-sonnet-4-6`) | `ANTHROPIC_API_KEY` |

Qwen uses the Singapore international endpoint by default:

```text
https://dashscope-intl.aliyuncs.com/compatible-mode/v1
```

For the Japan endpoint or a dedicated workspace endpoint, set `onewriter.llm.qwen.baseUrl` to the base URL supplied by Qwen.

To remove a stored key, run **OneWriter: Delete saved API key** (`onewriter.deleteApiKey`) and select the provider. This removes only the SecretStorage value; an existing environment fallback remains available.

`onewriter.llm.timeoutMs` defaults to `300000` (five minutes) for long passages. Select **Cancel** in the progress notification to abort an active request. User cancellation is kept distinct from a timeout error.

When an older installation starts, OneWriter migrates the former Anthropic API provider to Claude and the former command-based provider to Gemini. Existing key and model values are copied and verified before the migration is marked complete, so an interrupted migration can be retried safely.

### Anki

Keep Anki Desktop running with the [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on (code `2055492159`). Select **Check Anki** in the OneWriter sidebar to verify the connection. The `OneWriter Chunk` note type and target deck are created automatically on the first save.

## Daily workflow

1. Select the OneWriter icon in the Activity Bar, then choose **New practice text**. The draft includes front matter for the language, level, style, topic, and date. Save the practice file before adding chunks.
2. Write your passage. Select a word or phrase of up to 200 characters, open the editor context menu, and choose **OneWriter: Add Selection to Chunks**.
3. Use the OneWriter sidebar to review each chunk together with its containing sentence. The queue is stored separately for each workspace and source file, so it survives extension and VS Code reloads.
4. Remove individual chunks, choose **Clear this file's chunks** to clear the active file, or choose **Remove deleted files' chunks** to clean entries whose source files no longer exist. OneWriter also performs this cleanup at startup.
5. With Anki Desktop and AnkiConnect running, select **Save chunks to Anki**, choose the queued entries, and press Enter. OneWriter sends one batched LLM request for each group that shares the same target language, native language, level, and writing style.
6. A chunk leaves the queue only after AnkiConnect confirms its card. Cancelled and failed items stay queued for another attempt.

Writing review is an independent workflow. Select the sparkle button or press `Ctrl+Alt+R` (`Cmd+Alt+R` on macOS) to review the passage. You can add and save manually selected chunks without reviewing the document first.

### Source-based writing

After entering a `topic` in front matter, select **OneWriter: Generate source passage** from the editor title toolbar. OneWriter uses the current REST provider to create a passage in `onewriter.nativeLanguage`, then keeps it in the same file:

```markdown
## Source

Tôi thức dậy lúc bảy giờ và chuẩn bị đi làm.

## Writing

私は七時に起きて、仕事へ行く準備をします。
```

Write only in the `Writing` section. During review, OneWriter sends `Source` as reference material and asks the model to identify missing, distorted, or invented meaning in addition to language mistakes. Corrections and issue locations apply only to `Writing`. Generating the source again asks for confirmation and preserves the existing `Writing` section.

Files without a valid `## Source` followed by `## Writing` keep the original review behavior: their complete body is reviewed without content-fidelity comparison.

## Language, level, and writing style

There are three ways to configure the review target.

### Per document

Front matter has the highest priority and overrides settings for that document:

```yaml
---
lang: ja
level: N2
style: polite
topic: 自己紹介
---
```

Supported styles are `plain` (for example, だ・である), `polite` (for example, です・ます), and `formal` (formal written language).

In Markdown Preview, OneWriter displays this block as a collapsed section whose summary contains only the topic. Expanding it reveals all metadata. The source text remains unchanged in the editor.

### Change the defaults interactively

Run **OneWriter: Switch language and level**. The three-step Quick Pick asks for the language, level, and writing style, then updates `onewriter.targets` and `onewriter.activeTarget`.

### Edit settings manually

```jsonc
{
  "onewriter.targets": [
    { "language": "en", "level": "C1", "style": "formal" },
    { "language": "ja", "level": "N2", "style": "polite" }
  ],
  "onewriter.activeTarget": "ja"
}
```

Valid English levels are `A2`, `B1`, `B2`, and `C1`. Valid Japanese levels are `N4`, `N3`, `N2`, and `N1`. An incompatible language and level combination falls back to that language's middle default.

## Language codes

OneWriter uses lowercase ISO 639-1 language codes throughout: `en`, `ja`, and `vi`. Japanese is `ja`, not `jp`; `jp` is the ISO 3166 country code for Japan rather than a language code.

| Location | Example |
|---|---|
| `onewriter.nativeLanguage`, `onewriter.uiLanguage` | `vi` |
| `onewriter.targets[].language`, `onewriter.activeTarget` | `ja` |
| Front matter `lang` | `en` |
| Anki tag | `lang::ja` |

Files named `package.nls.*.json` follow VS Code display-locale identifiers instead. These are lowercase BCP 47 values and may include a region, such as `zh-cn` or `pt-br`. `currentLocale()` in `src/i18n.ts` removes the region before looking up the runtime bundle.

To add another target language:

1. Add its runtime translations and register its bundle in `src/i18n.ts`.
2. Extend `TargetLanguage` in `src/types.ts` and add its levels, correction policy, and any language-specific guidance in `src/levels.ts`.
3. Update the accepted-language guards in `src/config.ts`, `src/chunks/store.ts`, and `src/review/store.ts`.
4. Add its code to the relevant enums in `package.json`.
5. Add `package.nls.<code>.json` if manifest commands and settings should also be translated.

## Interface language

`onewriter.nativeLanguage` defaults to `vi` and controls generated source passages, review explanations configured for the native language, and Anki meanings. `onewriter.uiLanguage` defaults to `auto`. Automatic interface selection prefers `onewriter.nativeLanguage`, then the VS Code display language when a matching bundle exists, and finally English. Set the interface language explicitly to `en`, `vi`, or `ja` when needed. Changing it updates the OneWriter sidebar immediately.

Translations live in two places:

- `src/i18n.ts` contains runtime strings for notifications, Quick Picks, panels, and webviews. These follow `onewriter.uiLanguage`.
- `package.nls.*.json` contains command names, view names, and setting descriptions. VS Code reads these before the extension starts, so they follow the VS Code display language rather than the OneWriter setting.

The webview cannot call the extension host's `t()` function directly. OneWriter therefore injects the selected runtime bundle into each webview under a nonce-protected script.

## Review display modes

Choose a mode from the sidebar or set `onewriter.review.mode`:

| Mode | Experience | Best for |
|---|---|---|
| `codelens` | Underlines issues in the document and provides actions to apply a correction or view its explanation | Fast editing without leaving the writing flow |
| `webview` | Opens a side-by-side panel with the original, replacement, and full explanation | Studying each issue carefully |
| `diff` | Opens a VS Code diff between the original passage and the complete rewrite | Reviewing the overall revision |

All three modes use the same review result, so switching modes does not call the LLM again.

The latest result for each file is kept in workspace state. After closing a tab or reloading VS Code, run **OneWriter: Open latest review** to show it again. A new review replaces the previous result; **OneWriter: Clear review results** removes the stored result.

## Anki cards

The `OneWriter Chunk` note type has six fields: `Chunk`, `Meaning`, `Context`, `Corrected`, `Note`, and `Source`.

The front displays the meaning in the configured native language together with the sentence in which the chunk was selected. The back displays the target-language phrase. This direction practices sentence production rather than recognition, while `Context` keeps each card connected to the writer's own work.

| Field | Stored content |
|---|---|
| `Chunk` | The phrase selected in the practice file |
| `Meaning` | An LLM-generated meaning in the configured native language |
| `Context` | The original sentence containing the selection |
| `Corrected` | A new example sentence in the target language |
| `Note` | An optional LLM-generated usage note |
| `Source` | The source practice file name |

`Chunk` remains the first field because AnkiConnect checks duplicates using the first field, even though the card front does not display it.

Generated tags include `onewriter`, `lang::en`, `level::B1`, and one source tag: `src::selection`, `src::mistake`, or `src::upgrade`.

## How level affects review

Level is not passive metadata. It is included in the prompt and limits how aggressively the model may edit the passage. At A2 or N4, the model fixes only problems that affect comprehension and avoids vocabulary upgrades. At C1 or N1, it focuses on register and rhythm while leaving already-correct text alone. See `src/levels.ts` for the complete policies.

Set `onewriter.llm.promptTemplate` to replace the complete review prompt. Available variables are `{nativeLang}`, `{targetLang}`, `{level}`, `{style}`, `{levelPolicy}`, `{languageNotes}`, `{showBetterRule}`, `{maxChunks}`, `{explanationLanguage}`, `{text}`, `{schema}`, and `{topic}`.

## Technical notes

**Issue ranges are located by the extension.** The LLM returns the verbatim `original` string. `src/review/locate.ts` searches the document with a forward-moving cursor and normalizes common quotation-mark and dash variants as a fallback. If no reliable location is found, OneWriter drops the issue rather than highlighting the wrong text.

**JSON extraction tolerates common wrappers.** `src/llm/json.ts` accepts plain JSON, fenced JSON, and JSON surrounded by explanatory prose. Authentication and quota failures are not retried.

**AnkiConnect requests run only in the extension host.** AnkiConnect rejects requests with an unexpected Origin, so webviews never contact it directly.

## Project structure

```text
src/
  extension.ts        command registration, target switching, context synchronization
  i18n.ts             runtime translation bundles
  config.ts           settings and front-matter resolution
  front-matter.ts     shared front-matter parsing
  levels.ts           level-specific correction policies
  llm/                REST providers, SecretStorage, prompts, parsing, error classification
  review/             persistence, issue location, renderers, controller
  anki/               AnkiConnect client, note type, selection and save flow
  chunks/             per-file persistent chunk queue
  markdown/           Markdown Preview front-matter renderer
  ui/                 OneWriter sidebar
media/                webview and Markdown Preview CSS/JavaScript
package.nls.*.json    manifest translations
```

## Roadmap

- Warn when a level does not belong to the selected language instead of silently using a fallback.
- Add progress insights such as recurring issues and passages per week.
- Schedule practice based on the writer's older passages.
- Split very long passages into bounded review requests.
