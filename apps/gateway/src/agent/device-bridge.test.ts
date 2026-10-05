import type { ToolCall } from '@smith/core';
import type { ServerFrame } from '@smith/protocol';
import { createSystemScope } from '@smith/tenancy';
import { describe, expect, it, vi } from 'vitest';

import {
  createDeviceBridge,
  resolveDeviceResult,
  type PendingDeviceCalls,
} from './device-bridge.js';

const CALL: ToolCall = { toolCallId: 'call_model_1', name: 'cihaz_durumu', input: { q: 1 } };
const CTX = { scope: createSystemScope('device-bridge test') };

function setup(timeoutMs?: number) {
  const emitted: ServerFrame[] = [];
  const pending: PendingDeviceCalls = new Map();
  const bridge = createDeviceBridge({
    emit: (f) => emitted.push(f),
    pending,
    sessionId: 'ses_00000000000000000000',
    messageId: 'msg_00000000000000000000',
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  return { emitted, pending, bridge };
}

describe('createDeviceBridge', () => {
  it('tool_call frame yollar; eslesen tool_result cozer (call.toolCallId korunur)', async () => {
    const { emitted, pending, bridge } = setup();
    const p = bridge(CALL, CTX);

    expect(emitted).toHaveLength(1);
    const frame = emitted[0];
    if (frame?.type !== 'tool_call') throw new Error('tool_call frame bekleniyordu');
    expect(frame.name).toBe('cihaz_durumu');
    expect(frame.input).toEqual({ q: 1 });
    expect(frame.toolCallId).toMatch(/^tc_[0-9a-z]{20,32}$/);
    expect(frame.requiresApproval).toBe(false);

    const matched = resolveDeviceResult(pending, frame.toolCallId, {
      ok: true,
      result: { cpu: 42 },
    });
    expect(matched).toBe(true);

    // core loop mesaji call.toolCallId ile yazar → donen ToolResult onu tasimali.
    await expect(p).resolves.toEqual({
      toolCallId: 'call_model_1',
      ok: true,
      result: { cpu: 42 },
    });
    expect(pending.size).toBe(0);
  });

  it('zaman asiminda ok:false device_timeout doner (tur kirilmaz)', async () => {
    vi.useFakeTimers();
    try {
      const { bridge, pending } = setup(1000);
      const p = bridge(CALL, CTX);
      expect(pending.size).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(p).resolves.toEqual({
        toolCallId: 'call_model_1',
        ok: false,
        result: { error: 'device_timeout' },
      });
      expect(pending.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('iptal (signal abort) beklemeyi reddeder + haritayi temizler', async () => {
    const { bridge, pending } = setup();
    const ac = new AbortController();
    const p = bridge(CALL, { scope: CTX.scope, signal: ac.signal });
    expect(pending.size).toBe(1);
    ac.abort();
    await expect(p).rejects.toThrow(/iptal/);
    expect(pending.size).toBe(0);
  });

  it('onceden abort edilmis signal: aninda reddeder, frame yollamaz', async () => {
    const { bridge, pending, emitted } = setup();
    const ac = new AbortController();
    ac.abort();
    const p = bridge(CALL, { scope: CTX.scope, signal: ac.signal });
    await expect(p).rejects.toThrow(/iptal/);
    expect(pending.size).toBe(0);
    expect(emitted).toHaveLength(0);
  });

  it('resolveDeviceResult bilinmeyen tc_id icin false doner', () => {
    const pending: PendingDeviceCalls = new Map();
    expect(resolveDeviceResult(pending, 'tc_yok', { ok: true, result: 1 })).toBe(false);
  });
});
