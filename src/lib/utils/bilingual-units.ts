import { buildInlineFromTranslation, type Placeholder, type StructuredBlock } from './structure-preserving';

export type BilingualGranularity = 'paragraph' | 'sentence' | 'message' | 'replace';

type Anchor = { node: Text; offset: number } | { node: HTMLElement; offset?: undefined };
type Piece = {
  start: number;
  end: number;
  node: Text | HTMLElement;
  kind: 'text' | 'atomic' | 'break';
  placeholder?: Placeholder;
};

interface SourcePart { node: Text | HTMLElement; from: number; to: number }

export interface BilingualUnit {
  block: StructuredBlock;
  parts: SourcePart[];
  anchor: Anchor;
  send: boolean;
  paragraph: number;
  gapBefore: string;
}

export interface BilingualLayout {
  source: string;
  fingerprint: string;
  granularity: BilingualGranularity;
  units: BilingualUnit[];
}

const BLOCK = /^(P|DIV|SECTION|ARTICLE|BLOCKQUOTE|H[1-6]|UL|OL|LI|DL|DT|DD)$/;
const PROTECTED = 'a[href], code, img, time, [class*="emojiContainer"], [class*="channelMention"], [class*="roleMention"], [class*="userMention"], .mention, [contenteditable="false"]';
const IGNORED = '[class*="hiddenVisually"], [aria-hidden="true"]:not(img):not([class*="emojiContainer"]), .discord-translator-translation, button, svg, script, style';
const MAX_UNITS = 96;
let sentenceSegmenter: Intl.Segmenter | undefined;

function hashText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

function sentenceRanges(text: string, start: number, end: number): Array<[number, number]> {
  if (typeof Intl.Segmenter !== 'function') return [[start, end]];
  sentenceSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'sentence' });
  const paragraph = text.slice(start, end);
  const protectedRanges: Array<[number, number]> = [];
  // As in Phrase Desk, punctuation within URLs, abbreviations, versions and
  // protected tokens must not become artificial sentence boundaries.
  for (const pattern of [
    /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    /\b(?:v?\d+(?:\.\d+)+)\b/gi,
    /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)\.\s+\S+/gi,
    /\b(?:a\.m|p\.m)\./gi,
    /§P\d+§/g,
  ]) {
    for (const match of paragraph.matchAll(pattern)) {
      const at = match.index!;
      protectedRanges.push([at, at + match[0].length]);
    }
  }
  protectedRanges.sort((a, b) => a[0] - b[0]);
  const ranges: Array<[number, number]> = [];
  let protectionIndex = 0;
  let protectedUntil = -1;
  for (const { index, segment } of sentenceSegmenter.segment(paragraph)) {
    while (protectionIndex < protectedRanges.length && protectedRanges[protectionIndex]![0] < index) {
      protectedUntil = Math.max(protectedUntil, protectedRanges[protectionIndex]![1]);
      protectionIndex++;
    }
    const previous = ranges[ranges.length - 1];
    if (previous && index < protectedUntil) previous[1] = start + index + segment.length;
    else ranges.push([start + index, start + index + segment.length]);
  }
  return ranges;
}

/**
 * Project visible inline content into text once, retaining the exact DOM
 * insertion boundary of each unit. Protected inline objects stay atomic.
 * Paragraphs use block elements and blank lines, not visual line wrapping.
 */
