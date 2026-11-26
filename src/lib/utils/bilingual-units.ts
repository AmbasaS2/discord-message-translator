import { buildInlineFromTranslation, type Placeholder, type StructuredBlock } from './structure-preserving';

export type InterleavedGranularity = 'paragraph' | 'sentence';

type Anchor = { node: Text; offset: number } | { node: HTMLElement; offset?: undefined };
type Piece = {
  start: number;
  end: number;
  node: Text | HTMLElement;
  kind: 'text' | 'atomic' | 'break';
  placeholder?: Placeholder;
};

export interface BilingualUnit {
  block: StructuredBlock;
  anchor: Anchor;
  send: boolean;
}

export interface BilingualLayout {
  source: string;
  units: BilingualUnit[];
}

const BLOCK = /^(P|DIV|SECTION|ARTICLE|BLOCKQUOTE|H[1-6]|UL|OL|LI|DL|DT|DD)$/;
const PROTECTED = 'a[href], code, img, time, [class*="emojiContainer"], [class*="channelMention"], [class*="roleMention"], [class*="userMention"], .mention, [contenteditable="false"]';
const IGNORED = '[class*="hiddenVisually"], [aria-hidden="true"]:not(img):not([class*="emojiContainer"]), .discord-translator-translation, button, svg, script, style';
const MAX_UNITS = 96;
let sentenceSegmenter: Intl.Segmenter | undefined;

function sentenceRanges(text: string, start: number, end: number): Array<[number, number]> {
  if (typeof Intl.Segmenter !== 'function') return [[start, end]];
  sentenceSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'sentence' });
  return Array.from(sentenceSegmenter.segment(text.slice(start, end)), ({ index, segment }) =>
    [start + index, start + index + segment.length]);
}

/**
 * Project visible inline content into text once, retaining the exact DOM
 * insertion boundary of each unit. Protected inline objects stay atomic.
 * Paragraphs use block elements and blank lines, not visual line wrapping.
 */
export function collectBilingualLayout(root: HTMLElement, granularity: InterleavedGranularity): BilingualLayout | null {
  const source = root.textContent ?? '';
  const units: BilingualUnit[] = [];
  let pieces: Piece[] = [];
  let text = '';
  let tokenIndex = 0;
  let overflow = false;

  function addPiece(value: string, node: Text | HTMLElement, kind: Piece['kind'], placeholder?: Placeholder): void {
    if (!value) return;
    pieces.push({ start: text.length, end: text.length + value.length, node, kind, placeholder });
    text += value;
  }

  function flush(): void {
    if (!text || overflow) { pieces = []; text = ''; return; }
    const paragraphs: Array<[number, number]> = [];
    const gaps = /\n[^\S\n]*\n(?:[^\S\n]*\n)*/g;
    let start = 0;
    for (const gap of text.matchAll(gaps)) {
      paragraphs.push([start, gap.index!]);
      start = gap.index! + gap[0].length;
    }
    paragraphs.push([start, text.length]);

    let cursor = 0;
    for (const [pStart, pEnd] of paragraphs) {
      const ranges = granularity === 'sentence' ? sentenceRanges(text, pStart, pEnd) : [[pStart, pEnd] as [number, number]];
      for (const [rawStart, rawEnd] of ranges) {
        const raw = text.slice(rawStart, rawEnd);
        const value = raw.trim();
        if (!value) continue;
        const from = rawStart + raw.length - raw.trimStart().length;
        const to = rawEnd - (raw.length - raw.trimEnd().length);
        while (cursor < pieces.length && pieces[cursor]!.end <= from) cursor++;
        let endPiece: Piece | undefined;
        const placeholders: Placeholder[] = [];
        for (let i = cursor; i < pieces.length && pieces[i]!.start < to; i++) {
          const piece = pieces[i]!;
          endPiece = piece;
          if (piece.placeholder) placeholders.push(piece.placeholder);
        }
        if (!endPiece) continue;
        // Do not split an inline object, even if a segmenter returns an odd boundary.
        if (endPiece.kind === 'atomic' && to !== endPiece.end) { overflow = true; break; }
        if (placeholders.some(({ token }) => !value.includes(token))) { overflow = true; break; }
        const send = /\p{L}/u.test(value.replace(/§P\d+§/g, ''));
        if (!send) continue;
        const anchor: Anchor = endPiece.kind === 'text'
          ? { node: endPiece.node as Text, offset: to - endPiece.start }
          : { node: endPiece.node as HTMLElement };
        units.push({ block: { tagName: 'p', text: value, placeholders }, anchor, send });
        if (units.length > MAX_UNITS) { overflow = true; break; }
      }
      if (overflow) break;
    }
    pieces = [];
    text = '';
  }

  function visit(node: Node): void {
    if (overflow) return;
    if (node.nodeType === Node.TEXT_NODE) {
      addPiece(node.textContent ?? '', node as Text, 'text');
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.matches(IGNORED)) return;
    if (node.tagName === 'PRE' || node.tagName === 'HR') { flush(); return; }
    if (node.tagName === 'BR') { addPiece('\n', node, 'break'); return; }
    if (node.matches(PROTECTED)) {
      // Keep the live original node; the translation uses the existing inline
      // placeholder renderer only when there is a successful translated unit.
      const token = `§P${tokenIndex++}§`;
      addPiece(token, node, 'atomic', { token, node });
      return;
    }
    const boundary = BLOCK.test(node.tagName);
    if (boundary) flush();
    for (const child of node.childNodes) visit(child);
    if (boundary) flush();
  }

  for (const child of root.childNodes) visit(child);
  flush();
  // Abnormally fragmented messages retain the existing whole-message layout
  // rather than producing an unbounded number of separate API items.
  return overflow ? null : { source, units };
}

