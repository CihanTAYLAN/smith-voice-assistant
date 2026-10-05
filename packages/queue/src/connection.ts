import { Queue, Worker, type Job, type WorkerOptions } from 'bullmq';
import { Redis } from 'ioredis';

import { QUEUE_JOB_OPTIONS } from './options.js';
import { parseQueuePayload, type QueuePayloadMap } from './payloads.js';
import type { QueueName } from './queue-names.js';

/**
 * BullMQ baglanti ve kurulum yardimcilari. Amac: producer/consumer kurulumu
 * tek desene insin — dogru preset, dogru payload dogrulamasi, dogru kapatma.
 */

/** BullMQ, bloklayan komutlar icin maxRetriesPerRequest=null ister. */
export function createQueueConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

export function createQueue<TName extends QueueName>(
  name: TName,
  connection: Redis,
): Queue<QueuePayloadMap[TName]> {
  return new Queue(name, {
    connection,
    defaultJobOptions: QUEUE_JOB_OPTIONS[name],
  });
}

/**
 * Payload'i isleme girmeden dogrulayan worker. Gecersiz payload islenmez,
 * is basarisiz sayilir ve BullMQ'nun failed listesinde gorunur — sessiz
 * yutma yok.
 */
export function createQueueWorker<TName extends QueueName>(
  name: TName,
  connection: Redis,
  handler: (payload: QueuePayloadMap[TName], job: Job) => Promise<void>,
  options?: Omit<WorkerOptions, 'connection'>,
): Worker {
  return new Worker(
    name,
    async (job) => {
      const payload = parseQueuePayload(name, job.data);
      await handler(payload, job);
    },
    { connection, ...options },
  );
}
