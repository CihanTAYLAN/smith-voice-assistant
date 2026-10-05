import { newActorId, newSessionId, newWorkspaceId } from '@smith/db';
import { parseQueuePayload, QueueName } from '@smith/queue';
import { createWorkspaceScope } from '@smith/tenancy';
import { describe, expect, it } from 'vitest';

import {
  createSessionSummaryScheduler,
  SUMMARY_MIN_MESSAGES,
  summaryDeduplicationId,
} from './session-summary-scheduler.js';

/** `add` cagrilarini kaydeden dar kuyruk sahtesi. */
function sahteKuyruk() {
  const cagrilar: unknown[][] = [];
  return {
    cagrilar,
    queue: {
      add: (...args: unknown[]) => {
        cagrilar.push(args);
        return Promise.resolve(undefined);
      },
    },
  };
}

describe('createSessionSummaryScheduler', () => {
  it('tek atomik add ile debounce kurar: replace + keepLastIfActive, jobId yok', async () => {
    const { cagrilar, queue } = sahteKuyruk();
    const workspaceId = newWorkspaceId();
    const actorId = newActorId();
    const sessionId = newSessionId();
    const scope = createWorkspaceScope({ workspaceId, actorId, role: 'member' });

    await createSessionSummaryScheduler(queue as never).schedule({
      scope,
      sessionId,
      delayMs: 123_000,
    });

    expect(cagrilar).toHaveLength(1);
    const [ad, veri, secenekler] = cagrilar[0] as [string, unknown, Record<string, unknown>];
    expect(ad).toBe('summarize');
    expect(secenekler).toEqual({
      delay: 123_000,
      deduplication: {
        id: summaryDeduplicationId(sessionId),
        replace: true,
        keepLastIfActive: true,
      },
    });
    // Gonderilen payload kuyruk sozlesmesinden gecer (worker ayni semayi kullanir).
    expect(parseQueuePayload(QueueName.SESSION_SUMMARY, veri)).toMatchObject({
      workspaceId,
      actorId,
      sessionId,
      minMessages: SUMMARY_MIN_MESSAGES,
    });
  });

  it('kuyruk hatasini yutmaz, cagirana iletir', async () => {
    const scope = createWorkspaceScope({
      workspaceId: newWorkspaceId(),
      actorId: newActorId(),
      role: 'member',
    });
    const queue = {
      add: () => Promise.reject(new Error('redis kapali')),
    };
    await expect(
      createSessionSummaryScheduler(queue as never).schedule({
        scope,
        sessionId: newSessionId(),
        delayMs: 1000,
      }),
    ).rejects.toThrow('redis kapali');
  });
});
