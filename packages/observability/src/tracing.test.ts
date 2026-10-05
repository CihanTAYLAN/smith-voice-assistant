import { afterEach, describe, expect, it } from 'vitest';

import { initTracing, isTracingActive, observe, shutdownTracing } from './tracing.js';

afterEach(async () => {
  await shutdownTracing();
});

describe('tracing yapilandirma kapisi', () => {
  it('hic yapilandirma yoksa: kapali, net gerekce', () => {
    const state = initTracing({});
    expect(state.enabled).toBe(false);
    if (!state.enabled) expect(state.reason).toContain('yapilandirilmamis');
    expect(isTracingActive()).toBe(false);
  });

  it('yarim yapilandirma sessizce yutulmaz — eksik alanlar soylenir', () => {
    const state = initTracing({ baseUrl: 'https://langfuse.example', publicKey: 'pk' });
    expect(state.enabled).toBe(false);
    if (!state.enabled) expect(state.reason).toContain('secretKey');
  });

  it('kapaliyken observe passthrough calisir', async () => {
    initTracing({});
    const result = await observe('test', { workspaceId: 'ws_x' }, () => Promise.resolve(42));
    expect(result).toBe(42);
  });
});