export function bilingualUnitId(messageId: string, text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${messageId}-basa-pair-v1-${text.length}-${(hash >>> 0).toString(36)}`;
}

function insertAfterAnchor(root: HTMLElement, anchor: Anchor, translation: HTMLElement): void {
  let node: Node = anchor.node;
  if (anchor.offset !== undefined && anchor.offset < anchor.node.length) {
    const following = anchor.node.splitText(anchor.offset);
    following.parentNode!.insertBefore(translation, following);
    return;
  }
  // Prefer inserting beside a completed inline wrapper rather than inside it.
  while (node.parentElement && node.parentElement !== root &&
      !BLOCK.test(node.parentElement.tagName) && !node.nextSibling) {
    node = node.parentElement;
  }
  node.parentNode!.insertBefore(translation, node.nextSibling);
}

/** Insert only translated units; original links, mentions and text remain in the live DOM. */
export function renderBilingualLayout(root: HTMLElement, layout: BilingualLayout, translations: string[]): boolean {
  if (!root.isConnected || root.querySelector('.discord-translator-translation') ||
      root.textContent !== layout.source || translations.length !== layout.units.length) return false;

  const inserts: Array<{ anchor: Anchor; node: HTMLElement }> = [];
  for (let i = 0; i < layout.units.length; i++) {
    const unit = layout.units[i]!;
    const translated = translations[i];
    if (!translated || translated === unit.block.text || !unit.send) continue;
    if (!root.contains(unit.anchor.node) || (unit.anchor.offset !== undefined && unit.anchor.offset > unit.anchor.node.length)) return false;
    const node = document.createElement('span');
    node.className = 'discord-translator-translation basa-bilingual-unit';
    node.appendChild(buildInlineFromTranslation(translated, unit.block.placeholders));
    inserts.push({ anchor: unit.anchor, node });
  }
  // Later text offsets must be used first so splitText cannot invalidate them.
  for (let i = inserts.length - 1; i >= 0; i--) {
    const item = inserts[i]!;
    insertAfterAnchor(root, item.anchor, item.node);
  }
  return inserts.length > 0;
}
