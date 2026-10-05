/**
 * REFRESH ROTASYONU TOLERANSI. Kayip yanit veya paralel istek yuzunden ayni
 * eski refresh token REFRESH_ROTATION_GRACE_MS icinde tekrar gelirse, rotasyonu
 * yeniden kosmak (bu, yeniden kullanim sanilip aileyi iptal ederdi) yerine ilk
 * yanit birebir tekrarlanir. Sure dolduktan sonra ayni token = calinti sinyali =
 * aile iptali.
 *
 * Ham refresh token DB'de tutulmaz (yalniz hash'i), bu yuzden tekrarlanacak
 * yanit bellekte durur: tek surec, yeniden baslatma toleransi sifirlar. Kayit
 * sure bitince zamanlayiciyla silinir.
 */

export const REFRESH_ROTATION_GRACE_MS = 30_000;
export const REFRESH_REPLAY_MAX_ENTRIES = 1_000;

export interface RefreshReplay {
  family: string;
  /** Yeni token'in hash'i; tekrar dagitilmadan once hala aktif mi diye bakilir. */
  replacementHash: string;
  /** Ilk yanit govdesi. */
  body: { accessToken: string; refreshToken: string };
}

export interface RefreshReplayCache {
  recall(tokenHash: string): RefreshReplay | undefined;
  remember(tokenHash: string, replay: RefreshReplay): void;
  forgetFamily(family: string): void;
}

interface Entry {
  replay: RefreshReplay;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export function createRefreshReplayCache(now: () => number = Date.now): RefreshReplayCache {
  /** Map ekleme sirasi en eski -> en yeni. */
  const entries = new Map<string, Entry>();

  const forget = (tokenHash: string): void => {
    const entry = entries.get(tokenHash);
    if (!entry) return;
    clearTimeout(entry.timer);
    entries.delete(tokenHash);
  };

  return {
    recall(tokenHash) {
      const entry = entries.get(tokenHash);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        forget(tokenHash);
        return undefined;
      }
      return entry.replay;
    },

    remember(tokenHash, replay) {
      forget(tokenHash);
      if (entries.size >= REFRESH_REPLAY_MAX_ENTRIES) {
        const oldest = entries.keys().next();
        if (!oldest.done) forget(oldest.value);
      }
      const timer = setTimeout(() => forget(tokenHash), REFRESH_ROTATION_GRACE_MS);
      timer.unref();
      entries.set(tokenHash, { replay, expiresAt: now() + REFRESH_ROTATION_GRACE_MS, timer });
    },

    forgetFamily(family) {
      for (const [tokenHash, entry] of entries) {
        if (entry.replay.family === family) forget(tokenHash);
      }
    },
  };
}
