# Nook, arang hangat dan amber

Palet ini sudah digantikan oleh arah Media Control. Lihat [review terbaru](NOOK-MEDIA-STYLE-REVIEW.md).

15 November 2026. Pemilik memilih arah hangat: arang netral, putih lembut, amber pada aksi utama. Ini revisi desain widget utility Nook, bukan perubahan Media Control.

Design Read: utilitas desktop yang tenang dan mudah dipindai, ENERGY 1 / RHYTHM 2 / MOTION 2. Scroll dan pin tetap memakai model aplikasi yang ada. Dimensi widget tetap 252 × 148 px.

## Keputusan desain

| Peran | Warna | Alasan |
| --- | --- | --- |
| Permukaan kartu | #191816 | Arang hangat menyatu dengan notch hitam |
| Kelompok aksi | #28251f | Mengelompokkan kontrol tanpa empat kotak besar |
| Teks utama | #f0ece4 | Putih lembut memberi fokus pada isi |
| Teks sekunder | #bcb5aa | Hierarki lebih tenang dengan kontras yang cukup |
| Aksi utama dan status aktif | #e9b86c | Amber sesuai pilihan pemilik, digunakan terbatas |
| Teks pada amber | #241a0e | Menjaga tombol utama mudah dibaca |

Warna netral tambahan dipakai hanya untuk track, border dan hover. Error tetap punya warna semantik. Tidak ada gradient, glow atau blur baru.

- Kontrol cepat menjadi dua baris panjang berlabel dan satu kelompok aksi. Target input dan tombol tetap 44px.
- Pomodoro memakai satu angka besar dan progres horizontal, sehingga angka waktu menjadi fokus. Tombol durasi tetap di header dan aksi Reset memakai ikon dengan nama aksesibel.
- Monitor sistem memakai tiga jalur sejajar untuk membandingkan penggunaan CPU, RAM dan disk; nilai tetap berasal dari native IPC. Amber hanya menandai penggunaan tinggi.
- Kalender menandai hari ini dengan ring amber dan pilihan tanggal dengan latar hangat yang lebih tenang.
- Lirik dan cuaca memakai putih lembut untuk isi utama, teks sekunder hangat untuk konteks. Label “Cuaca contoh” tetap menyatakan sumber data statisnya.
- Radius 14px untuk kartu dan 12px untuk pin membedakan skala wadah. Kelompok aksi memakai radius 9px.
- Segoe UI dipertahankan sebagai font Windows. Angka countdown tabular berukuran 42px dengan tracking rapat; metrik sejajar untuk mempermudah perbandingan.
- Fokus amber berada di dalam batas stack agar tidak terpotong oleh wadah. Reduced motion, native keyboard slider, pin dan navigasi yang sudah diperbaiki tetap tersedia.

## Bukti verifikasi

- `bun test`: 130 lulus, 0 gagal.
- Frontend produksi dan TypeScript berhasil dibangun.
- `bun run tauri build --no-bundle` berhasil, dengan frontend final tersemat pada `src-tauri/target/release/notch-app.exe`.
- `widget-redesign`: keenam widget muat pada slot, target 44px, kegagalan dan pemulihan monitor sistem, DND, lock mock, seluruh aksi daya mock, Back dan Escape lulus.
- `quicksettings`: slider, mute, readout dan payload lulus.
- `timer-modes`: perubahan durasi, timer dan retensi sesi lulus pada komposisi angka besar.
- `compact`: shell dan hit rectangle Media aktif, pin serta tab lain lulus.
- `media-lyrics-independent`: kartu Lirik mati tetap menampilkan lirik synced dan plain pada Media.
- Reduced motion: `widget-redesign` dan `no-media` lulus. Termasuk ukuran 276/388, pin/unpin, perpindahan tab dan buka/tutup.
- Axe Quick Settings: 0 violations, 13 passes, 1 incomplete terkait penentuan latar melalui pseudo element. Kontras dihitung terpisah.
- Console tidak menunjukkan galat JavaScript. Screenshot warm-controls.png, warm-pomodoro.png dan warm-system.png ditinjau langsung.

Rasio kontras terhitung:

| Pasangan | Rasio |
| --- | ---: |
| Teks sekunder / permukaan | 8,73:1 |
| Teks utama / permukaan | 15,06:1 |
| Teks gelap / tombol amber | 9,39:1 |
| Status amber / latar aktif | 6,24:1 |
| Teks sekunder / kelompok aksi | 7,51:1 |
| Jalur kosong / permukaan | 3,24:1 |
| Isi metrik / jalur kosong | 3,73:1 |
| Progres amber / jalur kosong | 3,01:1 |

