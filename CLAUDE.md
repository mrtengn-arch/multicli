# multicli — Çalışma Kuralları (her oturumda otomatik yüklenir)

**İlk iş:** `PROJECT.md`'yi oku — vizyon, v1'in eski mimarisi (§2, referans), v2'nin
gelişmekte olan mimarisi (§3), kararlar (§4) ve günlük (§5) orada.
Oturum sonunda PROJECT.md'nin §5 Günlük'üne tarihli bir girdi ekle; yeni karar aldıysan
§4'e K-numarası ile ekle.

## Sabit kurallar

- **Dil:** Murat'la Türkçe konuş. Repo private kalacaksa kod/commit dili konusunda
  serbest; public'e taşınırsa (bkz. [[project_ai_limit_hq]] emsali) İngilizceye geçilecek
  — o karar verilince burada not edilir.
- **Kod yazmadan önce onay al** ([[feedback_gemini_rules]] — cerrahi müdahale prensibi
  tüm projelerde geçerli, sadece GAS'a özgü değil).
- v1 koddan hiçbir şey kurtarılamıyor (silindi, remote yok) — v2, PROJECT.md §2'deki
  mimari NOTLARINDAN yola çıkar ama sıfırdan yazılır.
- **Git remote'u erken kur** — v1'in en büyük dersi buydu (K1). Private repo bile olsa,
  en azından local git + [[project_drive_backup]] kapsamında yedeklensin.
- v2 mimarisi netleşmeden koda girişme; PROJECT.md §3 doldukça uygula.

## Yapı ve referanslar

- Klasör: `C:\Users\murat\Projects\multicli` (henüz git init edilmedi)
- İlgili hafıza notları: [[feedback_cost_delegation]] (projenin "neden"i),
  [[project_ai_limit_hq]] (benzer "kota izleme" fikri ama farklı ürün — biri tarayıcı
  eklentisi+dashboard, biri terminal aracı), [[project_conduit]] (CLI lane fikri burada
  da var)
- WezTerm bu makinede kurulu (26 Ağu 2026, `winget install wez.wezterm`) — v2 terminal
  backend kararında değerlendirilecek seçeneklerden biri.
