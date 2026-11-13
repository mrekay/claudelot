# VoxStorm eklentileri

Eklentiler VoxStorm'a yeni düğmeler, paneller, mod sekmeleri ve kısayollar ekler. Her eklenti yalıtılmış bir
çerçevede (sandbox iframe) çalışır: uygulamanın kendisine, Node.js'e ya da bilgisayarına doğrudan erişemez.
Yapabildiği her şey `vox` nesnesi üzerinden VoxStorm'a mesaj olarak gider ve kullanıcının onayladığı izinlerle
sınırlıdır.

En hızlı başlangıç: **Ayarlar → Eklentiler → Örnek eklenti oluştur**. "Hızlı Notlar" örneği bu rehberdeki her
şeyi kullanır; klasörünü açıp dosyaları değiştirebilir, **Yeniden yükle** ile hemen deneyebilirsin.

## Klasör yapısı

Eklentiler `%APPDATA%\VoxStorm\plugins\<id>\` altında durur. Klasör adı, manifest'teki `id` ile aynı olmalı.

```
plugins/
  hizli-notlar/
    manifest.json   zorunlu
    main.js         arka plan betiği (isteğe bağlı)
    notes.html      bir panelin sayfası
    notes.js
```

Başka bir yerde geliştirdiğin eklentiyi **Klasörden ekle** ile kopyalayabilirsin. Var olan bir eklentiyi aynı
yolla güncellersen eski kopya Geri Dönüşüm Kutusu'na gider ve eklenti yeniden onay ister.

## manifest.json

```json
{
  "id": "hizli-notlar",
  "name": "Hızlı Notlar",
  "version": "1.0.0",
  "description": "Kısa açıklama, ayarlarda görünür.",
  "author": "Adın",
  "icon": "fa-solid fa-note-sticky",
  "main": "main.js",
  "permissions": ["storage", "notify"]
}
```

| Alan | Açıklama |
| --- | --- |
| `id` | Küçük harf, rakam, `.`, `-`, `_`. En fazla 64 karakter. |
| `name`, `version`, `description`, `author` | Ayarlar listesinde gösterilir. |
| `icon` | Font Awesome 7 sınıfı (ör. `fa-solid fa-star`, `fa-regular fa-bell`). |
| `main` | Eklenti açılınca gizli bir sayfada çalışan betik. Düğme, panel ve komutları burada kaydet. |
| `permissions` | Aşağıdaki izinlerden ihtiyaç duyulanlar. |

### İzinler

Eklenti açılırken kullanıcıya bu liste gösterilir. Manifest'e yeni bir izin eklersen eklenti kapanır ve yeniden
onay ister.

| İzin | Ne sağlar |
| --- | --- |
| `storage` | `vox.storage`: eklentiye özel kalıcı depo (en fazla 1 MB, JSON). |
| `notify` | `vox.notify`: bildirim listesine ve Windows bildirimine yazma. |
| `fs.read` | `vox.fs.read / list / stat`: VoxStorm'a ekli projelerin içindeki dosyaları okuma. |
| `fs.write` | `vox.fs.write / mkdir`: aynı klasörlere yazma. |
| `shell` | `vox.shell.run`: bir proje klasöründe PowerShell komutu çalıştırma. Bu izin pratikte bilgisayarda her şeyi yapabilir. |
| `claude` | `vox.claude.newSession / send`: Claude oturumu başlatma, açık oturuma mesaj yazma. |
| `net` | `fetch`, `WebSocket` ve `https:` kaynaklı resim, yazı tipi, stil. İzin yoksa ağ kapalıdır. |

İzinsiz kullanılabilenler: düğme, panel, mod sekmesi, kısayol, `vox.ui.toast / confirm / prompt`,
`vox.app.state` ve olaylar.

## Sayfalar ve görünüm

Eklentinin her HTML sayfasına VoxStorm iki şey ekler, ayrıca bir şey yüklemen gerekmez:

- `vox` nesnesi (sayfanın kendi betiklerinden önce hazırdır),
- uygulamanın renkleri ve sade varsayılan stiller. Renkler CSS değişkeni olarak gelir ve tema değişince
  kendiliğinden güncellenir: `--bg`, `--surface`, `--surface-2`, `--hover`, `--line`, `--fg`, `--muted`,
  `--accent`, `--accent-soft`, `--on-accent`, `--warn`, `--warn-soft`, `--ok`, `--ok-soft`, `--danger`, `--font`,
  `--f-mono`. `button.primary`, `.card`, `.muted` hazır sınıflardır.

Font Awesome simgeleri için sayfana şunu ekle:

```html
<link rel="stylesheet" href="/__vox__/css/all.min.css">
<i class="fa-solid fa-rocket"></i>
```

Satır içi `<script>` ve `<style>` serbesttir. Sayfalar `localStorage`, açılır pencere ve üst pencereye erişim
olmadan çalışır; kalıcı veri için `vox.storage` kullan.

## API

Tüm çağrılar Promise döndürür. Hata, `Error` ile reddedilir (ör. izin yoksa).

### Başlangıç

```js
const info = await vox.ready;   // { id, name, version, permissions, theme, state, panel }
```

### Arayüz

```js
// place: 'drawer' sağdan açılan panel · 'mode' AI / IDE / DB yanında kendi sekmesi
//        'side'   AI modunda sağ sütunda, kararlar ile ajanlar arasında katlanabilir bölüm (height: piksel)
await vox.ui.addPanel({ id: 'notes', title: 'Notlar', icon: 'fa-solid fa-note-sticky', page: 'notes.html', place: 'drawer' });
await vox.ui.addPanel({ id: 'board', title: 'Pano', icon: 'fa-solid fa-table-cells-large', page: 'board.html', place: 'mode' });
await vox.ui.addPanel({ id: 'yayin', title: 'Yayın', icon: 'fa-solid fa-rocket', page: 'panel.html', place: 'side', height: 420 });
await vox.ui.openPanel('notes');
await vox.ui.closePanel('notes');