Track awal 2,57:1 diganti sebelum penyerahan. Semua angka screenshot memakai fixture pengujian; pengujian daya tidak menjalankan aksi Windows asli.

## Delivery Gate

- R-02 PASS: copy baru tanpa em dash.
- R-03 PASS: slot desktop dan target 44px diperiksa; ukuran shell adaptif tetap lulus.
- R-17 PASS: metrik asli memakai IPC; data statis cuaca tetap diberi label contoh.
- R-18 PASS: tidak ada testimonial atau identitas rekaan.
- R-23 PASS: tidak membuat aset baru; Reset memakai glif fungsional berlabel.
- R-24 PASS: navigasi dan menu yang ada tetap menuju fungsi asli.
- R-25 PASS: rasio teks dan track tercatat di atas.
- R-26 PASS: click-through slider, timer, toggle, lock mock dan menu daya mock lulus.
- R-27 PASS: loading/error/recovery monitor sistem, unavailable lyrics dan disconnected agenda tetap tersedia.
- R-28 PASS: tanpa FAQ.
- R-32 PASS: fokus terlihat; native keyboard, stack dan pin tetap berfungsi.
- R-33 PASS: file source diedit langsung, tanpa skrip pengganti CSS.
- R-34 PASS: satu tema overlay sesuai identitas notch.
- R-35 PASS: browser dan build dijalankan, screenshot ditinjau, interaksi dicatat.
- R-36 PASS: tidak menambah klaim performa atau keamanan.
- R-37 PASS: arah warna dipilih langsung oleh pemilik sebelum edit.
- R-38 PASS: fixture pengujian terpisah dari data asli dan contoh cuaca berlabel.
- R-39 PASS: kontrol native, label range, nama Reset, fokus dan reduced motion tersedia.
- R-40 PASS: tidak menambah media eksternal, font atau script pihak ketiga.
- R-01 PASS: warna mengikuti arah hangat pemilik; tidak ada gradient dekoratif.
- R-04 PASS: ikon tetap relevan dengan aksi.
- R-06 PASS: sistem font dan tabular angka untuk keterbacaan.
- R-07 PASS: tanpa pola latar.
- R-08 PASS: tanpa panah dekoratif.
- R-09 PASS: tanpa badge dekoratif.
- R-10 PASS: tanpa blur tambahan.
- R-12 PASS: tanpa bayangan baru pada setiap komponen.
- R-13 PASS: tanpa glow.
- R-14 PASS: komposisi angka, pita, jalur dan kontrol mengikuti isi.
- R-19 PASS: animasi existing tetap untuk navigasi, tanpa idle loop baru.
- R-22 PASS: tanpa ilustrasi baru.
- Liveliness, dials PASS: 1/2/2 dinyatakan dan diterapkan.
- Liveliness, consistency PASS: kartu tenang, isi bervariasi, motion menjawab aksi.
- Liveliness, focal point PASS: countdown atau nilai utama memimpin tiap widget.
- Liveliness, whitespace PASS: kontrol dan nilai dikelompokkan menurut fungsi.
- Liveliness, accent PASS: amber dipakai pada aksi utama dan status aktif.
- Liveliness, motif PASS: angka dan jalur mendatar memberi karakter utilitas kompak.
- Liveliness, Design Read PASS: dinyatakan sebelum edit.
- C-1 PASS: keputusan utama punya alasan tertulis.
- C-2 PASS: setiap aksi yang diubah tetap berfungsi.
- C-3 PASS: komposisi mendukung fungsi widget yang ada.
- C-4 PASS: containment, error recovery, Media mati dan reduced motion diuji.
- C-5 PASS: sumber data tetap dijelaskan.
- R-05 PASS: tidak memakai template dashboard baru.
- R-11 PASS: radius mengikuti peran wadah dan kontrol.
- R-15 PASS: label aksi tetap spesifik.
- R-16 PASS: tanpa jargon pemasaran.
- R-20 PASS: komposisi mengikuti kebutuhan slot NotchApp.
- R-21 PASS: tema hitam sesuai overlay existing.
- R-29 PASS: netral hangat dan satu aksen, error memakai warna semantik.
- R-30 PASS: tidak menyalin produk lain.
- R-31 PASS: alasan warna, layout, type, spacing dan ikon tertulis.

Lingkup: frontend desktop dan native boundary mock. Uji perangkat Windows fisik setelah mengganti executable belum dilakukan. Tidak ada klaim sertifikasi aksesibilitas menyeluruh.
