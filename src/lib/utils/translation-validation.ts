const TOKEN = /§\s*([MCP])\s*(\d+)\s*§/gi;
const OPAQUE = /§[MCP]\d+§/g;

const TARGET_SCRIPTS: Record<string, RegExp> = {
  ko: /\p{Script=Hangul}/u,
  ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  zh: /\p{Script=Han}/u,
  ar: /\p{Script=Arabic}/u,
  ru: /\p{Script=Cyrillic}/u,
  hi: /\p{Script=Devanagari}/u,
  th: /\p{Script=Thai}/u,
};

function readableText(text: string): string {
  return text.replace(OPAQUE, ' ')
    .replace(/(?:https?:\/\/|www\.)[^\s<>]+/gi, ' ')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, ' ')
    .replace(/[\p{N}\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function clearlyProse(text: string): boolean {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const words = text.match(/\p{L}+/gu)?.length ?? 0;
  return letters >= 18 && (words >= 4 || /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u.test(text));
}

/**
 * Reject broken alignment before either rendering or persisting it. This is
 * intentionally a conservative local check, not a second translation or a
 * guarantee of semantic accuracy. Names, identifiers and short chat can
 * legitimately remain in another script.
 */
export function validateTranslation(source: string, value: string | undefined, targetLanguage: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const expected = source.match(OPAQUE) ?? [];
  const normalized = value.trim().replace(TOKEN,
    (_, prefix: string, index: string) => '§' + prefix.toUpperCase() + index + '§');
  const actual = normalized.match(OPAQUE) ?? [];
  if (expected.length !== actual.length) return null;
  const counts = new Map<string, number>();
  for (const token of expected) counts.set(token, (counts.get(token) ?? 0) + 1);
  for (const token of actual) {
    const remaining = counts.get(token) ?? 0;
    if (!remaining) return null;
    counts.set(token, remaining - 1);
  }
  // Catch incomplete or invented internal marker fragments as well.
  const residue = /§\s*[MCP]\s*\d+/i;
  if (residue.test(normalized.replace(OPAQUE, '')) && !residue.test(source.replace(OPAQUE, ''))) return null;
  const script = TARGET_SCRIPTS[targetLanguage.toLowerCase().split('-')[0] ?? ''];
  if (script) {
    const original = readableText(source);
    const translated = readableText(normalized);
    if (!script.test(original) && clearlyProse(original) && !script.test(translated)) return null;
  }
  return normalized;
}
