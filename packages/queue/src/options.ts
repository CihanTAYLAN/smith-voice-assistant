import type { JobsOptions } from 'bullmq';

import { QueueName } from './queue-names.js';

/**
 * Is yuku sekline gore defaultJobOptions preset'leri (earlier-project deseninden).
 * Producer jobId override ederken de ayni preset'i gecirir; retry/temizlik
 * davranisi kuyruk basina TEK yerden yonetilir.
 */

/** Etkilesimli, kullanici-tetikli is. Retry yok — kullanici kendisi tekrar dener. */
export const interactiveOptions: JobsOptions = {
  attempts: 1,
  removeOnComplete: 100,
  removeOnFail: 100,
};

/**
 * Uzun suren arka plan isi (indeksleme, ozetleme). Bu isler bulut gomme/ozet
 * uclarina gider; kota (429) ve kesinti saniyelerle degil dakikalarla olculur.
 * Eski 5 sn x 3 deneme yaklasik 15 sn icinde toparlanmayan isi kalici dusuruyordu
 * ve kapali oturumun ozeti bir daha uretilmiyordu. Ustel geri cekilme 30 sn, 1,
 * 2, 4, 8 dk bekler (toplam yaklasik 15 dk, 6 deneme).
 */
export const longRunningOptions: JobsOptions = {
  attempts: 6,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: 50,
  removeOnFail: 100,
};

/**
 * Yan etkili ve PARALI is (Mission Control ajan kosusu). Retry YOK: yarida
 * kalan bir kosu dosya yazmis, komut kosmus olabilir; otomatik tekrar hem
 * ikinci kez para harcar hem de yarim isin uzerine yazar. Yeniden deneme
 * karari panodan, insan tarafindan verilir. removeOnFail yuksek: basarisiz
 * kosunun izi teshis icin kalir.
 */
export const sideEffectfulOptions: JobsOptions = {
  attempts: 1,
  removeOnComplete: 50,
  removeOnFail: 200,
};

/**
 * Kuyruk → preset eslemesi. Yeni kuyruk eklerken buraya giris zorunlu;
 * eksik giris tip hatasidir (Record tum anahtarlari ister).
 */
export const QUEUE_JOB_OPTIONS: Record<QueueName, JobsOptions> = {
  [QueueName.MEMORY_INDEX]: longRunningOptions,
  [QueueName.MEMORY_MAINTENANCE]: sideEffectfulOptions,
  [QueueName.SESSION_SUMMARY]: longRunningOptions,
  [QueueName.AGENT_RUN]: sideEffectfulOptions,
};
