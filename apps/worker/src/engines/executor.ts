/**
 * TEK EXECUTOR KAPISI (ADR 0007 §4).
 *
 * Kapi neden paylasilir: her motor icin ayri bir anahtar olsaydi "biri acik
 * biri kapali" gibi teshis edilmesi zor bir durum dogardi ve panoda yarim
 * calisan bir is gucu gorunurdu. Tek anahtar = tek gercek.
 *
 * Varsayilan KAPALI. Motor gercek is yapar (dosya, komut, para/kota); acmak
 * bilincli bir operator kararidir.
 */
export function isMissionExecutorEnabled(): boolean {
  return process.env.SMITH_MISSION_EXECUTOR === '1';
}
