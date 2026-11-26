
import { describe, it, expect, afterEach } from 'vitest';
import { collectBilingualLayout, renderBilingualLayout, bilingualUnitId, clearTranslationView, readOriginalSource } from './bilingual-units';

function mount(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe('interleaved bilingual layout', () => {
  afterEach(() => document.body.replaceChildren());

  it('reuses the same canonical sentence units in both display modes', () => {
    const root = mount('<span>First sentence. Second sentence.\n\nThird sentence.</span>');
    const paragraph = collectBilingualLayout(root, 'paragraph')!;
    const sentence = collectBilingualLayout(root, 'sentence')!;
    expect(paragraph.units.map(({ block }) => block.text))
      .toEqual(['First sentence.', 'Second sentence.', 'Third sentence.']);
    expect(sentence.units).toEqual(paragraph.units);
    expect(sentence.fingerprint).toBe(paragraph.fingerprint);
    expect(renderBilingualLayout(root, paragraph, ['첫 문장.', '둘째 문장.', '셋째 문장.'])).toBe(true);
    expect(Array.from(root.querySelectorAll('.basa-bilingual-unit'), el => el.textContent))
      .toEqual(['첫 문장. 둘째 문장.', '셋째 문장.']);
  });

  it.each(['message', 'replace'] as const)('uses the same units for %s without changing source nodes', mode => {
    const root = mount('<p>First. Second <a href="https://example.com">link</a>.</p><ul><li>Third.</li></ul><pre><code>literal()</code></pre>');
    const link = root.querySelector('a')!;
    const plan = collectBilingualLayout(root, mode)!;
    const sentence = collectBilingualLayout(root, 'sentence')!;
    expect(plan.units).toEqual(sentence.units);
    expect(plan.fingerprint).toBe(sentence.fingerprint);
    expect(renderBilingualLayout(root, plan, ['첫째.', '둘째 §P0§.', '셋째.'])).toBe(true);
    const view = root.querySelector('.discord-translator-translation')!;
    expect(view.querySelector('p')?.textContent).toBe('첫째. 둘째 link.');
    expect(view.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(view.querySelector('ul > li')?.textContent).toBe('셋째.');
    expect(view.querySelector('pre > code')?.textContent).toBe('literal()');
    expect(readOriginalSource(root)).toBe(plan.source);
    clearTranslationView(root);
    expect(root.querySelector('a')).toBe(link);
    expect(root.textContent).toBe(plan.source);
  });

  it.each(['message', 'paragraph', 'sentence', 'replace'] as const)('rebinds a response to identical remounted source in %s mode', mode => {
    const root = mount('<span>First. Second.</span>');
    const plan = collectBilingualLayout(root, mode)!;
    root.innerHTML = '<span>First. Second.</span>';
    expect(renderBilingualLayout(root, plan, ['첫째.', '둘째.'])).toBe(true);
    expect(root.textContent).toContain('첫째.');
    expect(root.textContent).toContain('둘째.');
  });

  it('does not clone unrelated controls into a whole-message translation', () => {
    const root = mount('First. Second.<button>Control</button>');
    const plan = collectBilingualLayout(root, 'message')!;
    expect(renderBilingualLayout(root, plan, ['첫째.', '둘째.'])).toBe(true);
    expect(root.querySelector('.discord-translator-translation button')).toBeNull();
    expect(root.querySelectorAll('button')).toHaveLength(1);
  });

  it.each(['replace', 'partial'] as const)('preserves the intact source during a %s edit', edit => {
    const root = mount('One. Two. Three.');
    const original = root.firstChild as Text;
    expect(renderBilingualLayout(root, collectBilingualLayout(root, 'sentence')!, ['하나.', '둘.', '셋.'])).toBe(true);
    expect(original.data).toBe('One. Two. Three.');
    const expected = edit === 'replace' ? 'Edited message.' : 'Edited. Two. Three.';
    if (edit === 'replace') original.data = expected;
    else original.replaceData(0, 3, 'Edited');
    expect(readOriginalSource(root)).toBe(expected);
    clearTranslationView(root);
    expect(root.textContent).toBe(expected);
    expect(root.firstChild).toBe(original);
  });

  it('does not restore a source node removed by its parent', () => {
    const root = mount('<p>One. Two.</p>');
    const parent = root.firstElementChild!;
    const original = parent.firstChild!;
    expect(renderBilingualLayout(root, collectBilingualLayout(root, 'sentence')!, ['하나.', '둘.'])).toBe(true);
    parent.textContent = 'Replacement source.';
    clearTranslationView(root);
    expect(root.innerHTML).toBe('<p>Replacement source.</p>');
    expect(root.contains(original)).toBe(false);
  });

  it('restores the original text nodes after removing an unchanged interleaved view', () => {
    const root = mount('One. Two. Three.');
    const original = root.firstChild as Text;
    renderBilingualLayout(root, collectBilingualLayout(root, 'sentence')!, ['하나.', '둘.', '셋.']);
    clearTranslationView(root);
    expect(root.childNodes).toHaveLength(1);
    expect(root.firstChild).toBe(original);
    expect(original.data).toBe('One. Two. Three.');
  });

  it('protects abbreviated names and versions from artificial sentence splitting', () => {
    const root = mount('Ask Dr. Smith about v2.1.4. Next sentence.');
    const layout = collectBilingualLayout(root, 'sentence')!;
    expect(layout.units.map(({ block }) => block.text)).toEqual(['Ask Dr. Smith about v2.1.4.', 'Next sentence.']);
  });

  it('does not present an incomplete paragraph as a fully aligned translation', () => {
    const root = mount('<p>One. Two.</p><p>Three.</p>');
    const layout = collectBilingualLayout(root, 'paragraph')!;
    expect(renderBilingualLayout(root, layout, ['하나.', undefined, '셋.'])).toBe(true);
    expect(root.querySelector('p')?.querySelector('.basa-bilingual-unit')).toBeNull();
    expect(root.querySelectorAll('.basa-bilingual-unit')).toHaveLength(1);
  });

  it('interleaves sentences in the same text node without losing original text', () => {
    const root = mount('<span>One. Two. Three.</span>');
    const layout = collectBilingualLayout(root, 'sentence')!;
    expect(renderBilingualLayout(root, layout, ['하나.', '둘.', '셋.'])).toBe(true);
    const children = Array.from(root.querySelector('.basa-bilingual-preview')!.childNodes);
    expect(children.map((node) => node.textContent?.trim())).toEqual(['One.', '하나.', 'Two.', '둘.', 'Three.']);
    expect(root.firstElementChild?.nextElementSibling?.textContent).toBe('셋.');
    expect(renderBilingualLayout(root, layout, ['하나.', '둘.', '셋.'])).toBe(false);
  });

  it.each(['paragraph', 'sentence'] as const)('preserves the original rich message in %s mode', (granularity) => {
    const root = mount('<p>Ask <span class="mention" role="button">@Helper</span>. Read <a href="https://example.com">this link</a>.</p><ul><li>Parent.<ol><li>Child <code>inline()</code>.</li></ol></li></ul><pre><code>do_not_translate()</code></pre>');
    const original = root.innerHTML;
    const link = root.querySelector('a')!;
    const mention = root.querySelector('.mention')!;
    const list = root.querySelector('ul > li > ol > li')!;
    const layout = collectBilingualLayout(root, granularity)!;
    expect(layout.units.map(({ block }) => block.text))
      .toEqual(['Ask §P0§.', 'Read §P1§.', 'Parent.', 'Child §P2§.']);
    expect(renderBilingualLayout(root, layout, ['§P0§에게 물어봐.', '§P1§ 읽어.', '부모.', '자식 §P2§.'])).toBe(true);
    const pairs = root.querySelectorAll('.basa-bilingual-unit');
    expect(pairs).toHaveLength(granularity === 'paragraph' ? 3 : 4);
    expect(root.querySelector('.basa-bilingual-unit .mention')?.textContent).toBe('@Helper');
    expect(root.querySelector('.basa-bilingual-unit a')?.getAttribute('href')).toBe('https://example.com');
    expect(root.querySelector('.basa-bilingual-unit code')?.textContent).toBe('inline()');
    clearTranslationView(root);
    expect(root.querySelector('a')).toBe(link);
    expect(root.querySelector('.mention')).toBe(mention);
    expect(root.querySelector('ul > li > ol > li')).toBe(list);
    expect(root.innerHTML).toBe(original);
  });

  it('skips unchanged units and refuses stale asynchronous results', () => {
    const root = mount('One. Two.');
    const layout = collectBilingualLayout(root, 'sentence')!;
    root.textContent = 'Edited.';
    expect(renderBilingualLayout(root, layout, ['하나.', '둘.'])).toBe(false);
    root.textContent = 'One. Two.';
    const next = collectBilingualLayout(root, 'sentence')!;
    expect(renderBilingualLayout(root, next, ['One.', '둘.'])).toBe(true);
    expect(root.querySelectorAll('.basa-bilingual-unit')).toHaveLength(1);
  });

  it('shares a stable unit cache key but separates different source text', () => {
    expect(bilingualUnitId('123', 'One.')).toBe(bilingualUnitId('123', 'One.'));
    expect(bilingualUnitId('123', 'One.')).not.toBe(bilingualUnitId('123', 'Two.'));
    expect(bilingualUnitId('123', 'One.', 0, 'a')).not.toBe(bilingualUnitId('123', 'One.', 1, 'a'));
    expect(bilingualUnitId('123', 'One.', 0, 'a')).not.toBe(bilingualUnitId('123', 'One.', 0, 'b'));
  });

  it('bounds exceptionally fragmented messages without dropping the original', () => {
    const root = mount(Array.from({ length: 100 }, (_, i) => '<p>Line ' + i + '.</p>').join(''));
    expect(collectBilingualLayout(root, 'paragraph')).toBeNull();
    expect(root.querySelectorAll('p')).toHaveLength(100);
  });
});
