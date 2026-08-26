# multicli — Proje Kaydı (PROJECT.md)

> Tek terminal ortamında birden fazla AI CLI ajanını (Claude Code, Gemini CLI, Qwen, Codex...)
> yan yana çalıştıran, kotalarını/kullanımını canlı gösteren geliştirici aracı.

**Durum:** 🔄 Yeniden başlatıldı (26 Ağu 2026) — v1, "hiç düşündüğüm gibi gitmedi" denip
25 Ağu 2026'da terk edilmiş ve klasörü silinmişti (git remote yoktu, hiçbir kopyası kalmadı).
Bu, v1'in mimari notlarından yola çıkan **v2 / daha detaylı** girişim.
**Başlangıç:** 2026-08-26 · **Sahibi:** Murat

---

## 1. Vizyon / Amaç

$20 Claude Code limitinin projeleri kısıtlaması sorununa çözüm: plan/mimari işini Claude
üstlensin, ağır yürütmeyi ucuz/bol kotalı modellere (Qwen/MiniMax gibi OpenRouter üzerinden
erişilenler, Gemini, Codex) devretsin. Bunun pratik altyapısı olarak, **birden fazla AI CLI
ajanını aynı anda, kotalarını görerek** yönetebilecek bir araç.

Kök neden: [[feedback_cost_delegation]] — kullanıcı 1 Ağu 2026'da bunu net şekilde istemişti.

---

## 2. v1 — Eski Mimari (referans, kod yok/silindi)

Aşağıdaki notlar sadece **tarihsel referans**; kod artık mevcut değil, sıfırdan yazılacak.

**Ne yapıyordu:** Windows Terminal içinde tek pencerede birden fazla AI CLI ajanını
(claude, gemini, qwen, codex — `agents.json`'da tanımlı, `cmd.exe /c <ajan>` ile spawn)
yan yana panellerde çalıştıran, sağda 34 kolonluk canlı kullanım/limit paneli gösteren
Node.js masaüstü aracıydı.

**Bağımlılıklar:** `node-pty` (gerçek terminal spawn), `@xterm/headless` (her ajan için
sanal terminal buffer).

**Mimari:**
- `index.js` — pencereyi ajan sayısına göre bölüyor (sidebar + N panel), her panel kendi
  `node-pty` process'i + `xterm.Terminal(headless)` instance'ı
- `limits.js` — ağ isteği yapmadan, yerel log dosyalarını tarayarak (`walk()`, max derinlik 4)
  her ajanın kullanım/limit özetini çıkarıyor
- F1-F8 ile panel seçimi (Windows Terminal Alt+rakamı yuttuğu için)
- `multicli-admin.cmd` — yönetici izniyle Windows Terminal'de başlatan launcher (masaüstü
  kısayolu vardı)

**Gelişim sırası (git log, 6 commit):** temel çoklu-ajan+limit paneli → panel seçimi (F1-F8)
→ jcode çıkarıldı, qwen+codex eklendi, renkli kart tasarımlı panel → codex kuruldu, gemini
antigravity + qwen token kaynakları eklendi → gerçek Anthropic kota API entegrasyonu (5
saatlik/haftalık %kalan, reset zamanı, ek kredi) → launcher Windows Terminal kullanacak
şekilde güncellendi.

**v1'den çıkarılan dersler (v2'de dikkat edilecek):**
- Git remote hiç kurulmamıştı → v2'de erken bir noktada GitHub'a (private) taşınmalı,
  ayrıca gece yedeği [[project_drive_backup]] kapsamına girdiğinden emin olunmalı.
- "Hiç düşündüğüm gibi gitmedi" — memnuniyetsizliğin **tam sebebi not edilmemiş**. v2'ye
  başlarken kullanıcıya sorulmalı: UX mi, performans mı, panel mimarisi mi sorunluydu?

---

## 3. v2 — Yeni Mimari (detaylandırılıyor)

**Stack: Electron.** (K3 — bkz. §4) v1 zaten `node-pty` + `xterm.js` kullanıyordu, bu
büyük ölçüde taşınabilir. Claude Desktop de Electron — referans tema/his için iyi örnek.
Tauri değerlendirildi ama pty entegrasyonu + custom title bar için v1'in JS kodunun
neredeyse tamamen yeniden yazılması gerekirdi, vazgeçildi.