// üst çubuk ('titlebar') ya da durum çubuğu ('statusbar') düğmesi
await vox.ui.addButton({
  id: 'notes', place: 'titlebar', icon: 'fa-solid fa-note-sticky', label: '', title: 'Notlar',
  panel: 'notes',              // isteğe bağlı: tıklayınca bu paneli açar / kapatır
  onClick: () => { /* ... */ } // isteğe bağlı
});
await vox.ui.updateButton('notes', { label: '3', badge: '!' });
await vox.ui.removeButton('notes');

await vox.ui.toast('Başlık', 'Metin');
const ok = await vox.ui.confirm({ title: 'Emin misin?', message: '...', ok: 'Sil', danger: true });
const name = await vox.ui.prompt({ title: 'Ad', value: 'varsayılan' }); // vazgeçilirse null
```

### Komutlar ve kısayollar

```js
await vox.commands.register({ id: 'open', title: 'Notları aç', keys: 'Ctrl+Alt+K', run: () => vox.ui.openPanel('notes') });
```

Kısayol en az bir Ctrl / Alt içermeli ya da F1–F12 olmalı. Uygulamanın ya da başka bir eklentinin kullandığı bir
kısayol reddedilir. Kayıtlı kısayollar **Ayarlar → Kısayollar**'da eklentinin adıyla listelenir.

### Uygulama durumu ve olaylar

```js
const s = await vox.app.state();
// { mode, project: {id,name,path}, projects: [...], sessions: [{id, kind, title, status, projectId, sessionId, active}], pending }

vox.on('state', s => { /* oturum, proje ya da mod değişti */ });
vox.on('theme', t => { /* tema değişti; CSS değişkenleri zaten güncellendi */ });
vox.on('panel', p => { /* { id, visible } panel açıldı / kapandı */ });
vox.on('button', b => { /* { id } düğmeye tıklandı */ });
vox.on('command', c => { /* { id } kısayola basıldı */ });

