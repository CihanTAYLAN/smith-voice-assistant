import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

/**
 * Prisma 7 driver-adapter kurulumu (pg Pool uzerinden).
 *
 * DATABASE_URL uygulama rolune (smith_app) baglanir; bu rol RLS'e tabidir
 * ve BYPASSRLS tasimaz. Migration'lar ayri (superuser) URL ile kosulur.
 */
export interface DbHandle {
  readonly prisma: PrismaClient;
  readonly pool: Pool;
  close(): Promise<void>;
}

export function createDb(databaseUrl: string): DbHandle {
  /*
   * HAVUZ AYARLARI ACIK YAZILIR (2026-08-21'de OLCULEREK eklendi).
   *
   * Once varsayilanlar kullaniliyordu ve iki tanesi sahada ariza uretti.
   * Belirti: gateway ayakta, /v1/health 200, ama her DB'ye dokunan istek
   * `PrismaClientKnownRequestError P2028 - Unable to start a transaction in the
   * given time`. Kok neden uygulamada DEGILDI (Docker Desktop'in yayimlanan
   * port yonlendirmesi TCP el sikismasini kabul edip iletmiyordu), ama
   * varsayilanlar arizayi TESHIS EDILEMEZ hale getiriyordu:
   *
   *  - `connectionTimeoutMillis: 0` (varsayilan) = SONSUZA KADAR BEKLE. Olculdu:
   *    tek bir soguk baglanti 641 saniye askida kaldi ve sonra basarili oldu.
   *    Bu sirada Prisma'nin 2 sn'lik transaction bekleme suresi doluyor ve
   *    kullaniciya ilgisiz bir "transaction" hatasi gidiyor. Artik 5 sn'de
   *    baglanti hatasi doner: sebep ne ise O gorunur.
   *  - `idleTimeoutMillis: 10_000` (varsayilan) = 10 sn sessizlikten sonra TUM
   *    baglantilar kapanir; sesli asistanda konusma araliklari bundan uzun
   *    oldugu icin neredeyse HER istek soguk baglanti odedi (sicak sorgu 9 ms,
   *    soguk 34 ms - normalde ucuz, proxy takildiginda felaket). 60 sn'ye
   *    cikarildi.
   *  - `keepAlive` acildi: bosta duran soket, aradaki proxy tarafindan sessizce
   *    dusurulmesin.
   */
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 60_000,
    keepAlive: true,
  });

  /*
   * Bosta duran bir istemcinin hatasi (or. sunucu baglantiyi kapatti) `pool`
   * uzerinde 'error' olarak yayilir ve DINLEYICI YOKSA Node sureci COKER.
   * Bu, "gateway sebepsiz oldu" sinifinda bir arizadir; burada yakalanip
   * loglanir. Havuz kendi kendini toparlar, bir sonraki istek yeni baglanti alir.
   */
  pool.on('error', (error) => {
    process.stderr.write(`[db] bosta baglanti hatasi (havuz toparlanir): ${error.message}
`);
  });

  const adapter = new PrismaPg(pool);
  /*
   * `maxWait` HAVUZUN connectionTimeoutMillis'INDEN BUYUK OLMALI (olculdu).
   *
   * Varsayilan maxWait 2 sn'dir ve havuzun 5 sn'lik baglanti kapisindan ONCE
   * doluyordu; sonuc, sebebi ORTMEN bir hata mesajiydi: gerceklik "Postgres'e
   * baglanamiyorum" iken kullanici `P2028 - Unable to start a transaction in
   * the given time` goruyordu ve teshis transaction katmaninda araniyordu.
   * Bu sira ile artik once baglanti hatasi doner:
   * "Connection terminated due to connection timeout" — yani hangi katmanin
   * bozuk oldugu mesajin KENDISINDE yazar.
   *
   * `timeout` (transaction'in kendi suresi) 15 sn: kapsamli tx'ler icinde
   * embedding/LLM cagrisi YOK, en uzun is pgvector aramasi.
   */
  const prisma = new PrismaClient({
    adapter,
    transactionOptions: { maxWait: 8_000, timeout: 15_000 },
  });

  return {
    prisma,
    pool,
    async close() {
      await prisma.$disconnect();
      await pool.end();
    },
  };
}
