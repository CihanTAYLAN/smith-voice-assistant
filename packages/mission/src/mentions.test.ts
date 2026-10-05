import { describe, expect, it } from 'vitest';

import { extractMentions } from './mentions.js';

describe('mention cikarma', () => {
  it('basit mention bulur', () => {
    expect(extractMentions('@nova bunu devral')).toEqual(['nova']);
  });

  it('cumle icindeki birden fazla mention', () => {
    expect(extractMentions('bence @atlas bakmali, sonra @nova onaylar')).toEqual(['atlas', 'nova']);
  });

  it('buyuk harfli yazimi kucultur ve tekrari teklestirir', () => {
    expect(extractMentions('@Nova ve @NOVA ayni kisi')).toEqual(['nova']);
  });

  it('eposta adresini mention saymaz', () => {
    // Kullanicinin epostasi cihan@example.test — panoya yapistirildiginda
    // "example" adinda bir ajan varmis gibi davranmamali.
    expect(extractMentions('cihan@example.test adresine yaz')).toEqual([]);
  });

  it('tireli slug ve sonrasindaki noktalama', () => {
    expect(extractMentions('@kod-gozcusu, sen bak.')).toEqual(['kod-gozcusu']);
  });

  it('harfle baslamayan seyi mention saymaz', () => {
    expect(extractMentions('fiyat @2x oldu')).toEqual([]);
  });

  it('mention yoksa bos dizi', () => {
    expect(extractMentions('siradan bir yorum')).toEqual([]);
  });
});
