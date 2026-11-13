# VoxStorm eklentileri: çalışma notları

Bu klasör, çalışan VoxStorm uygulamasının eklenti klasörüdür: `{{PLUGINS_DIR}}`.
Burada yazdığın eklentiler ayrı bir proje, derleme ya da kurulum gerektirmeden doğrudan uygulamada çalışır.
Bu dosyayı VoxStorm oluşturur ve her "Claude ile eklenti yaz" oturumunda yeniden yazar; elle değiştirme.

## Nasıl çalışılır

- Her eklenti kendi alt klasöründedir: `<id>/manifest.json` + dosyaları. Klasör adı `id` ile birebir aynı olmalı.
- Yeni bir eklenti yazarken yeni bir alt klasör aç. Başka eklentilerin klasörlerine, istenmedikçe dokunma.
- **Hot reload:** Bir eklentinin klasöründe bir dosyayı kaydettiğin anda VoxStorm o eklentiyi yeniden yükler.
  Derleme adımı yok; düz HTML, CSS ve JavaScript yaz (paket yöneticisi, bundler, TypeScript yok).
- **Yeni eklenti onayı:** Yeni bir eklenti klasörü ilk kez göründüğünde VoxStorm kullanıcıya izinleri sorar.
  Manifest'e yeni bir izin eklersen eklenti kapanır ve yeniden onay ister. İzinleri ihtiyaç kadar tut.
- **Loglar:** Eklentinin yakalanmayan hataları ve `vox.log(...)` satırları `{{LOG_DIR}}\<id>.log` dosyasına
  yazılır. Bir şey çalışmıyorsa önce bu dosyayı oku. Kendi ayıklama satırlarını `vox.log` ile ekleyebilirsin.
- Eklenti sayfalarında `console.log` görünmez; `vox.log` kullan.
- Sayfalar yalıtılmış bir iframe'de çalışır: `localStorage`, `window.open`, üst pencereye erişim yoktur.
  Kalıcı veri için `vox.storage` (izin: `storage`), ağ için `net` izni gerekir.
- Arayüz Türkçe olsun; renkler için `var(--accent)`, `var(--surface)` gibi tema değişkenlerini kullan,
  simgeler için Font Awesome (`<link rel="stylesheet" href="/__vox__/css/all.min.css">`).
- Bir değişikliği bitirince kullanıcıya VoxStorm'da nereye bakacağını kısaca söyle
  (ör. "AI modunda sağ sütunda 'Yayın' bölümü", "üst çubuktaki roket düğmesi").

## Kontrol listesi

1. `manifest.json`: geçerli `id`, `name`, `main`, gereken `permissions`.
2. `main.js`: `await vox.ready;` sonra düğme / panel / komut kaydı.
3. Panel sayfaları: `vox.ready.then(...)` ile başla; olaylar için `vox.on('state' | 'panel' | ...)`.
4. Kaydet, ardından `{{LOG_DIR}}\<id>.log` dosyasında hata var mı bak.

Aşağıda eklenti API'sinin tam rehberi var.
