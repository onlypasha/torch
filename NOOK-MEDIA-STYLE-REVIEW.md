# Widget Nook mengikuti Media Control

15 November 2026. Arah terbaru pemilik menggantikan palet hangat: gunakan warna dan desain Media Control yang sudah ada.

Design Read mengikuti iterasi sebelumnya: ENERGY 1 / RHYTHM 2 / MOTION 2. Utilitas tetap tenang, komposisi mengikuti isi, gerak menunjukkan perpindahan widget. Referensi visual sekarang adalah komponen Media Control di aplikasi ini.

## Keputusan

- Media dan utilitas membaca satu `--nook-card-material`: radial tint sampul 9% dan lapisan putih 3,5% sampai 1%. Refaktor Media mempertahankan rumus background sebelumnya. Artwork aura tetap milik Media.
- Utilitas memakai dasar hitam opak di bawah material bersama agar isi kartu berikutnya tidak menembus kartu aktif. Tidak menambah blur atau pemrosesan gambar.
- Kartu utama beradius 20px seperti Media. Pin 16px mengikuti ukuran wadah yang lebih kecil; kalender memakai radius 8px untuk sel tanggal.
- Teks utama putih, sekunder #a1a1aa, ikon #d4d4d8, progres #f5f5f5. Tidak ada amber. Aksen warna hanya berasal dari tint sampul dan warna semantik kegagalan atau penggunaan tinggi.
- Kontrol memakai tombol transparan dan hover putih 9%, seperti tombol Media. Mulai tetap berlabel jelas dengan warna putih; tombol aktif mempunyai latar putih 16% dan status native/ARIA yang sudah ada.
- Track 4px mengikuti proporsi timeline Media, dengan hit area kontrol tetap 44px. Track utilitas #73737a menjaga kontras data; progres penggunaan tinggi #fecaca dipasangkan dengan angka persentase yang tetap terlihat.
- Segoe UI Variable tetap mengikuti shell. Hirarki isi dipertahankan: angka timer, tiga jalur monitor, kalender horizontal, lirik, dan prakiraan cuaca berlabel contoh.
- Dimensi, mekanisme scroll, pin, akses keyboard, reduced motion, lebar saat Media mati, dan pemisahan lirik Media dari kartu Lirik dipertahankan.

## Verifikasi

- `bun test`: 130 pass, 0 fail.
- `bun run build`: TypeScript dan frontend produksi berhasil.
- `bun run tauri build --no-bundle`: build release berhasil, frontend final tersemat pada `src-tauri/target/release/notch-app.exe`.
- Browser dengan native boundary mock: `widget-redesign`, `quicksettings`, `compact`, dan `timer-modes` lulus tanpa errors.
- Reduced motion: `no-media`, `media-lyrics-independent`, dan `widget-redesign` lulus. Konfigurasi kartu Lirik mati tetap menampilkan lirik synced/plain pada Media.
- `timer` lulus setelah penyesuaian indikator pin. Computed style memastikan border progres #f5f5f5 dan radius 16px sama dengan kartu pin.
- Keyboard slider: ArrowUp mengubah volume 64 menjadi 65 tanpa mengganti widget. Outline fokus terukur 2px #f5f5f5.
- Computed style pada tint putih, merah dan biru memastikan kedua jenis kartu memakai gradient yang sama; radius utama keduanya 20px. Override sementara dikembalikan setelah pemeriksaan.
- `no-media` memeriksa lebar 276px, pin menjadi 388px, tab lain, tutup/buka, dan unpin.
- Pemeriksaan widget mencakup containment, target 44px, pemulihan kegagalan monitor, toggle DND, lock, menu daya, Back dan Escape. Aksi sistem memakai mock, tidak mematikan atau mengunci Windows.
- Axe pada Monitor Sistem: 0 violations, 7 passes, 1 incomplete karena lapisan background/pseudo element. Kontras dihitung terpisah.
- Screenshot aktual browser ditinjau: `previews/nook/media-style-controls.png`, `media-style-pomodoro.png`, dan `media-style-system.png`. Angka dan lagu pada screenshot berasal dari fixture pengujian.
- `previews/nook/media-style-pinned.png` merekam indikator Pomodoro pin yang sudah netral.
- Console browser tanpa galat JavaScript pada rangkaian pemeriksaan terakhir.

Rasio dihitung dengan `.agents/skills/antislop-human/contrast-check.py`. Batas terang konservatif untuk material utilitas adalah #202020: dasar hitam dengan tint maksimum putih 9% dan lapisan putih maksimum 3,5%. Permukaan utilitas tetap opak sehingga lapisan di belakangnya tidak menaikkan batas ini.

| Pasangan | Rasio | Kegunaan |
| --- | ---: | --- |
| #a1a1aa / #202020 | 6,36:1 | Teks sekunder |
| #ffffff / #363636 | 12,08:1 | Teks pada hover |
| #73737a / #202020 | 3,46:1 | Jalur data terhadap kartu |
| #f5f5f5 / #73737a | 4,32:1 | Isi progres terhadap jalur |
| #fecaca / #73737a | 3,25:1 | Isi penggunaan tinggi terhadap jalur |

Warna penggunaan tinggi awal #fca5a5 diganti sebelum penyerahan karena kontras terhadap track hanya 2,48:1. Warna error teks Media tidak diubah.

