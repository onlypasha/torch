# Verifikasi preview Nook

Tanggal: 15 November 2026. Prototype HTML, CSS, dan JavaScript mandiri. Tidak menjalankan IPC, mengambil notifikasi, atau mengubah pengaturan perangkat. Implementasi aplikasi belum diganti.

Browser: Chromium melalui agent-browser. Pengujian interaksi di 1262, 375, dan 320 px: masing-masing 287 pemeriksaan lulus. Bukti lengkap di qa-desktop.json, qa-mobile.json, qa-narrow.json dan skrip verify.js. Screenshot desktop dan mobile diperiksa secara visual. Axe pada render awal final: 0 violations, 38 passes, 2 incomplete. Incomplete berhubungan dengan teks glif dan slider native; pasangan warna dikomputasi terpisah. Tidak mengklaim sertifikasi WCAG atau skor performa.

## Click-through

- Pilihan widget: keenam isi terbuka di ketiga konsep.
- Keadaan data: kosong, memuat, dan gagal muncul untuk setiap widget; Coba lagi memulihkan simulasi terisi.
- Rail: tombol sebelumnya dan berikutnya mengganti widget serta mempertahankan fokus.
- Panorama: kedua tombol navigasi mengganti widget dan nama aktif.
- Glance: ketiga baris membuka detail, tombol kembali dan Escape memulihkan ringkasan.
- Kalender: ketiga tanggal dapat dipilih, angka utama dan aria-pressed mengikuti pilihan.
- Volume dan kecerahan: kedua slider mengubah output lokal.
- Bisu dan DND: kedua tombol bisa dinyalakan dan dimatikan.
- Pomodoro: Mulai menjalankan hitungan nyata, Jeda menghentikan, Reset mengembalikan 25:00.
- Tandai: setiap konsep bisa ditandai, pilihan sebelumnya dilepas, pesan meminta pengguna menyebutkan pilihan di chat. Tidak mengirim pesan otomatis.
- Tautan Rail, Panorama, Glance menuju section yang ada.
- Keyboard nyata: fokus Bisu, Enter mengaktifkan, Tab menuju DND, Space mengaktifkan; outline computed solid. Tombol native lainnya memakai perilaku keyboard browser. Escape detail Glance diuji di ketiga pilihan.
- Console browser tidak menunjukkan galat JavaScript.

## Delivery Gate

### Hard Gate

- R-02 PASS: teks preview dan dokumen baru tidak memakai em dash.
- R-03 PASS: lebar halaman tidak meluber pada 1262, 375, dan 320 px; kontrol widget memiliki target minimal 44 px.
- R-17 PASS: angka diberi label simulasi, durasi Pomodoro mengikuti mode produk.
- R-18 PASS: tidak ada testimonial atau identitas fiktif.
- R-23 PASS: tidak membuat logo, foto, atau aset baru; glif hanya merepresentasikan fungsi dan referensi Media kosong.
- R-24 PASS: semua tautan menuju konsep yang benar-benar ada.
- R-25 PASS: kontras pasangan teks utama terukur 5,81:1 sampai 14,42:1; tidak ada teks di atas gambar.
- R-26 PASS: seluruh jenis kontrol diuji, perilakunya tercatat dalam Click-through.
- R-27 PASS: setiap widget memiliki tiga keadaan data tambahan yang dapat dipilih dan retry berfungsi.
- R-28 PASS: tidak ada FAQ.
- R-32 PASS: kontrol native, indikator fokus solid, navigasi keyboard dan Escape diuji.
- R-33 PASS: file ditulis langsung melalui patch, tidak memakai skrip pengganti CSS atau source.
- R-34 PASS: satu tema hitam sesuai identitas overlay produk, tanpa toggle tema tambahan.
- R-35 PASS: preview dijalankan di browser, screenshot diperiksa, click-through tercatat di atas.
- R-36 PASS: tidak ada klaim keamanan, performa, atau pelanggan.
- R-37 PASS: arah, dials, dan alasan keputusan dicatat sebelum penyerahan di DESIGN.md.
- R-38 PASS: simulasi dijelaskan pada header; teks lirik secara eksplisit placeholder.
- R-39 PASS: dokumen berbahasa Indonesia, title unik, landmarks, nama kontrol, label input, cursor, fokus, hover, active, disabled, serta reduced motion tersedia.
- R-40 PASS: tanpa media eksternal atau script pihak ketiga; tidak ada angka performa yang diklaim.

