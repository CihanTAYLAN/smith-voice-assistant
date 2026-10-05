import { describe, expect, it, vi } from 'vitest';

import { BoundedOutput } from './output-capture.js';

describe('BoundedOutput', () => {
  it('byte sinirinda bellekte buyumeyi durdurur ve yalniz bir kez haber verir', () => {
    const onLimit = vi.fn();
    const output = new BoundedOutput(5, onLimit);
    output.append(Buffer.from('abc'));
    output.append(Buffer.from('def'));
    output.append(Buffer.from('ghi'));
    expect(Buffer.byteLength(output.text)).toBeLessThanOrEqual(5);
    expect(onLimit).toHaveBeenCalledTimes(1);
    expect(output.exceeded).toBe(true);
  });
});
