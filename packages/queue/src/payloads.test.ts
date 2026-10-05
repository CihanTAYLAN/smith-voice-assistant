import { describe, expect, it } from 'vitest';

import { QUEUE_JOB_OPTIONS, interactiveOptions } from './options.js';
import { parseQueuePayload, QueuePayloadError } from './payloads.js';
import { ALL_QUEUE_NAMES, QueueName } from './queue-names.js';

const WS = 'ws_abcdefghij0123456789';

describe('queue payload sozlesmesi', () => {
  it('bakim actor ve workspace gerektirir, otomatik retry yapmaz', () => {
    expect(() => parseQueuePayload(QueueName.MEMORY_MAINTENANCE, { workspaceId: WS })).toThrow(
      QueuePayloadError,
    );
    expect(
      parseQueuePayload(QueueName.MEMORY_MAINTENANCE, {
        workspaceId: WS,
        actorId: 'act_abcdefghijklmnopqrst',
      }),
    ).toEqual({ workspaceId: WS, actorId: 'act_abcdefghijklmnopqrst' });
    expect(QUEUE_JOB_OPTIONS[QueueName.MEMORY_MAINTENANCE].attempts).toBe(1);
  });
  it('kapsamsiz is reddedilir — kuyruk uzerinden tenant siniri asilamaz', () => {
    expect(() =>
      parseQueuePayload(QueueName.MEMORY_INDEX, { kind: 'message', sourceId: 'msg_x' }),
    ).toThrow(QueuePayloadError);
  });

  it('bicimsiz workspaceId reddedilir', () => {
    expect(() =>
      parseQueuePayload(QueueName.MEMORY_INDEX, {
        workspaceId: 'tenant-1',
        kind: 'message',
        sourceId: 'msg_x',
      }),
    ).toThrow(QueuePayloadError);
  });

  it('gecerli memory-index payload gecer ve tiplenir', () => {
    const p = parseQueuePayload(QueueName.MEMORY_INDEX, {
      workspaceId: WS,
      kind: 'message',
      sourceId: 'msg_abc',
    });
    expect(p.kind).toBe('message');
  });

  it('session-summary varsayilanlari uygular', () => {
    const p = parseQueuePayload(QueueName.SESSION_SUMMARY, {
      workspaceId: WS,
      sessionId: 'ses_abcdefghij0123456789',
    });
    expect(p.minMessages).toBe(10);
  });
});

describe('is-tipi preset invariantlari', () => {
  it('etkilesimli isler retry YAPMAZ', () => {
    expect(interactiveOptions.attempts).toBe(1);
  });

  it('her kuyrugun preset girisi var', () => {
    for (const name of ALL_QUEUE_NAMES) {
      expect(QUEUE_JOB_OPTIONS[name]).toBeDefined();
    }
  });
});
