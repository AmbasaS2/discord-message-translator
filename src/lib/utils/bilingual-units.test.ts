
import { describe, it, expect, afterEach } from 'vitest';
import { collectBilingualLayout, renderBilingualLayout, bilingualUnitId } from './bilingual-units';

function mount(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe('interleaved bilingual layout', () => {
  afterEach(() => document.body.replaceChildren());

  it('keeps paragraph units together while sentence mode splits them', () => {
    const root = mount('<span>First sentence. Second sentence.\n\nThird sentence.</span>');
    expect(collectBilingualLayout(root, 'paragraph')?.units.map(({ block }) => block.text))
      .toEqual(['First sentence. Second sentence.', 'Third sentence.']);
    expect(collectBilingualLayout(root, 'sentence')?.units.map(({ block }) => block.text))
      .toEqual(['First sentence.', 'Second sentence.', 'Third sentence.']);
  });

  it('interleaves sentences in the same text node without losing original text', () => {
    const root = mount('<span>One. Two. Three.</span>');
    const layout = collectBilingualLayout(root, 'sentence')!;
    expect(renderBilingualLayout(root, layout, ['하나.', '둘.', '셋.'])).toBe(true);
    const children = Array.from(root.firstElementChild!.childNodes);
    expect(children.map((node) => node.textContent?.trim())).toEqual(['One.', '하나.', 'Two.', '둘.', 'Three.', '셋.']);
    expect(renderBilingualLayout(root, layout, ['하나.', '둘.', '셋.'])).toBe(false);
  });

  it('keeps original links, nested lists, and code blocks intact', () => {
    const root = mount('<p>Read <a href="https://example.com">this link</a>.</p><ul><li>Parent.<ol><li>Child.</li></ol></li></ul><pre><code>do_not_translate()</code></pre>');
    const link = root.querySelector('a')!;
    const code = root.querySelector('pre')!;
    const layout = collectBilingualLayout(root, 'paragraph')!;
    expect(layout.units.map(({ block }) => block.text)).toEqual(['Read §P0§.', 'Parent.', 'Child.']);
    expect(renderBilingualLayout(root, layout, ['§P0§ 읽어.', '부모.', '자식.'])).toBe(true);
    expect(root.querySelector('a')).toBe(link);
    expect(root.querySelector('pre')).toBe(code);
    expect(root.querySelector('ul > li > ol > li')).not.toBeNull();
    expect(root.querySelectorAll('.basa-bilingual-unit')).toHaveLength(3);
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
  });

  it('bounds exceptionally fragmented messages without dropping the original', () => {
    const root = mount(Array.from({ length: 100 }, (_, i) => '<p>Line ' + i + '.</p>').join(''));
    expect(collectBilingualLayout(root, 'paragraph')).toBeNull();
    expect(root.querySelectorAll('p')).toHaveLength(100);
  });
});
