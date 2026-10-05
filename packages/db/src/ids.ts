import { randomUUID } from 'node:crypto';

/**
 * Onekli kimlik ureteci. UUID'nin tiresiz hex hali [0-9a-f]{32} oldugu icin
 * @smith/tenancy ve @smith/protocol'un [0-9a-z]{20,32} desenlerine uyar.
 */
function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

export const newWorkspaceId = (): string => newId('ws');
export const newActorId = (): string => newId('act');
export const newSessionId = (): string => newId('ses');
export const newMessageId = (): string => newId('msg');
export const newRefreshTokenId = (): string => newId('rtk');
export const newDevicePairingId = (): string => newId('dvp');
/** Device-locus tool cagrisi frame kimligi (protokol: `tc_[0-9a-z]{20,32}`). */
export const newToolCallId = (): string => newId('tc');
/** Kayitli cihaz (device registry, Faz 3). */
export const newDeviceId = (): string => newId('dev');
export const newMemoryId = (): string => newId('mem');
export const newMemoryGapId = (): string => newId('gap');
export const newReminderId = (): string => newId('rem');

// Mission Control (ADR 0007)
export const newAgentId = (): string => newId('agt');
export const newTaskId = (): string => newId('tsk');
export const newTaskCommentId = (): string => newId('tcm');
export const newTaskEventId = (): string => newId('tev');
export const newAgentRunId = (): string => newId('run');
