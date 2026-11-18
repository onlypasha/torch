# Panel instrumen Nook

Preview: instruments.html. Arah mengikuti permintaan mengganti kartu dengan instrumen dan tipografi utama. ENERGY 1 / RHYTHM 2 / MOTION 2. Komposisi tenang, isi mengikuti fungsi, feedback tekan langsung dan perpindahan opacity 120 ms. Semua data baru dilabeli simulasi.

Alasan desain: hitam menyatukan isi dengan notch; #c4d7f8 menunjukkan tindakan utama dan pilihan; Segoe UI mengikuti Windows; angka tabular mencegah timer bergeser; ruang 252 × 148 px mengikuti slot aplikasi. Setiap widget memakai struktur sendiri: timer dominan, pita tanggal, slider, jalur metrik, teks lirik, suhu dan prakiraan. Tidak memakai border, blur, bayangan atau latar kartu pada isi widget. Bayangan hanya menjelaskan shell overlay.

Media dirender menggunakan Nook dan useNook asli, dengan IPC mock dan widgets kosong. Tidak mengubah source aplikasi. Bagian Media berada dalam keadaan kosong; tidak memutar media atau mengakses layanan Windows. Salinan overview tidak menerima input dan diberi inert; kontrol dicoba pada preview utama.

## Bukti browser

- Desktop 1262 px: 107 pemeriksaan lulus, termasuk ukuran Media 352 px, widget 252 px, shell 640 × 200 px.
- Mobile 320 px: 104 pemeriksaan lulus, tanpa overflow halaman dan kontrol widget minimum 44 × 44 px.
- Keenam pemilih widget membuka isi yang sesuai.
- Seluruh widget: kosong, memuat, gagal, dan Coba lagi diuji.
- Pomodoro: mulai, hitung waktu, jeda, reset, serta mode 25/5/15 menit diuji.
- Kalender: kelima tanggal dan tombol Hari ini diuji.
- Quick Settings: kedua slider berubah ke 35%; audio dan DND diuji aktif dan mati.
- Keyboard nyata: Enter pada pilihan mode menghasilkan 05:00; Tab menuju Reset, Space mengembalikan 05:00; computed focus outline solid.
- Tautan kembali menuju index.html yang tersedia dan telah dibuka pada pekerjaan sebelumnya.
- Console JavaScript tidak menunjukkan galat setelah pengujian.
- Axe mobile seluruh halaman: 0 violations, 39 passes, 1 incomplete terkait glif. Desktop widget aktif diperiksa terpisah; Media existing berada di luar lingkup perubahan.
- Screenshot instruments-desktop.png diperiksa secara visual. Screenshot mobile tersedia pada instruments-mobile.png.
- Kontras memakai pasangan yang sama dengan preview sebelumnya: teks/permukaan minimum 5,81:1, aksen/hitam 14,42:1. Tombol primer hitam/biru pucat 14,42:1. Tidak ada teks baru di atas gambar.

Skrip dan hasil: verify-instruments.js, instruments-qa-desktop.json, instruments-qa-mobile.json, instruments-a11y.json, instruments-a11y-page.json.

## Delivery Gate

