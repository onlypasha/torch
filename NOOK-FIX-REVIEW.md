# Nook: lebar mengikuti fitur dan perapihan kartu

15 November 2026. Scope: memperbaiki notch yang ada. Konsep panel instrumen tidak diterapkan ke aplikasi.

Design Read: widget desktop NotchApp dengan susunan kartu yang sudah ada, permukaan netral dan label yang mudah dibaca. ENERGY 1 / RHYTHM 1 / MOTION 2. Kartu berukuran sama mempertahankan ruang interaksi saat digulir; isi kalender, timer, metrik dan kontrol tetap memiliki hierarki masing-masing.

## Penyebab dan perbaikan

Reproduksi awal `runNookScenario("no-media")` pada `tests/nook-ui.html?no-media` gagal dengan lebar visual 640 dan native hit rectangle 640, meskipun Media tidak dirender. Perhitungan lama hanya memilih 640/752 berdasarkan pin.

`nookPanelWidth` menghitung kolom Media 352, widget 252, pin 100, gap 12 dan padding total 24. Lebar minimum 276 mempertahankan ruang header dan keadaan Nook kosong. Hasil:

| Isi Nook | Lebar |
| --- | ---: |
| Media dan widget | 640 px |
| Media, widget dan pin | 752 px |
| Widget tanpa Media | 276 px |
| Widget dan pin tanpa Media | 388 px |
| Media saja | 376 px |
| Semua isi dimatikan | 276 px |

Ukuran visual, area klik saat mulai membuka, serta pembaruan pin/tab memakai perhitungan yang sama. Callback penetapan hit area tetap stabil; ukuran panel terbaru dibaca melalui ref agar efek startup tidak mengirim ulang ukuran collapsed saat pin berubah. Window native tetap pada ukuran tetap untuk menghindari kedipan WebView2.

## Alasan visual

- Permukaan #141416 yang solid menjaga keterbacaan kartu di atas deck dan tidak ikut berubah warna karena album art.
- Radius kartu 14 dan pin 12 membedakan wadah isi dari shell 24 tanpa mengubah dimensi atau susunannya.
- Label 11 px dengan sentence case dan tracking normal memperjelas jenis widget tanpa judul kapital dekoratif.
- Label #b0b3bd memiliki kontras 8,79:1 terhadap kartu; nilai #9ca3af 7,25:1.
- Fokus #c4d7f8 memiliki kontras 14,42:1 terhadap hitam; ring 2 px membantu navigasi keyboard.
- Scroll, susunan deck, kontrol Media, ukuran isi dan perilaku pin dipertahankan. Tidak ada aset baru.

## Verifikasi

- `bun run build`: TypeScript dan frontend production build lulus.
- `bun test`: 130 lulus, 0 gagal. Termasuk pengujian lebar enam konfigurasi.
- `bun run tauri build --no-bundle`: release production berhasil, termasuk frontend tersemat. Executable: `src-tauri/target/release/notch-app.exe`.
- Browser, aplikasi asli dengan boundary native mock: `no-media` lulus untuk 276/388, pin/unpin, Tray 640, kembali ke Nook, close 200 dan reopen 388.
- `compact` dengan Media aktif: 640/752, ukuran kolom, pin, tab lain, close dan native hit rectangle lulus.
- `quicksettings` tanpa Media: kedua slider, mute, pembacaan nilai dan payload native mock lulus.
- `calendar` tanpa Media: pemilihan tanggal, kembali ke hari ini, scroll tanggal dan containment lulus.
- `stack` pada konfigurasi default: scroll, momentum touchpad, keyboard dan isolasi scroll halaman lulus.
- `timer-modes`: ganti mode, kontrol timer dan perpindahan widget lulus.
- Axe pada Quick Settings aktif: 0 violations, 12 passes, satu incomplete untuk contrast akibat komposisi/pseudo element. Pasangan warna dihitung terpisah di atas.
- Console browser tidak menunjukkan galat JavaScript. Screenshot `previews/nook/current-no-media.png` diperiksa secara visual.

Data fixture adalah data simulasi pengujian; pengaturan, notifikasi dan daya Windows asli tidak diubah. Dimensi visual dan payload hit area diperiksa di browser. Uji manual klik native Windows sesudah mengganti binary belum dilakukan.

## Delivery Gate, lingkup perubahan ini

### Hard Gate

