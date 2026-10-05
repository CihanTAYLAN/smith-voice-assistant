/**
 * Kosunun YEREL yapilabildigi cihazlar.
 *
 * Bu surumde motor yalniz worker makinesinde kosar: Windows'un kendisi ve onun
 * WSL'i. `m2` (MacBook) ve `server` (uzak sunucu) icin SSH ile kosu Faz 2'dir
 * (ADR 0007, "Kalan is"). O zamana kadar bu cihazlardaki ajana atama reddedilir
 * ve worker o cihazlarin kosusunu yerelde calistirmaz: yanlis makinede dosya
 * degistirip panoda baska makinede kosmus gibi gostermek yerine acik hata.
 *
 * Tek kaynak burasidir: atama kapisi (`assignTask`) ve worker korumasi ayni
 * listeyi kullanir, elle yazilan iki liste zamanla ayrisirdi.
 */
export const LOCAL_AGENT_DEVICES = ['wsl', 'windows'] as const;
export type LocalAgentDevice = (typeof LOCAL_AGENT_DEVICES)[number];

export function isLocalAgentDevice(value: string): value is LocalAgentDevice {
  return (LOCAL_AGENT_DEVICES as readonly string[]).includes(value);
}