export function collectBilingualLayout(root: HTMLElement, granularity: BilingualGranularity): BilingualLayout | null {
  const source = root.textContent ?? '';
  const units: BilingualUnit[] = [];
  let pieces: Piece[] = [];
  let text = '';
  let tokenIndex = 0;
  let paragraphIndex = 0;
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
      // Both layouts use the same canonical units. Paragraph mode only groups
      // their rendered translations; it does not create a second translation.
      const paragraph = paragraphIndex++;
      const ranges = sentenceRanges(text, pStart, pEnd);
      let previousEnd = pStart;
      for (const [rawStart, rawEnd] of ranges) {
        const raw = text.slice(rawStart, rawEnd);
        const value = raw.trim();
        if (!value) continue;
        const from = rawStart + raw.length - raw.trimStart().length;
        const to = rawEnd - (raw.length - raw.trimEnd().length);
        while (cursor < pieces.length && pieces[cursor]!.end <= from) cursor++;
        let endPiece: Piece | undefined;
        const placeholders: Placeholder[] = [];
        const parts: SourcePart[] = [];
        for (let i = cursor; i < pieces.length && pieces[i]!.start < to; i++) {
          const piece = pieces[i]!;
          endPiece = piece;
          parts.push({
            node: piece.node,
            from: Math.max(from, piece.start) - piece.start,
            to: Math.min(to, piece.end) - piece.start,
          });
          if (piece.placeholder) placeholders.push(piece.placeholder);
        }
        if (!endPiece) continue;
        // Do not split an inline object, even if a segmenter returns an odd boundary.
        if (endPiece.kind === 'atomic' && to !== endPiece.end) { overflow = true; break; }
        if (placeholders.some(({ token }) => !value.includes(token))) { overflow = true; break; }
        const send = /\p{L}/u.test(value.replace(/§P\d+§/g, ''));
        const anchor: Anchor = endPiece.kind === 'text'
          ? { node: endPiece.node as Text, offset: to - endPiece.start }
          : { node: endPiece.node as HTMLElement };
        units.push({
          block: { tagName: 'p', text: value, placeholders },
          parts, anchor, send, paragraph, gapBefore: text.slice(previousEnd, from),
        });
        previousEnd = to;
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
  return overflow ? null : { source, fingerprint: hashText(source), granularity, units };
}

export function bilingualUnitId(messageId: string, text: string, ordinal = 0, fingerprint = ''): string {
  return `${messageId}-basa-pair-v2-${fingerprint}-${ordinal}-${text.length}-${hashText(text)}`;
}

interface OwnedSplit { original: Text; suffix: Text; prefix: string; suffixText: string }
const ownedSplits = new WeakMap<HTMLElement, OwnedSplit[]>();

/** Read only Discord's source, without collecting any previously inserted translation. */
export function readOriginalSource(root: HTMLElement): string {
  if (!root.querySelector('.discord-translator-translation')) return root.textContent ?? '';
  const visit = (node: Node): string => {
    if (node instanceof Element && node.matches('.discord-translator-translation')) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    let value = '';
    for (const child of node.childNodes) value += visit(child);
    return value;
  };
  return visit(root);
}

/** Undo only our own display nodes and text splits. Never restore stale source text. */
export function clearTranslationView(root: HTMLElement): void {
  root.querySelectorAll('.discord-translator-translation').forEach(node => node.remove());
  for (const split of (ownedSplits.get(root) ?? []).slice().reverse()) {
    const { original, suffix, prefix, suffixText } = split;
    if (!root.contains(suffix)) continue;
    if (root.contains(original) && original.parentNode === suffix.parentNode && original.data === prefix) {
      original.data += suffix.data;
      suffix.remove();
    } else if (suffix.data === suffixText) {
      // React may have replaced the original text with the entire edited message.
      suffix.remove();
    }
  }
  ownedSplits.delete(root);
  for (const child of Array.from(root.children)) {
    if (child.classList.contains('discord-translator-original')) child.replaceWith(...child.childNodes);
  }
}

function insertAfterAnchor(root: HTMLElement, anchor: Anchor, translation: HTMLElement, splits: OwnedSplit[]): void {
  let node: Node = anchor.node;
  if (anchor.offset !== undefined && anchor.offset < anchor.node.length) {
    const following = anchor.node.splitText(anchor.offset);
    splits.push({ original: anchor.node, suffix: following, prefix: anchor.node.data, suffixText: following.data });
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

/**
 * Compose the complete translated view from the same aligned units as the
 * interleaved view. Clone only once, on initial render, and leave live source
 * nodes alone in append mode. Untranslated spans and code remain intact.
 */
function renderWholeLayout(root: HTMLElement, layout: BilingualLayout, translations: Array<string | undefined>): boolean {
  type Edit = { from: number; to: number; insertion?: DocumentFragment };
  const edits = new Map<Node, Edit[]>();
  for (let i = 0; i < layout.units.length; i++) {
    const unit = layout.units[i]!;
    const value = translations[i];
    if (!unit.send || !value || value === unit.block.text) continue;
    if (unit.parts.some(part => !root.contains(part.node) ||
        (part.node instanceof Text && part.to > part.node.length))) return false;
    unit.parts.forEach((part, partIndex) => {
      const list = edits.get(part.node) ?? [];
      list.push({
        from: part.from, to: part.to,
        ...(partIndex === 0 ? { insertion: buildInlineFromTranslation(value, unit.block.placeholders) } : {}),
      });
      edits.set(part.node, list);
    });
  }
  if (!edits.size) return false;
  const container = document.createElement('div');
  container.className = 'discord-translator-translation';
  container.style.cssText = layout.granularity === 'replace'
    ? 'font-size: 0.95em;' : 'font-size: 0.95em; margin-top: 4px;';

  function copy(node: Node, target: Node): void {
    const changes = edits.get(node);
    if (node instanceof Text && changes) {
      let cursor = 0;
      for (const edit of changes) {
        if (edit.from > cursor) target.appendChild(document.createTextNode(node.data.slice(cursor, edit.from)));
        if (edit.insertion) target.appendChild(edit.insertion);
        cursor = edit.to;
      }
      if (cursor < node.length) target.appendChild(document.createTextNode(node.data.slice(cursor)));
      return;
    }
    if (changes) {
      for (const edit of changes) if (edit.insertion) target.appendChild(edit.insertion);
      return;
    }
    const clone = node.cloneNode(false);
    if (clone instanceof Element) clone.removeAttribute('id');
    target.appendChild(clone);
    for (const child of node.childNodes) copy(child, clone);
  }
  for (const child of root.childNodes) copy(child, container);
  // Placeholders are cloned too. Do not introduce duplicate document IDs.
  container.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
  if (layout.granularity === 'replace') {
    const original = document.createElement('span');
    original.className = 'discord-translator-original';
    original.style.display = 'none';
    original.append(...root.childNodes);
    root.appendChild(original);
  }
  root.appendChild(container);
  return true;
}

/** Insert only translated units; original links, mentions and text remain in the live DOM. */
export function renderBilingualLayout(root: HTMLElement, layout: BilingualLayout, translations: Array<string | undefined>): boolean {
  if (!root.isConnected || root.querySelector('.discord-translator-translation') ||
      root.textContent !== layout.source || translations.length !== layout.units.length) return false;
  if (layout.granularity === 'message' || layout.granularity === 'replace') {
    return renderWholeLayout(root, layout, translations);
  }

  const inserts: Array<{ anchor: Anchor; node: HTMLElement }> = [];
  let start = 0;
  while (start < layout.units.length) {
    let end = start + 1;
    if (layout.granularity === 'paragraph') {
      while (end < layout.units.length &&
          layout.units[end]!.paragraph === layout.units[start]!.paragraph) end++;
    }
    let changed = false;
    let complete = true;
    for (let i = start; i < end; i++) {
      const unit = layout.units[i]!;
      if (unit.send && !translations[i]) complete = false;
      if (unit.send && translations[i] && translations[i] !== unit.block.text) changed = true;
    }
    // A paragraph pair is only shown when its source units can be matched.
    // Do not disguise a partially failed response as a complete translation.
    if (changed && complete) {
      const anchor = layout.units[end - 1]!.anchor;
      if (!root.contains(anchor.node) || (anchor.offset !== undefined && anchor.offset > anchor.node.length)) return false;
      const node = document.createElement('span');
      node.className = 'discord-translator-translation basa-bilingual-unit';
      for (let i = start; i < end; i++) {
        const unit = layout.units[i]!;
        if (i > start) node.appendChild(document.createTextNode(unit.gapBefore));
        node.appendChild(buildInlineFromTranslation(unit.send ? translations[i]! : unit.block.text, unit.block.placeholders));
      }
      inserts.push({ anchor, node });
    }
    start = end;
  }
  // Later text offsets must be used first so splitText cannot invalidate them.
  const splits: OwnedSplit[] = [];
  for (let i = inserts.length - 1; i >= 0; i--) {
    const item = inserts[i]!;
    insertAfterAnchor(root, item.anchor, item.node, splits);
  }
  if (splits.length) ownedSplits.set(root, splits);
  return inserts.length > 0;
}