## Delivery Gate

Lingkup laporan adalah perubahan utilitas desktop dan refaktor material bersama. Tidak menyatakan audit aksesibilitas menyeluruh komponen Media yang sudah ada.

- R-02 PASS: teks perubahan tanpa em dash.
- R-03 PASS: containment slot dan target 44px lulus di browser; shell 276/388/640/752px tetap berfungsi.
- R-17 PASS: tidak menambah angka produk; data runtime tetap IPC.
- R-18 PASS: tidak menambah testimonial atau identitas.
- R-23 PASS: tidak membuat aset dekoratif; screenshot adalah bukti aplikasi.
- R-24 PASS: navigasi stack, pin dan tab memakai fungsi existing.
- R-25 PASS: rasio terhitung tercatat di atas; warna track diperbaiki sebelum selesai.
- R-26 PASS: slider, timer, DND dan aksi daya mock lulus pemeriksaan interaksi.
- R-27 PASS: loading, error, recovery monitor dan unavailable lyrics tetap ada.
- R-28 PASS: tidak ada FAQ pada perubahan ini.
- R-32 PASS: focus-visible putih, navigasi keyboard dan Escape tetap tersedia.
- R-33 PASS: source CSS diedit langsung dengan patch.
- R-34 PASS: overlay gelap mengikuti tema aplikasi existing.
- R-35 PASS: build dan browser dijalankan, screenshot ditinjau, interaksi diperiksa.
- R-36 PASS: tidak menambah klaim performa, keamanan atau kepatuhan.
- R-37 PASS: arah terbaru pemilik secara eksplisit memilih Media Control sebagai referensi.
- R-38 PASS: screenshot memakai fixture; cuaca statis tetap berlabel contoh.
- R-39 PASS: native controls dan nama aksesibel dipertahankan; reduced motion diuji.
- R-40 PASS: tidak menambah media, font atau script eksternal; tidak mengklaim metrik yang belum diukur.
- R-01 PASS: gradient berasal dari material Media; alasannya menyatukan keluarga komponen.
- R-04 PASS: ikon volume, kecerahan, mute, DND, lock, power dan reset tetap sesuai aksi.
- R-06 PASS: font Windows mengikuti shell; angka tabular untuk pembacaan waktu dan metrik.
- R-07 PASS: tidak menambah pola latar.
- R-08 PASS: tidak menambah panah dekoratif.
- R-09 PASS: tidak menambah badge dekoratif.
- R-10 PASS: tidak menambah backdrop blur.
- R-12 PASS: tidak menambah shadow baru pada kontrol.
- R-13 PASS: tidak menambah glow.
- R-14 PASS: ukuran kartu mengikuti slot tetap; susunan tiap widget mengikuti fungsi.
- R-19 PASS: navigasi mempertahankan gerak existing, tanpa idle loop baru.
- R-22 PASS: tidak menambah ilustrasi.
- Liveliness, dials PASS: 1/2/2 dinyatakan dan dipertahankan.
- Liveliness, consistency PASS: material tenang, komposisi bervariasi, motion untuk navigasi.
- Liveliness, focal point PASS: angka timer, nilai metrik atau baris lirik memimpin isi.
- Liveliness, whitespace PASS: label, nilai dan aksi dikelompokkan menurut fungsi.
- Liveliness, accent PASS: putih terang mengarahkan perhatian ke angka/progres/aksi utama; tint mengikuti sampul.
- Liveliness, motif PASS: material Media, tombol transparan dan jalur tipis berulang secara fungsional.
- Liveliness, Design Read PASS: referensi Media dinyatakan sebelum perubahan, dials melanjutkan arah existing.
- C-1 PASS: alasan material, warna, kontrol, type dan radius tertulis di atas.
- C-2 PASS: aksi yang dipertahankan lulus probe browser.
- C-3 PASS: tidak menambah bagian di luar kebutuhan widget.
- C-4 PASS: state error/recovery, Media mati, pin dan reduced motion diperiksa.
- C-5 PASS: bukti mock dan batas verifikasi disebutkan secara eksplisit.
- R-05 PASS: tidak menambah template dashboard.
- R-11 PASS: radius kartu 20px, pin 16px, kalender 8px dan kontrol bundar punya peran berbeda.
- R-15 PASS: label aksi tetap Mulai, Jeda, Reset dan durasi yang spesifik.
- R-16 PASS: tidak menambah copy pemasaran.
- R-20 PASS: komposisi tetap khusus slot Nook desktop.
- R-21 PASS: tema gelap mengikuti notch dan referensi pemilik.
- R-29 PASS: palet netral; tint sampul dan merah hanya punya peran yang disebutkan.
- R-30 PASS: referensi adalah komponen existing aplikasi sendiri.
- R-31 PASS: keputusan penting dijelaskan pada bagian Keputusan.

UI checklist dan Human checklist diperiksa untuk lingkup perubahan ini: referensi palet jelas, label/target/fokus dipertahankan, kontrol nyata, state kegagalan diuji, tanpa navigasi atau data baru. Tidak menambah halaman responsif atau shell mobile pada aplikasi desktop ini.

Uji interaksi Windows fisik setelah mengganti executable belum dilakukan.
