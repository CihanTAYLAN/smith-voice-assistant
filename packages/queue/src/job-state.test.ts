import { describe, expect, it, vi } from 'vitest';

import { hasLiveJob } from './job-state.js';

function queueWith(job: { state: string } | undefined) {
  const getJob = vi.fn((_id: string) =>
    Promise.resolve(job ? { getState: () => Promise.resolve(job.state) } : undefined),
  );
  return { getJob };
}

describe('hasLiveJob', () => {
  it.each(['active', 'waiting', 'delayed', 'prioritized', 'waiting-children'])(
    '%s is hala islenecek ya da isleniyor: canli sayilir',
    async (state) => {
      const queue = queueWith({ state });
      await expect(hasLiveJob(queue, 'run_1')).resolves.toBe(true);
      expect(queue.getJob).toHaveBeenCalledWith('run_1');
    },
  );

  it.each(['completed', 'failed', 'unknown'])(
    '%s is bu kosuyu bir daha ustlenmeyecek: canli sayilmaz',
    async (state) => {
      await expect(hasLiveJob(queueWith({ state }), 'run_1')).resolves.toBe(false);
    },
  );

  it('kuyruk kaydi hic yoksa (temizlenmis ya da Redis sifirlanmis) canli sayilmaz', async () => {
    await expect(hasLiveJob(queueWith(undefined), 'run_1')).resolves.toBe(false);
  });
});