await vox.app.setMode('ide');            // 'claude' | 'ide' | 'db'
await vox.app.openUrl('https://...');    // varsayılan tarayıcıda açar
```

Olaylar eklentinin bütün sayfalarına (arka plan ve paneller) gider.

### Depo (`storage`)

```js
await vox.storage.set('notes', [{ text: 'merhaba' }]);
const notes = await vox.storage.get('notes');   // yoksa null
await vox.storage.remove('notes');
const keys = await vox.storage.keys();
```

### Dosyalar (`fs.read`, `fs.write`)

Yalnızca VoxStorm'a ekli projelerin içindeki tam yollar kabul edilir.

```js
const text = await vox.fs.read('C:/Projeler/site/package.json');
const items = await vox.fs.list('C:/Projeler/site');          // [{ name, dir }]
const info = await vox.fs.stat('C:/Projeler/site/index.html'); // { size, dir, mtime }
await vox.fs.write('C:/Projeler/site/NOTES.md', '# Notlar');
await vox.fs.mkdir('C:/Projeler/site/docs');
```

### Komut çalıştırma (`shell`)

```js
const r = await vox.shell.run('git status --short', { cwd: 'C:/Projeler/site', timeout: 30000 });
// { code, stdout, stderr, error, stopped }

// uzun işler: çıktıyı geldikçe al
await vox.shell.run('& "C:\\Program Files\\Git\\bin\\bash.exe" ./deploy.sh; exit $LASTEXITCODE', {
  cwd: 'C:/Projeler/site', timeout: 30 * 60000,
  onOutput: (text, stream) => log.append(text),   // stream: 'stdout' | 'stderr'
});

await vox.shell.stop();   // bu eklentinin çalıştırdığı bütün komutları alt süreçleriyle birlikte durdurur
```

`cwd` verilmezse seçili proje kullanılır. Komut PowerShell'de çalışır; süre sınırı en fazla 1 saattir. Komutun
çıkış kodunu almak için sonuna `; exit $LASTEXITCODE` ekle. Bash betikleri için Git Bash'in tam yolunu kullan;
düz `bash` WSL'i açabilir. Komut etkileşimsiz çalışır: parola ya da onay bekleyen bir komut süre dolana kadar
bekler. Eklenti kapatılınca ya da yeniden yüklenince çalışan komutları durdurulur.

### Claude (`claude`)

```js
await vox.claude.newSession({ projectId, title: 'İnceleme', prompt: 'Bu projedeki TODO yorumlarını listele' });
await vox.claude.send('Testleri çalıştır');              // seçili Claude oturumuna yazar ve gönderir
await vox.claude.send('taslak', { submit: false });     // yalnızca yazar
```

### Bildirim (`notify`)

```js
await vox.notify('Derleme bitti', '0 hata');
```

### Hata ayıklama

Yakalanmayan hatalar ayarlardaki eklenti satırında görünür. `vox.log('mesaj')` ile kendi kaydını tutabilirsin.
Değişiklikten sonra **Yeniden yükle** yeterli; uygulamayı yeniden başlatman gerekmez.

## Güvenlik modeli

- Eklenti sayfaları `voxplugin://<id>/` adresinden, `sandbox="allow-scripts allow-forms"` ile yüklenir: kökeni
  boştur, üst pencereye, çerezlere, `localStorage`'a ve başka eklentilere erişemez; açılır pencere açamaz, üst
  pencereyi yönlendiremez, kendi çerçevesini `voxplugin://` dışına götüremez.
- Sayfalar sıkı bir CSP ile gelir; `net` izni yoksa ağ bağlantısı yoktur.
- Her çağrı geldiği çerçeveden eklentiye eşlenir ve izni kontrol edilir; dosya, komut ve depo istekleri ana
  süreçte bir kez daha kontrol edilir.
- Yeni bir izin istendiğinde ya da eklenti klasörden yeniden eklendiğinde eklenti kapanır ve onay ister.
