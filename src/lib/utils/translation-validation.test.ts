
import { describe, expect, it } from 'vitest';
import { validateTranslation } from './translation-validation';

describe('local translation validation', () => {
  it('normalizes recoverable token spacing and preserves each expected token once', () => {
    expect(validateTranslation('Read §P0§ and §P1§.', '§ p 1 § 및 § P 0 § 읽기.', 'ko'))
      .toBe('§P1§ 및 §P0§ 읽기.');
  });
  it.each(['읽기.', '§P0§ §P0§ 읽기.', '§P0§ §P9§ 읽기.', '§P1§ 읽기.', '§P0§ §P9 읽기.'])(
    'rejects missing, repeated, unknown or malformed internal tokens (%s)', value => {
      expect(validateTranslation('Read §P0§.', value, 'ko')).toBeNull();
    },
  );
  it('rejects obvious untranslated prose without rejecting names, short chat or target-language originals', () => {
    expect(validateTranslation('This is a longer English sentence.', 'This is a longer English sentence.', 'ko')).toBeNull();
    expect(validateTranslation('This is a longer English sentence.', '이것은 더 긴 영어 문장입니다.', 'ko')).not.toBeNull();
    expect(validateTranslation('OpenAI GPT-6.2', 'OpenAI GPT-6.2', 'ko')).toBe('OpenAI GPT-6.2');
    expect(validateTranslation('lol', 'lol', 'ko')).toBe('lol');
    expect(validateTranslation('이미 한국어로 작성한 문장입니다.', '이미 한국어로 작성한 문장입니다.', 'ko')).not.toBeNull();
  });
});
