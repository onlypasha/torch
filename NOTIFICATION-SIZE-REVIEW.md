# Ukuran notch notifikasi

15 November 2026. Permintaan pemilik: bingkai notch mengikuti kartu abu-abu. Arah visual, font, warna, radius, dan susunan kartu dipertahankan. Dials melanjutkan ENERGY 1 / RHYTHM 2 / MOTION 2.

Sebelumnya shell 640×200px memuat kartu 520×132px, menyisakan 60px di kiri/kanan dan sekitar 34px di atas/bawah. Notifikasi memakai ukuran panel umum walaupun tidak menampilkan tab bar.

Ukuran khusus notifikasi menjadi 544×156px. Inset panel khusus 12px pada semua sisi mempertahankan kartu 520×132px. Ukuran ini dipakai bersama oleh animasi shell, pembukaan panel dan area klik native. `setHitArea` tetap stabil melalui ref yang sudah ada. Penutupan notifikasi mengembalikan ukuran tab di bawahnya; preview collapse tetap 300×46px.

## Bukti

- Browser sebelum fix: shell 640×200, kartu 520×132, padding horizontal 60px.
- Regresi `interruption-fit` gagal sebelum fix dengan `got 60`, kemudian lulus setelah fix pada normal dan reduced motion.
- Regresi tersebut memeriksa keempat padding, dimensi kartu, native hit area 544×156, serta pemulihan tab dan hit area 640×200 setelah dismissal lokal.
- `arrival`, `queue`, `whatsapp`, `collapsed-preview`, `notification-size-cycle`, `spring-close` lulus.
- `bun test`: 130 pass, 0 fail. TypeScript dan frontend produksi berhasil dibangun.
- `bun run tauri build --no-bundle` berhasil. Executable release berisi frontend final di `src-tauri/target/release/notch-app.exe`.
- Screenshot `previews/nook/notification-fit.png` ditinjau langsung. Pesan dan identitasnya adalah fixture browser dengan native IPC mock.
- Tidak ada perubahan warna atau typography sehingga pasangan kontras tetap mengikuti komponen existing. Tidak ada galat console browser pada pemeriksaan terakhir.

## Delivery Gate

Lingkup gate adalah perubahan ukuran shell dan inset khusus notifikasi, bukan audit ulang seluruh aplikasi.

- R-02 PASS: tidak menambah UI copy atau em dash.
- R-03 PASS: keempat inset 12px dan containment kartu diperiksa di browser.
- R-17 PASS: tidak menambah angka produk atau statistik runtime.
- R-18 PASS: tidak menambah identitas atau testimonial produk.
- R-23 PASS: hanya screenshot fixture untuk verifikasi, tanpa aset dekoratif baru.
- R-24 PASS: tab kembali setelah dismissal lokal dalam probe.
- R-25 PASS: warna dan typography kartu existing dipertahankan.
- R-26 PASS: Next dan dismissal tetap bekerja dalam arrival/queue/fit.
- R-27 PASS: tidak mengubah state loading, kosong atau kegagalan.
- R-28 PASS: tidak menambah FAQ.
- R-32 PASS: kontrol native dan aturan fokus existing dipertahankan.
- R-33 PASS: source diedit langsung dengan patch.
- R-34 PASS: tetap satu tema overlay existing.
- R-35 PASS: reproduksi, regresi browser, build dan screenshot dijalankan.
- R-36 PASS: tidak menambah klaim performa atau keamanan.
- R-37 PASS: pemilik memberi arah eksplisit mengikuti kartu abu-abu.
- R-38 PASS: screenshot memakai fixture pengujian yang disebutkan.
- R-39 PASS: native controls, nama aksesibel dan reduced motion dipertahankan.
- R-40 PASS: tidak menambah media atau script eksternal.
- R-01 PASS: material existing dipertahankan tanpa gradient baru.
- R-04 PASS: tidak menambah atau mengganti ikon.
- R-06 PASS: font existing tetap, tidak menambah typeface.
- R-07 PASS: tidak menambah pola.
- R-08 PASS: tidak menambah panah dekoratif.
- R-09 PASS: indikator antrean tetap menunjukkan jumlah nyata dari state.
- R-10 PASS: tidak menambah blur.
- R-12 PASS: tidak menambah shadow.
- R-13 PASS: tidak menambah glow.
- R-14 PASS: kartu existing tetap, hanya bingkai menyesuaikan isi.
- R-19 PASS: transisi close/reverse dan siklus HUD lulus.
- R-22 PASS: tidak menambah ilustrasi.
- Liveliness, dials PASS: 1/2/2 dinyatakan dan dilanjutkan.
- Liveliness, consistency PASS: satu pesan memimpin, motion tetap menandai pergantian state.
- Liveliness, focal point PASS: kartu pesan tetap satu-satunya isi interruption.
- Liveliness, whitespace PASS: padding 12px punya fungsi memisahkan kartu dari tepi shell.
- Liveliness, accent PASS: hierarchy teks dan aksen aplikasi existing dipertahankan.
- Liveliness, motif PASS: shell notch dan kartu pesan existing tetap dikenali.
- Liveliness, Design Read PASS: arah mengikuti kartu dinyatakan sebelum edit.
- C-1 PASS: pengurangan padding didasarkan pada hasil ukur dan permintaan pemilik.
- C-2 PASS: antrean dan dismissal diuji.
- C-3 PASS: tidak menambah bagian atau fitur.
- C-4 PASS: pembukaan, penutupan, HUD, queue dan reduced motion lulus.
- C-5 PASS: dimensi berasal dari pengukuran browser; fixture disebutkan.
- R-05 PASS: tidak menambah layout template.
- R-11 PASS: radius existing dipertahankan.
- R-15 PASS: tidak mengubah label aksi.
- R-16 PASS: tidak menambah copy pemasaran.
- R-20 PASS: perubahan khusus interruption Nook desktop.
- R-21 PASS: tema mengikuti aplikasi dan screenshot pemilik.
- R-29 PASS: tidak menambah warna.
- R-30 PASS: mengikuti komponen aplikasi sendiri.
- R-31 PASS: alasan dimensi dan inset ditulis di atas.

UI/Human checklist untuk lingkup perubahan: kontrol, data, label dan material tetap; area klik native dan visual sama; reduced motion serta transisi kembali diuji. Pengujian aksi native memakai mock. Belum menguji interaksi Windows fisik pada executable baru.
