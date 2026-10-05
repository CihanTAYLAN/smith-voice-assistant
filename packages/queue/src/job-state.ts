/**
 * Bu kuyruk isi hala islenecek ya da isleniyor mu?
 *
 * Kosu uzlastirmasi (gateway periyodik taramasi, worker acilis taramasi) "lease'i
 * dolmus `running` kosuyu sonlandirabilir miyim" sorusunu buna dayandirir:
 * kuyrukta canli is varsa ya baska worker kosuyor ya da kuyruk isi yeniden
 * teslim edecek ve `claimRun` ayni mantikla sonlandiracak, dokunulmaz. `failed`,
 * `completed` ve kaydi olmayan is (temizlenmis ya da Redis sifirlanmis) kosuyu
 * bir daha ustlenmez: tek sonlandirma sansi uzlastiricidir.
 *
 * BullMQ durumlari kuyruk paketinin bilgisidir; tuketiciler bu listeyi
 * kendileri yazmaz.
 */
const LIVE_JOB_STATES: ReadonlySet<string> = new Set([
  'active',
  'waiting',
  'delayed',
  'prioritized',
  'waiting-children',
]);

export async function hasLiveJob(
  queue: { getJob(jobId: string): Promise<{ getState(): Promise<string> } | undefined> },
  jobId: string,
): Promise<boolean> {
  const job = await queue.getJob(jobId);
  if (!job) return false;
  return LIVE_JOB_STATES.has(await job.getState());
}