### Purpose Gate

- R-01 PASS: hitam berasal dari notch; aksen menunjukkan pilihan dan tindakan utama, alasan tertulis.
- R-04 PASS: glif navigasi dan reset menunjukkan fungsi; not musik merupakan referensi Media, alasan tertulis.
- R-06 PASS: Segoe UI mengikuti Windows, angka tabular menjaga timer stabil.
- R-07 PASS: tanpa pola background dekoratif.
- R-08 PASS: panah hanya menunjukkan arah navigasi atau membuka detail.
- R-09 PASS: tidak ada capsule badge atau status dekoratif.
- R-10 PASS: tidak ada backdrop blur.
- R-12 PASS: satu bayangan pada shell menandakan overlay, tidak pada setiap widget.
- R-13 PASS: tidak ada glow.
- R-14 PASS: isi tanpa kartu; kalender, metrik, timer, lirik dan kontrol mengikuti struktur datanya.
- R-19 PASS: feedback tekan langsung tanpa animasi berulang; reduced motion menghapus transformasi tambahan melalui browser preference styling.
- R-22 PASS: tidak ada ilustrasi baru.

### Liveliness

- Dials PASS: ENERGY 1 / RHYTHM 2 / MOTION 2 tertulis pada DESIGN.md.
- Konsistensi PASS: shell tenang, isi bervariasi mengikuti fungsi, gerak hanya akibat aksi.
- Focal point PASS: satu widget aktif, atau satu daftar ringkasan pada Glance.
- Whitespace PASS: slot Media dan widget dipisahkan 12 px, bukan oleh kartu bertumpuk.
- Aksen PASS: biru pucat menandai selection dan tindakan utama.
- Motif PASS: isi langsung pada notch, navigasi menetap, angka terbaca sekilas.
- Design Read PASS: dinyatakan sebelum pembuatan dan disimpan di DESIGN.md.

### Craftsmanship dan Quality Locks

- C-1 PASS: alasan warna, type, susunan, jarak dan glif tertulis.
- C-2 PASS: tidak ada kontrol dekoratif yang berpura-pura bekerja; Media hanya referensi noninteraktif.
- C-3 PASS: halaman berisi pembanding konsep dan alat mencoba widget, tidak ada section pemasaran.
- C-4 PASS: enam widget, tiga keadaan tambahan, desktop dan layar sempit diuji; tanpa tema kedua.
- C-5 PASS: seluruh angka contoh diungkap sebagai simulasi.
- R-05 PASS: tiga model navigasi berbeda, tanpa bento atau template landing page.
- R-11 PASS: radius besar pada shell, radius kecil pada kontrol, isi tidak diberi wadah kartu.
- R-15 PASS: label Mulai, Jeda, Coba lagi dan Tandai menjelaskan aksi.
- R-16 PASS: tanpa jargon pemasaran.
- R-20 PASS: tiga komposisi diturunkan dari kebutuhan slot notch, bukan dashboard umum.
- R-21 PASS: tema hitam mengikuti permukaan overlay produk yang ada.
- R-29 PASS: netral dan satu aksen.
- R-30 PASS: prinsip feedback dan hierarchy Apple diterapkan tanpa menyalin tampilan aplikasi lain.
- R-31 PASS: setiap keputusan besar punya alasan pada DESIGN.md.

## Batas preview

Ini usulan navigasi dan visual, belum implementasi Tauri. Media adalah referensi statis keadaan kosong. Kalender menampilkan tiga tanggal contoh agar target klik tetap 44 px dalam slot kecil; rentang tanggal penuh dan interaksi pin akan diselesaikan setelah konsep dipilih. Tidak ada integrasi cuaca atau lirik nyata. Pengukuran RAM aplikasi tidak dilakukan untuk prototype ini.
