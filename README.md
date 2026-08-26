# multicli

Tek pencerede birden fazla AI CLI ajanını (Claude, Gemini, Qwen, Codex...) yan yana,
gerçek terminal panelleri olarak çalıştıran bir Electron masaüstü uygulaması.

![multicli screenshot](.github/screenshot.png)

## Özellikler

- **Doğrudan yazılabilir panel grid'i** — her panel gerçek bir `node-pty` + `xterm.js`
  terminali; tıkla ve normal bir terminal gibi yaz. Ctrl+1..8 ile panel değiştir,
  PageUp/PageDown/Ctrl+Home/Ctrl+End ile geçmişte gezin.
- **2D grid, hem yatay hem dikey sürükle-boyutlandır**, çift tık ile tam ekran/geri al.
- **Panel başına proje klasörü** — her pencere kendi çalışma dizinini seçebilir; Dosya
  menüsünden birden fazla proje kaydedip hızlıca aralarında geçiş yapılabilir.
- **Ajan başına renk** — Claude turuncu, Gemini turkuaz, Qwen mor, Codex yeşil (veya
  Görünüm menüsünden istediğin gibi değiştir); aktif panel yeşil-neon glow ile vurgulanır.
- **Gerçek yerel kota takibi** — Claude ve Gemini için gerçek token kullanımı, yerel
  oturum dosyalarından (ağa hiç istek atmadan) okunur ve hem üst bardaki mini
  göstergelerde hem sağdaki kota panelinde canlı gösterilir.
- **Sistem diline göre otomatik arayüz dili** (TR/EN).
- Frameless, Claude Desktop'a benzer koyu tema.

## Kurulum

```bash
npm install
npm start
```

## Durum

Aktif geliştirme aşamasında (MVP). Detaylı mimari notları, kararlar ve yol haritası için
[`PROJECT.md`](PROJECT.md)'ye bakın.
