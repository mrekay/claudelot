# VoxStorm

Claude Code oturumlarını tek pencereden yöneten Windows masaüstü uygulaması.

> Resmi bir Anthropic ürünü değildir. Bilgisayarında kurulu [Claude Code](https://claude.com/claude-code) ile çalışır.

## Özellikler

- **Sekmeli terminaller:** Claude, PowerShell, Komut İstemi ve Git Bash yan yana
- **Projeler ve geçmiş:** Eski oturuma tıkla, kaldığın yerden devam et; kapanışta açık olanları geri yükle
- **Karar paneli:** İzin istekleri, plan onayları ve Claude'un soruları tek yerde
- **Bildirimler:** İş bitince, karar beklenince, alt ajan veya workflow açılıp kapanınca
- **Sistem tepsisi:** Kapatınca tepside çalışmaya devam eder, sadece tepsiden "Çık" ile kapanır
- **IDE modu:** Dosya ağacı, renkli düzenleyici, Markdown görünümü, "Claude'a sor"
- **Kullanım:** Haftalık ve aylık token, API fiyatıyla dolar karşılığı, CSV dışa aktarma
- **Oturum ayarları:** Varsayılan model, efor, izin modu, Remote Control
- **Kişiselleştirme:** Hitap, ton ve dil; üç tema; gizlenebilir paneller; kısayollar (F1)

## Kurulum

[Releases](../../releases) sayfasından indir:

- `VoxStorm-Setup-x.y.z.exe`: normal kurulum
- `VoxStorm-Portable-x.y.z.exe`: kurulumsuz, tek dosya

Gerekenler: Windows 10/11 ve PATH'te `claude` komutu (Claude Code). Git Bash isteğe bağlı.

Dosyalar imzasız olduğu için Windows ilk açılışta uyarı verebilir: **Ek bilgi → Yine de çalıştır**.

## Geliştirme

```
npm install
npm start        # uygulamayı çalıştır
npm run dist     # Setup ve Portable dosyalarını dist/ klasörüne derle
```

## Nasıl çalışır

- Claude oturumları, VoxStorm'un kendi hook ayarlarıyla (`--settings`) başlatılır. Hook'lar olayları uygulamanın yerel portuna gönderir; durumlar, bildirimler ve karar paneli buradan beslenir. `~/.claude/settings.json` ve `CLAUDE.md` dosyalarına dokunulmaz.
- Geçmiş oturumlar ve kullanım, `~/.claude/projects` altındaki oturum kayıtlarından okunur.
- Ayarlar, proje listesi ve günlük kullanım geçmişi `%APPDATA%\VoxStorm` klasöründe tutulur.

## Proje yapısı

| Dosya | Görevi |
|---|---|
| `src/main/main.js` | Pencere, tepsi, terminal süreçleri, hook dinleyicisi, geçmiş ve kullanım |
| `src/main/preload.js` | Arayüze açılan sınırlı API |
| `src/renderer/` | Ana pencere (`index.html`, `app.js`, `styles.css`) ve karşılama ekranı (`welcome.*`) |
| `scripts/make-icon.js` | Uygulama simgesini üretir |