- R-02 PASS: copy baru tanpa em dash.
- R-03 PASS: desktop dan mobile 320 px diuji, target widget minimal 44 px.
- R-17 PASS: angka contoh dilabeli simulasi; durasi mengikuti Pomodoro produk.
- R-18 PASS: tanpa testimonial atau identitas rekaan.
- R-23 PASS: tanpa foto, logo atau ilustrasi baru; panah dan reset adalah glif fungsional yang diizinkan konsep.
- R-24 PASS: tautan kembali menuju preview yang ada.
- R-25 PASS: pasangan teks terukur, tanpa teks di atas gambar.
- R-26 PASS: click-through setiap jenis kontrol tercatat di atas; overview secara eksplisit inert.
- R-27 PASS: tiga keadaan data tambahan dan retry diuji untuk keenam widget.
- R-28 PASS: tanpa FAQ.
- R-32 PASS: kontrol native, Tab/Enter/Space dan fokus diuji.
- R-33 PASS: ditulis langsung pada source preview melalui patch.
- R-34 PASS: satu tema sesuai overlay hitam, tanpa toggle tema.
- R-35 PASS: dijalankan di browser, screenshot ditinjau dan interaksi dicatat.
- R-36 PASS: tanpa klaim keamanan, pelanggan atau performa.
- R-37 PASS: arah dan dials dinyatakan sebelum pembuatan.
- R-38 PASS: simulasi diungkap, lirik berupa placeholder eksplisit.
- R-39 PASS: lang, title, landmarks, heading order, nama kontrol, label, pointer, fokus, hover, active, disabled dan reduced motion tersedia.
- R-40 PASS: tanpa media baru, font unduhan atau script eksternal; tidak mengklaim angka performa.
- R-01 PASS: palet mengikuti notch dengan satu aksen pilihan.
- R-04 PASS: reset dan play menunjukkan aksi, tanpa ikon dekoratif.
- R-06 PASS: Segoe UI untuk Windows, angka tabular untuk timer.
- R-07 PASS: tanpa pola background dekoratif.
- R-08 PASS: glif play hanya untuk aksi mulai.
- R-09 PASS: tanpa badge dekoratif.
- R-10 PASS: widget baru tanpa blur; Media memakai source existing.
- R-12 PASS: bayangan hanya pada shell overlay.
- R-13 PASS: tanpa glow baru.
- R-14 PASS: enam bentuk mengikuti isi, tanpa kartu berlapis.
- R-19 PASS: hanya feedback tekan dan opacity singkat, reduced motion dihormati, tanpa gerak berulang.
- R-22 PASS: tanpa ilustrasi baru.
- Liveliness, dials PASS: 1/2/2 dicatat dan dipakai.
- Liveliness, focal point PASS: angka timer atau informasi utama tiap widget memimpin komposisi.
- Liveliness, whitespace PASS: gap 12 px memisahkan Media dengan instrumen.
- Liveliness, accent PASS: satu aksen untuk aksi dan pilihan.
- Liveliness, motif PASS: angka, garis progres dan pita tanggal langsung pada notch.
- Liveliness, Design Read PASS: dinyatakan sebelum membangun dan ditulis di dokumen ini.
- C-1 PASS: alasan keputusan besar tercatat pada awal dokumen.
- C-2 PASS: kontrol utama berfungsi dalam simulasi; overview diberi inert.
- C-3 PASS: halaman untuk memeriksa rancangan dan membandingkan enam bentuk.
- C-4 PASS: keadaan data, layout sempit, keyboard dan browser diuji.
- C-5 PASS: tanpa klaim atau identitas fiktif.
- R-05 PASS: komposisi widget mengikuti fungsi, lembar overview hanya pembanding.
- R-11 PASS: radius shell dan tombol mengikuti peran, isi tidak dibungkus kartu.
- R-15 PASS: label menyebut tindakan: Hari ini, Coba lagi, Reset timer.
- R-16 PASS: tanpa jargon pemasaran.
- R-20 PASS: komposisi dibuat untuk dimensi dan isi NotchApp.
- R-21 PASS: hitam mengikuti overlay produk.
- R-29 PASS: netral dengan satu aksen.
- R-30 PASS: memakai prinsip Apple dan komponen produk, tidak menyalin aplikasi lain.
- R-31 PASS: alasan warna, typography, layout, spacing dan glif tertulis.

## Batas

Preview belum diterapkan pada aplikasi. Semua kontrol widget bersifat lokal. Timer, tanggal, slider dan toggle kini dipertahankan ketika widget diganti. Kalender memakai tanggal simulasi, cuaca dan lirik tidak terhubung provider. RAM aplikasi tidak diukur pada pekerjaan desain ini.

## Pembaruan navigasi scroll

Area widget menerima scroll ke bawah untuk berikutnya dan ke atas untuk sebelumnya. Menggunakan WidgetWheelNavigator aplikasi yang sudah ada untuk menangani momentum touchpad. Pita tanggal menangani scroll sendiri. Slider tidak memicu pergantian, gerakan horizontal dan Ctrl+scroll diabaikan. Wrapper fokus mendukung panah keyboard; slider mempertahankan panah untuk nilainya. Widget tetap dipasang tetapi disembunyikan saat tidak aktif agar sesi timer dan pilihan kontrol bertahan. Dimensi dan Media tidak berubah.

Bukti tambahan di instruments-qa-wheel.json: 23 pemeriksaan lulus, meliputi kedua arah, siklus enam widget, wrap, momentum, scroll kalender, slider, zoom, horizontal, retensi timer, keyboard, halaman tidak ikut bergulir, dan hanya satu widget aktif. Semua 107 pemeriksaan desktop sebelumnya juga diulang dan lulus.

Delivery Gate sesudah perubahan:

- Hard Gate PASS: perubahan pada wrapper group yang dapat difokus, instruksi scroll terlihat, dua alternatif navigasi keyboard dan tombol tetap tersedia; 23 tes perilaku dan 107 pemeriksaan regresi lulus.
- Purpose Gate PASS: tidak menambah dekorasi, gerak atau aset; scroll menerapkan arah pilihan pengguna dan penanganan momentum aplikasi.
- Liveliness PASS: dials 1/2/2, komposisi dan fokus tetap mengikuti widget aktif, tanpa kartu bertumpuk.
- Craftsmanship & Quality Locks PASS: kontrol di dalam widget mempertahankan fungsinya, nilai bertahan, timer berjalan saat tersembunyi, instruksi menjelaskan gesture dan pengecualian kalender.