*(WezTerm kurulumu (bkz. günlük) ayrı bir amaç için kaldı — v2'nin kendi Electron
penceresi var, WezTerm'e bağımlı değil.)*

### 3.1 Pencere / Tema

Tek pencere, **frameless custom title bar**, Claude Desktop'a benzer koyu tema.

Üst bar (soldan sağa):
1. **Sol üst:** Uygulama menüsü (Dosya, Görünüm, vb. — klasik masaüstü uygulaması gibi)
2. **Menü kısayollarının biraz ilerisi, orta kısım:** canlı **kota/limit göstergeleri**
   ([[project_ai_limit_hq]] tarzı — renk kodlu barlar/gauge'lar, K5/renk spec'i oradan
   miras alınabilir: ≥80 mavi, 60-80 yeşil, 40-60 sarı, 20-40 turuncu, <20 kırmızı)
3. **En sağ:** pencere kontrolleri (minimize / maximize / close) — frameless olduğu için
   bunlar elle çizilecek (Electron'da native değil, custom render)

**Dosya menüsü → Projeler:** kullanıcı bir **proje klasörü** atayabiliyor. Atanan klasör,
o projeyle ilgili her şeyin (config, oturum geçmişi, loglar) saklandığı yer oluyor —
TripMate/M669 gibi projelerdeki "proje klasörü" alışkanlığının doğal karşılığı.

**Sağ kenar — Limit Dock'u:** ekranın en sağında, [[project_ai_limit_hq]] tarzı **küçük
bir kota takip paneli** (ikisi birden — üst bardaki özet göstergelerle birlikte yaşıyor,
sağdaki panel detaylı görünüm). Görünürlüğü **Görünüm menüsünden aç/kapa** edilebilir
(toggle). Genişliği sürüklenerek ayarlanabilir (bkz. §3.2 yeniden boyutlama).

### 3.2 Ana İçerik — Ajan Panelleri

- Ekran, ajanlar için **grid halinde panellere** bölünüyor: minimum dikey 3 bölme, büyük
  ekranlarda 6-8 pencereye kadar genişleyebiliyor.
- Her panel bir CLI ajanının (claude, gemini, qwen, codex...) **canlı çıktısını** gösterir
  — v1'deki gibi `node-pty` + `xterm.js` (headless/render) ile.
- **Önemli fark (v1'den):** her panelin kendi imleç/komut satırı YOK. Tek bir **global
  komut girişi** var — pencerenin **en altında, yatay, ortada, biraz geniş** bir input
  bar. Kullanıcı oraya yazıyor, girdi o an **aktif/seçili panele** gidiyor.
- **Aktif panel seçimi:** bir panele tıklanınca aktif olur. Aktif panelin çerçevesi
  **yeşil neon glow efekti** alır — [[project_ai_limit_hq]]'daki refresh butonunun
  etrafındaki glow ile aynı stil/his. Böylece kullanıcı hangi ajana yazdığını görsel
  olarak net anlıyor.
- **Klavye kısayolu:** panel değiştirme **Ctrl+1..8** (panel sırasına göre).
- **Yeniden boyutlama:**
  - Ajan panelleri arası bölücüler **sürüklenerek** boyutlandırılabilir (split-pane,
    VS Code terminal gibi).
  - Bir panele çift tıklayınca (veya bir buton/kısayolla) o panel geçici olarak **tüm
    alanı kaplar** (maximize/restore) — tek ajana odaklanmak için.
  - Sağdaki limit dock'unun genişliği de sürüklenerek ayarlanabilir.

### 3.3 Oturum Hafızası (Session Resume)

Uygulama, Claude Code'un `--continue`/`--resume` ile **son session'ları hatırlaması**
gibi davranmalı: pencere yeniden açıldığında (veya bir proje seçildiğinde) her panelin
son session'ı otomatik hatırlanabilsin/devam ettirilebilsin.

⚠️ **Açık soru:** Bu davranış CLI'dan CLI'ya değişir — Claude Code'un native resume
desteği var, ama gemini/qwen/codex CLI'larının kendi session/resume mekanizmaları farklı
(ya da yok) olabilir. Her ajan için ayrı ayrı araştırılıp `agents.json`'a resume
komutu/flag'i olarak eklenmesi gerekecek. **v2 kod aşamasına geçmeden önce netleşecek.**

### 3.4 Fizibilite Değerlendirmesi (26 Ağu 2026)

Genel olarak **yüksek fizibiliteli** bir tasarım; risk iki alanda toplanıyor:

- **Kolay/kanıtlanmış:** Electron+node-pty+xterm.js çoklu panel (Hyper.js emsali, v1'de
  zaten çalışmıştı), frameless custom title bar (VS Code/Discord emsali), tek global
  input→aktif panele `pty.write()` (N ayrı input'tan daha basit), yeşil neon glow (saf
  CSS), Ctrl+1..8 kısayolları, split-pane resize, maximize/restore — hepsi standart,
  düşük risk.
- **Orta risk — kota gösterimi:** Claude için v1'in yolu (yerel log + gerçek Anthropic
  API) kanıtlanmış. gemini/qwen/codex CLI'larının quota'ya CLI içinden erişimi standart
  değil; bazı ajanlar için gerçek "%kalan" yerine sadece "bu session'da yakılan token"
  gösterilebilir — hepsi için eşit kalitede veri garanti edilemez.
- **Orta risk — session resume:** Claude Code'un `--continue`/`--resume`'u net; diğer
  CLI'ların resume mekanizması farklı/belirsiz, her biri ayrı araştırılıp `agents.json`
  adaptörüne eklenmesi gerekecek (biri desteklemiyorsa o ajan için "resume yok" denip
  geçilecek).
- **Kaynak notu:** 6-8 ajanı aynı anda ayakta tutmak = 6-8 ayrı (bazıları ağır) Node
  process'i aynı anda RAM'de. [[project_nexus_core]]'da AIO'nun zaten RAM baskısı
  yaşadığı not edilmiş — bu makinede/NexusCore'da çalıştırılacaksa 6-8 hedefiyle değil,
  3-4 panelle başlayıp genişletmek daha güvenli.

### 3.5 Kalan Açık Kararlar

- Kota/limit verisi her ajan için nereden okunacak — Claude için v1'in `limits.js`
  yaklaşımı (yerel log tarama) + gerçek Anthropic API var; diğer ajanlar için kaynak
  henüz belirlenmedi.
- Her CLI için session resume komutu/flag'i araştırılacak (bkz. §3.3, §3.4).

---

## 4. Kararlar Günlüğü (neden böyle)

| # | Karar | Gerekçe |
|---|-------|---------|
| K1 | v1'in kodu kurtarılamaz, sıfırdan yazılacak | Klasör silindi, remote yoktu |
| K2 | v2 önce mimari tasarımı, sonra kod | Kullanıcı "daha detaylı" istedi — aceleye getirmemek için |
| K3 | Stack: **Electron** (Tauri değil) | v1 zaten node-pty+xterm.js kullanıyordu (taşınabilir), Claude Desktop de Electron (tema referansı), Tauri'de pty+custom title bar için sıfırdan yazım gerekirdi |
| K4 | ~~Tek global komut girişi~~ **SÜPÜRÜLDÜ (26 Ağu 2026)** — her panel kendi başına doğrudan yazılabilir | Denendi, kullanıcı gereksiz/anlamsız buldu ("her pencereye direkt yazabiliyorum, alt input işlevsiz kaldı") — normal bir terminal çoklayıcısı (tmux/VS Code) gibi tıkla-yaz daha doğal. `term.onData()` pty'ye yazıyor, xterm kendi tuş kodlamasını yapıyor (elle yazılmış `keyToSequence()` kaldırıldı) |
| K5 | Aktif panel vurgusu: yeşil neon glow çerçeve | [[project_ai_limit_hq]]'daki refresh butonu glow efektiyle görsel tutarlılık |
| K6 | Dosya menüsü → Projeler: proje klasörü atama | Her projenin config/session/log'u kendi klasöründe yaşasın (TripMate/M669 alışkanlığıyla tutarlı) |
| K7 | Kota gösterimi **ikisi birden**: üst bar özet + sağ dock detay | Üst bar sade kalır ama tek bakışta özet verir; sağ dock ([[project_ai_limit_hq]] tarzı) isteyince detaya inilir. Görünüm menüsünden aç/kapa |
| K8 | Panel değiştirme kısayolu: **Ctrl+1..8**; ajan listesi v1 ile aynı (claude/gemini/qwen/codex) | Kendi Electron penceremiz olduğu için serbestçe atanabildi; ajan listesini değiştirmeye gerek görülmedi |
| K9 | Paketleme: **electron-builder ile küçük NSIS kurulumu** (setup.exe), portable tek-exe değil | Kullanıcı tercihi: Program Files + Başlat Menüsü kısayolu + düzgün uninstaller — Claude Desktop'un dağıtım şekliyle aynı his. Config zaten `app.getPath('userData')` (%APPDATA%) kullanıyor, bu karardan bağımsız |
| K10 | Panel-içi klavye kısayolları `attachCustomKeyEventHandler` ile panel bazında yakalanıyor (Ctrl+1..8 panel değiştir, PageUp/PageDown/Ctrl+Home/Ctrl+End scrollback) | K4 terkedilince "genel pencere" seviyesinde tutulan kısayolların artık odaklı panelin kendi handler'ında yakalanması gerekti; xterm'in resmi API'si, hacky window-level guard'lardan daha sağlam |
| K11 | **Arayüz dili sistem diline göre otomatik** (tr/en, `navigator.language`) | Kullanıcı "Windows/Linux ne kullanıyorsa o dilde gelsin" dedi; `STRINGS` sözlüğü + `applyStaticI18n()` ile tüm menü/etiket/sistem mesajları kapsandı — yeni bir dil eklemek `STRINGS`'e üçüncü bir blok eklemek kadar basit |

---

## 5. Günlük (Oturum Kayıtları)

### 2026-08-26
- v1'in terk edildiği doğrulandı (bkz. [[project_multicli]] hafıza notu), kullanıcı v2
  için "buna benzer ama daha detaylı" bir şey istedi.
- `C:\Users\murat\Projects\multicli` klasörü yeniden açıldı, bu PROJECT.md ve CLAUDE.md
  oluşturuldu.
- Aynı oturumda WezTerm kuruldu (multicli'den bağımsız bir amaç için — §3'te not edildi).
- v2 mimarisi detaylandırıldı: **Electron** exe, frameless custom title bar (sol üst
  menü, orta kota göstergeleri [[project_ai_limit_hq]] tarzı, sağ pencere kontrolleri),
  Dosya→Projeler ile proje klasörü atama, ana alanda 3-8 arası ajan paneli (grid), tek
  global komut girişi (alt/yatay/orta) aktif panele yazıyor, aktif panel **yeşil neon
  glow** çerçeveyle vurgulanıyor, session resume (Claude Code `--continue` benzeri)
  hedefleniyor. Detay: PROJECT.md §3.
- Panel değiştirme kısayolu **Ctrl+1..8**, ajan listesi v1 ile aynı (claude/gemini/qwen/
  codex) olarak netleşti (K8). Kota gösterimi hem üst bar özet hem sağ dock detay olacak
  (K7), sağ dock Görünüm menüsünden aç/kapa. Ajan panelleri arası split-pane resize +
  çift tıkla maximize/restore eklendi (§3.2).
- Fizibilite değerlendirmesi yapıldı (§3.4): genel tasarım düşük riskli, asıl belirsizlik
  ajan-başı kota verisi ve session resume desteği; ayrıca 6-8 panel hedefi RAM açısından
  iddialı olabilir ([[project_nexus_core]] emsali), 3-4 ile başlanması önerildi.
- **Sıradaki adım:** §3.5'teki açık kararları netleştirmek (kota kaynakları, resume
  komutları), sonra kod/iskelet aşamasına geçmek.
- **İlk çalışan MVP kodlandı ve doğrulandı.** `npm init` + Electron 44/node-pty 1.1.0/
  @xterm/xterm 6 kuruldu — node-pty N-API tabanlı olduğu için Windows prebuild'i
  doğrudan çalıştı, `@electron/rebuild` (Python eksikliği yüzünden başarısız oldu)
  gerekmedi, kaldırılabilir. Uygulanan/doğrulanan özellikler:
  - Frameless pencere, custom title bar (Dosya/Ajanlar/Görünüm menüleri + mini kota
    göstergeleri + pencere kontrolleri) — ekran görüntüsüyle doğrulandı.
  - **2D grid panel düzeni** (satır+sütun, `layoutIds`) — ilk sürüm tek satırdı, kullanıcı
    "dikeyde boyutlandıramadım" dedi, satır-arası `resizer-row` (row-resize) eklendi;
    artık hem yatay hem dikey sürükle-boyutlandır çalışıyor.
  - **"Ajanlar" menüsü ile isteğe bağlı panel başlatma** — açılışta otomatik panel YOK,
    kullanıcı hangi ajanı istiyorsa menüden başlatıyor; panel başlığı ajan adı (+ açık
    proje varsa "Proje - Ajan") oluyor. `agents.json`'a `command` alanı eklendi (claude/
    gemini/qwen/codex) — panel açılınca 200ms sonra otomatik o komut yazılıyor.
  - **Panel ekleme artık yıkıcı değil**: `rebuildGridLayout()` var olan xterm/pty
    nesnelerini yeniden kullanıyor (DOM'da taşıyor), sadece yeni panel için yeni xterm
    oluşturuyor — önceki "her ekleme tüm grid'i sıfırdan kurar" tasarımı (session/
    scrollback kaybına yol açardı) terk edildi.
  - **Panel kapatma** (✕ butonu) eklendi — pty kill + xterm dispose + grid yeniden
    düzenleniyor.
  - **Proje sistemi yeniden tasarlandı** (kullanıcı: "her iç pencere için ayrı proje
    ataması olabilmeli" + "dosyada proje aç/kapat/konum ekle lazım"):
    - Dosya menüsü artık çoklu **kayıtlı proje listesi** (`projects: [{name,path}]`,
      `%APPDATA%\multicli-config.json`'da persist), "Proje Ekle…" ile eklenir, tıklayınca
      "açılır" (✓ işaretli), "✕" ile listeden silinir, "Projeyi Kapat" açık projeyi
      temizler.
    - Yeni panel, o an **açık olan projeyi** cwd olarak alır (otomatik, dialog açmadan).
    - Her panelin başlığındaki **📁 butonu** o TEK paneli farklı bir projeye (kayıtlı
      listeden veya "Gözat" ile yeni bir klasöre) yeniden atayabiliyor — panelin pty'si
      kill+respawn ediliyor, xterm'e sarı bir "proje değiştirildi" notu yazılıyor.
  - Paketleme kararı netleşti: **electron-builder + NSIS küçük kurulum** (K9) — portable
    tek exe değil, Program Files + Başlat Menüsü kısayolu + uninstaller; config zaten
    `app.getPath('userData')` kullandığı için bu karardan etkilenmiyor. Henüz kurulmadı,
    MVP arayüzü stabilleşince yapılacak.
  - Git repo başlatıldı (`git init`) — v1'in remote'suz kalma hatası (K1) tekrarlanmasın
    diye erken adım; henüz remote eklenmedi/commit atılmadı.
  - Ekran görüntüsüyle doğrulama yapıldı: menüler, yeşil glow, kota dock'u, panel
    başlığı butonları hepsi görsel olarak çalışıyor. `[process exited: 1]` kullanıcının
    kendi testiydi (panelde `exit` yazmış) — bug değil, çözüldü.
  - **Varsayılan Konum** eklendi (Dosya menüsü): proje atanmamış panellerin cwd fallback'i
    artık `USERPROFILE` değil, kullanıcının seçtiği bir klasör; ilk açılışta bir kerelik
    soruluyor, istenirse sonradan değiştirilebiliyor.
  - **Paneller salt-okunur yapıldı** (xterm `disableStdin: true`) — kullanıcı doğrudan bir
    panele tıklayıp yazabildiğini fark etti, bu K4'ü (tek global input) bozuyordu.
    Bununla birlikte xterm'in dahili PageUp/PageDown scrollback kısayolları da kapandığı
    için alt komut çubuğuna elle yeniden bağlandı (PageUp/PageDown/Ctrl+Home/Ctrl+End,
    saf istemci-taraflı `term.scrollPages()` — pty'ye hiç gitmiyor).
  - **Panel rengi ajan bazlı** (Görünüm menüsü) — kullanıcı "Claude turuncu, Qwen mor"
    gibi ayrı ayrı istedi; ilk sürüm yanlışlıkla tek global renkti, düzeltildi. Renk artık
    `--glow`/`--glow-dim` custom property'leri her panelin KENDİ DOM elementine inline
    yazılıyor (global `:root`'a değil), varsayılanlar: claude=turuncu, gemini=turkuaz,
    qwen=mor, codex=yeşil; `%APPDATA%`'da agentId->renk olarak persist ediliyor.
  - ANSI renk/arkaplan desteği (git diff yeşil/kırmızı vb.) sorgulandı — ekstra iş
    gerekmiyor, xterm.js + gerçek PTY (`name:'xterm-color'`) zaten tam destekliyor.
  - **K4 tersine çevrildi**: kullanıcı test edince tek-global-input'u anlamsız buldu,
    doğrudan panel-içi yazıma dönüldü (bkz. K4, K10). Alt komut çubuğu HTML/CSS/JS'den
    tamamen kaldırıldı.
  - **Panel başlığına renk butonu eklendi** (📁/✕'in yanına) — Görünüm menüsüne gitmeden,
    o panelin ajan rengini doğrudan panelden değiştirebiliyorsun; ikisi aynı state'i
    (`agentColors`) paylaşıyor, biri değişince öbürü de senkron güncelleniyor.
  - **i18n eklendi** (K11): tüm menüler/etiketler/sistem mesajları artık `STRINGS.tr`/
    `STRINGS.en` sözlüğünden geliyor, `navigator.language`'a göre otomatik seçiliyor.
