# ADR 0012 — Kendi geliştirme döngüsü ve kanıtlı teslim

**Tarih:** 2026-09-06
**Durum:** Uygulandı; 2026-09-06 gerçek model kabul koşusu ve yerel kontroller geçti.

## Hedef

Cihan'ın verdiği geliştirme görevini Smith'in kendi deposunda uygulamak;
çalışan checkout'u koruyarak ayrı çalışma ağacında değişiklik üretmek,
bağımsız doğrulamak ve incelenebilir diff ile teslim etmek. Sonraki aşamada
Cihan bu yeteneği baska bir projeye entegre edecek; bu ADR henüz bilinmeyen
buzz.xyz API'si veya erişimi hakkında varsayım yapmaz.

## Mevcut zemin ve karar

Desktop `code_agent.rs`, `kod_gorevi_ver` üzerinden Claude Code'a ayrı Git
worktree'de dosya düzenletiyor. Mission Control ayrıca WSL executor taşıyor.
İkinci bir görev sistemi kurmak yerine kendi geliştirme işi mevcut desktop
girişinde tamamlanır. Worker'ın hata çıkışını başarılı sayabilen sonuç
yorumlaması da düzeltilir; worker'a ayrı bir kendi geliştirme motoru eklenmez.

Git worktree kullanıcı değişikliklerini ayrı tutar; işletim sistemi sandbox'ı
değildir. Dosya aracı izinleri de tek başına süreç izolasyonu değildir.
Bu akış cihaz sahibinin yetkisiyle çalışan cihaz aracıdır. Sunucuda araç
çalıştırma yasağı ve Scope/RLS sözleşmesi değişmez.

## Teslim sözleşmesi

1. Her koşunun benzersiz kimliği, sabit base commit'i ve repo dışında
   kalıcı kayıt dizini olur. Ana checkout'un dirty dosyaları taşınmaz.
2. İstem, ajan çıktısı, diff ve doğrulama kanıtı candidate worktree dışında
   tutulur. Başarısızlık ve timeout da kaydedilmiş sonuçtur.
3. Ajanın özeti başarı kanıtı sayılmaz. Gerçek exit kodu, timeout ve
   yapılandırılmış sonuç birlikte değerlendirilir. İnsan tarafından düzeltilen
   aday ayrıca yeniden doğrulanabilir; `manual_reverify` önceki ajan hatasını
   silmez ve modelin başarılı çalıştığı anlamına gelmez.
4. Git kanıtı tracked, staged, deleted ve yeni dosyaları içerir. Git hatası
   boş diff gibi gösterilmez. Kullanıcının index'i değiştirilmez.
5. Kontroller harness tarafından başlatılır, gerçek komut ve exit sonucu
   kaydedilir. Kabul mekanizmasını değiştiren candidate otomatik doğrulanmış
   sayılmaz. Bağımlılık/ortam engeli açıkça raporlanır.
6. Sonuç `review` için hazırlanır; commit, push, merge ve deploy otomatik
   yapılmaz. Başarılı test, görevin ürün kabulünün tamamı değildir.
7. Kaydı okuyan giriş bir koşuyu yeniden çalıştırmaz. Kimlik, durum, artefakt
   ve kalan iş yeni oturumdan bulunabilir. Dış entegrasyon bu yapılandırılmış
   sonucu kullanabilir; yerel yollar sunucuda kendiliğinden erişilebilir sayılmaz.

## Kabul kanıtı

- Gerçek geçici Git reposunda dirty kaynak korunur; yeni dosya patch'e girer.
- Aynı başlıklı iki görev çakışmaz; boş görev çalışmaz.
- Nonzero exit, signal, timeout, boş/bozuk rapor başarılı sayılmaz.
- Başarısız kontrol `verified` üretemez; kontrol değişikliği görünürdür.
- Kayıt ve artefaktlar yeniden okunabilir; eksik/bozuk kayıt açık hata verir.
- Küçük bir gerçek görev bu akıştan geçirilir; diff ve doğrulama kanıtı
  incelenir. Canlı sağlayıcı erişimi yoksa bu koşul açık kalır.
- `pnpm verify` ve ilgili Rust testleri geçer; ortam kısıtı varsa komut,
  neden ve doğrulanamayan koşul yazılır.

## Sonraki ayrı aşamalar

Kullanım hatalarından değerlendirme vakaları üretme, model karşılaştırması,
iyileştirme önerilerinin otomatik seçimi ve buzz.xyz bağlantısı bu temel
döngü üzerinde geliştirilir. Sistem kendi yetki veya kabul ölçütlerini
kendiliğinden genişletemez.
