/** Extract model JSON from raw text, a code fence, or surrounding prose. */
export function extractJsonObject(raw: string): unknown {
  const text = raw.trim();

  const direct = tryParse(text);
  if (direct !== undefined) {
    return direct;
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed !== undefined) {
      return parsed;
    }
  }

  const balanced = findBalancedObject(text);
  if (balanced) {
    const parsed = tryParse(balanced);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  throw new Error('No valid JSON found in the model response.');
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Quét từ dấu `{` đầu tiên, đếm ngoặc, bỏ qua ngoặc nằm trong chuỗi. */
function findBalancedObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start < 0) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}
