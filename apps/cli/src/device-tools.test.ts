import { describe, expect, it } from 'vitest';

import { executeDeviceTool } from './device-tools.js';

describe('executeDeviceTool', () => {
  it('cihaz_bilgisi: ok + gercek sistem alanlari doner', () => {
    const r = executeDeviceTool('cihaz_bilgisi', {});
    expect(r.ok).toBe(true);
    const info = r.result as Record<string, unknown>;
    expect(typeof info.platform).toBe('string');
    expect(typeof info.hostname).toBe('string');
    expect(typeof info.cpuCount).toBe('number');
    expect(typeof info.uptimeSaat).toBe('number');
  });

  it('bilinmeyen arac: ok:false + aciklayici hata', () => {
    const r = executeDeviceTool('yok_boyle', {});
    expect(r.ok).toBe(false);
    expect(r.result).toMatchObject({ error: 'bilinmeyen device araci', name: 'yok_boyle' });
  });
});
