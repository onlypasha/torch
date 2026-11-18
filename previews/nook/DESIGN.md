# Arah preview Nook

Brief: merombak widget selain Media Control, mengganti metafora tumpukan flash card. Tiga preview interaktif untuk dipilih pemilik sebelum implementasi aplikasi.

Design Read: widget desktop ringkas bagi pengguna NotchApp, permukaan hitam yang tenang dan respons langsung. ENERGY 1 / RHYTHM 2 / MOTION 2. Gerak hanya feedback tekan; perpindahan isi langsung menjaga respons tanpa antrean animasi.

Palet: notch #000000, lembar review #202329, teks #f4f4f6, sekunder #b0b3bd, batas kontrol #737782, aksen #c4d7f8. Hitam menyatukan widget dengan notch. Aksen menunjukkan pilihan dan tindakan utama. Warna lembar review memisahkan prototype dari desktop.

Tipografi: Segoe UI Variable mengikuti Windows, angka tabular menjaga timer stabil, tracking negatif hanya pada angka besar dan judul. Isi sejajar kiri agar mudah dipindai di bidang kecil.

Layout native: shell 640 × 200, Media 352 × 148 dan slot widget 252 × 148. Area Media berupa referensi statis keadaan kosong dari komponen saat ini, bukan usulan redesign. Mobile menyembunyikan referensi Media agar widget dapat diperiksa tanpa pengecilan teks.

Rail: `[Media][↑ | isi widget]`, pemilih vertikal menetap, navigasi berurutan.

Panorama: `[Media][isi mendatar / navigasi bawah]`, konten mengambil komposisi yang sesuai dengan data.

Glance: `[Media][tanggal / timer / cuaca]`, ringkasan membuka detail satu tingkat dengan tombol kembali dan Escape.

Spasi: gap 12 px memisahkan Media dari widget. Bagian widget tidak diberi wadah kartu, bayangan, blur, glow, atau rotasi. Satu bayangan pada shell menjelaskan posisi overlay.

Ikon: tanda panah hanya untuk arah perpindahan, reset untuk mengembalikan timer. Not musik dan transport adalah referensi keadaan Media kosong dari produk. Tidak ada logo, foto, atau aset baru.

Data: angka sistem, cuaca, kalender dan slider berlabel simulasi pada halaman. Durasi 25 menit berasal dari mode Pomodoro aplikasi. Lirik memakai teks placeholder eksplisit. Kontrol tidak mengirim IPC atau mengubah sistem.

Review sebelum membangun: membedakan tiga desain melalui warna saja akan menghasilkan variasi kosmetik. Direvisi menjadi tiga model navigasi berbeda. Tidak memakai kartu berlapis lagi. Halaman hanya alat pembanding, bukan landing page pemasaran.