- R-02 PASS: copy baru tidak memakai em dash.
- R-03 PASS: kolom widget tetap muat dalam shell 276. Ini overlay desktop fixed-size, bukan halaman mobile; ukuran target kontrol existing dipertahankan sesuai permintaan mempertahankan layout.
- R-17 PASS: tidak menambahkan angka produk atau statistik rekaan; tabel ukuran berasal dari kode dan browser.
- R-18 PASS: tanpa testimonial atau identitas rekaan.
- R-23 PASS: tidak membuat logo, foto, ikon atau struktur navigasi baru.
- R-24 PASS: tab yang ada tetap menuju panel asli; perpindahan Tray/Nook diuji.
- R-25 PASS: kontras label dan nilai terhadap kartu dihitung 8,79:1 dan 7,25:1.
- R-26 PASS: tidak menambahkan kontrol; slider, mute, kalender, timer dan menu pin diuji.
- R-27 PASS: tidak menambah sumber data; keadaan Media kosong, agenda belum terhubung dan lirik belum tersedia tetap terlihat selama pengujian.
- R-28 PASS: tidak menambah FAQ.
- R-32 PASS: ring fokus diperjelas; navigasi keyboard stack diuji.
- R-33 PASS: perubahan langsung pada source melalui patch, tanpa skrip pengganti CSS.
- R-34 PASS: tema overlay yang ada dipertahankan, tanpa toggle tambahan.
- R-35 PASS: build, tes dan click-through di atas dijalankan, screenshot diperiksa.
- R-36 PASS: tidak menambah klaim keamanan atau performa.
- R-37 PASS: arah mempertahankan layout berasal dari permintaan pengguna dan screenshot; dials dinyatakan sebelum edit.
- R-38 PASS: tidak menambah konten produksi; data fixture tetap hanya di pengujian.
- R-39 PASS: ring fokus baru jelas; kontrol native dan nama aksesibel existing dipertahankan; tidak menambah animasi.
- R-40 PASS: tidak menambah media, font, script pihak ketiga, atau klaim Web Vitals.

### Purpose Gate

- R-01 PASS: gradient kartu dihapus; permukaan solid menjaga isi tidak berubah mengikuti album.
- R-04 PASS: tidak menambah ikon dekoratif.
- R-06 PASS: label sentence case dan tracking normal meningkatkan keterbacaan pada ukuran kecil; Segoe UI tetap mengikuti Windows.
- R-07 PASS: tanpa pola background baru.
- R-08 PASS: tanpa panah dekoratif baru.
- R-09 PASS: tanpa badge baru.
- R-10 PASS: tanpa blur tambahan pada kartu.
- R-12 PASS: tidak menambah bayangan.
- R-13 PASS: tidak menambah glow.
- R-14 PASS: wadah bersama menjaga ukuran saat scroll; isi kalender, timer dan kontrol tetap berbeda menurut fungsi.
- R-19 PASS: animasi deck existing melayani pergantian widget; tidak menambah gerak.
- R-22 PASS: tanpa ilustrasi baru.

### Liveliness

- Dials PASS: 1/1/2 dinyatakan dan sesuai kartu kompak dengan pergantian existing.
- Konsistensi PASS: wadah dan ukuran tetap, hierarki isi mengikuti fungsi.
- Focal point PASS: kartu aktif tetap menjadi fokus.
- Whitespace PASS: ruang Media yang dimatikan dihapus dari shell.
- Aksen PASS: fokus keyboard memakai aksen biru pucat.
- Motif PASS: deck kompak mengikuti notch dan input scroll.
- Design Read PASS: tercatat sebelum implementasi dan pada awal dokumen.

### Craftsmanship dan Quality Locks

- C-1 PASS: alasan warna, radius, label dan geometri tertulis.
- C-2 PASS: tidak menambah kontrol; interaksi terkait diuji.
- C-3 PASS: menghapus ruang kosong yang tidak memiliki isi.
- C-4 PASS: konfigurasi Media aktif/mati, pin, tab, close/reopen dan keyboard diuji.
- C-5 PASS: tidak menambah klaim atau data rekaan ke aplikasi.
- R-05 PASS: susunan existing dipertahankan sesuai instruksi pengguna.
- R-11 PASS: radius dibedakan menurut shell, kartu utama dan pin.
- R-15 PASS: tidak menambah CTA generik.
- R-16 PASS: tidak menambah jargon pemasaran.
- R-20 PASS: mempertahankan identitas overlay Windows NotchApp.
- R-21 PASS: hitam mengikuti shell overlay yang sudah ada.
- R-29 PASS: kartu netral, satu aksen fokus.
- R-30 PASS: tidak menyalin produk lain.
- R-31 PASS: keputusan visual utama diberi alasan di atas.
