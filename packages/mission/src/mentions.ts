/**
 * Yorum govdesindeki @mention'lari cikarir.
 *
 * Ekip icindeki bildirim yolu budur: bir ajan "@nova bunu sen devral" yazdiginda
 * nova'nin bunu gormesi gerekir. Slug kurali ajan kaydiyla ayni olmak zorunda:
 * kucuk harf, rakam ve tire. Buyuk harfli yazim (@Nova) kucultulur — insan
 * konusurken buyuk harf kullanir, kayit kucuk harf tutar.
 *
 * Eposta adresi ve kod bloklari yanlis pozitif uretir; ikisi de kasten
 * disarida:
 *   - `a@b.com` → oncesinde kelime karakteri var, mention sayilmaz.
 *   - fiyat/etiket gibi `@2x` → slug harfle baslamak zorunda.
 */
const MENTION_PATTERN = /(^|[^\w@])@([a-z][a-z0-9-]{1,31})\b/gi;

export function extractMentions(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(MENTION_PATTERN)) {
    const slug = match[2];
    // Grup teorik olarak daima dolu; yine de kontrol edilir — non-null
    // iddiasi yerine gercek kontrol (ESLint bu iddiayi hata sayar ve haklidir:
    // desen degisirse iddia sessizce yanlis olur).
    if (slug) found.add(slug.toLowerCase());
  }
  return [...found];
}
