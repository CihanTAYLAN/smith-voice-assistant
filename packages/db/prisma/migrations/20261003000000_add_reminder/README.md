# Reminder migration ve elle geri alma

Bu migration henüz uygulanmadı. `down.sql` yalnız elle çalıştırılacak geri alma
SQL'idir; Prisma `migrate deploy` bu dosyayı **otomatik çalıştırmaz**.
Grant, policy, RLS, foreign key, indeks ve tablo oluşturmanın ters sırasıyla
kaldırılır. Tablo silindiğinde tüm hatırlatma verisi kaybolur.

Geri alma öncesinde hatırlatma tüketicilerini/gateway yazmalarını durdurun,
`Reminder` verisinin yedeğini alın ve geri yüklenebilirliğini doğrulayın.
Migration sahibi yetkisi ve hedef veritabanı ayrıca doğrulanmalıdır.
Komutlar repo kökünden, güvenli ortamda tanımlı `MIGRATE_DATABASE_URL` ile
çalıştırılır; bağlantı değerini terminale yazdırmayın.

Başarısız migration için önce hangi DDL adımlarının gerçekten uygulandığını
inceleyin. `down.sql` tam oluşturulmuş tabloyu varsayar ve eksik nesnede
transaction'ı geri alır; kısmi uygulanmada yalnız gerçekten oluşan nesnelere
uygun bir SQL kopyasını inceleyip kullanın.

```sh
pnpm --filter @smith/db exec prisma db execute --file prisma/migrations/20261003000000_add_reminder/down.sql
pnpm --filter @smith/db exec prisma migrate resolve --rolled-back 20261003000000_add_reminder
```

`migrate resolve --rolled-back` yalnız **başarısız** migration içindir.
Başarıyla uygulanmış migration'ı geri almak için Reminder modelini ve ters
ilişkilerini şemadan kaldırın, geliştirme ortamında yeni forward migration
oluşturun ve `down.sql` içeriğini bu yeni migration'ın incelenecek SQL'i olarak
kullanın. Eski migration'ı değiştirmeyin/silmeyin. Yeni migration normal
dağıtım akışında uygulanır; böylece Prisma geçmişi ile şema tutarlı kalır.
Doğrudan `db execute` şemayı değiştirir, başarılı migration geçmişini geri almaz.

Kaynak: [Prisma v7 down migration rehberi](https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/generating-down-migrations).

Bu çalışma kapsamında hiçbir komut veritabanına karşı çalıştırılmadı.
