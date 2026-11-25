import { describe, it, expect } from 'vitest';
import { surfaceText, isSearchSurface } from './surface-translator';

describe('surface translation helpers', () => {
  it('reads only DOM source text, not translation data attributes', () => {
    const element = document.createElement('div');
    element.textContent = 'General  discussion';
    element.setAttribute('data-basa-translation', '일반 토론');
    expect(surfaceText(element)).toBe('General discussion');
  });

  it('identifies search result content independently of ordinary messages', () => {
    const search = document.createElement('div');
    search.className = 'searchResult__fixture';
    const message = document.createElement('div');
    message.id = 'message-content-123';
    search.appendChild(message);
    expect(isSearchSurface(message)).toBe(true);
    expect(isSearchSurface(document.createElement('div'))).toBe(false);
  });
});
