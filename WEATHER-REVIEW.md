# Cuaca terhubung dan lokasi Windows

15 November 2026. Pemilik meminta cuaca aktual dan mengarahkan lokasi mengikuti Windows. Arah visual tetap keluarga Media Control, ENERGY 1 / RHYTHM 2 / MOTION 2. Perubahan menambah fungsi data dan pengaturan lokasi pada slot yang sama.

## Perilaku

- Data statis `WEATHER` dihapus. Native mengambil current temperature, weather code, is_day dan prakiraan suhu dari [Open-Meteo](https://open-meteo.com/en/docs). Kondisi saat ini dari penyedia merupakan data model cuaca, bukan pembacaan sensor laptop.
- Pengguna membuka Pengaturan > Lokasi cuaca > Gunakan lokasi Windows. Permintaan izin dipanggil pada UI thread dengan jendela Pengaturan di foreground, sesuai [dokumentasi Microsoft](https://learn.microsoft.com/en-us/windows/apps/develop/maps-and-location/get-location). Belum ada request cuaca sebelum lokasi dikonfigurasi.
- Geolocator dibaca ulang pada setiap pembaruan, memakai maximum age 15 menit dan timeout 10 detik. Pembacaan berjalan di blocking worker dengan apartment WinRT sendiri; UI thread hanya memulai permintaan izin. Koordinat Windows dibulatkan dua angka desimal sebelum digunakan/dikirim.
- Jika izin/lokasi Windows tidak tersedia, Pengaturan menjelaskan penyebabnya. Pencarian kota manual melalui [geocoding Open-Meteo](https://open-meteo.com/en/docs/geocoding-api) menyediakan alternatif yang dapat dipilih dan disimpan.
- Nilai Celsius dibulatkan untuk tampilan. Kode WMO diterjemahkan ke bahasa Indonesia, termasuk hujan, petir, kabut, salju, kondisi malam dan kode tidak dikenal.
- Empat prakiraan mendatang dan waktu data mengikuti zona waktu lokasi, termasuk pergantian hari. Waktu Unix dari provider dipakai sebagai sumber waktu, bukan jam perangkat yang disamarkan sebagai waktu data.
- Pembaruan 15 menit; focus/online memeriksa apakah pembaruan sudah jatuh tempo setelah sleep. Cache dan single flight dibagi oleh widget utama dan pin, termasuk StrictMode.
- Jika refresh gagal, data terakhir tetap terlihat dengan label Data lama. Jika belum pernah berhasil, tampilkan pesan kegagalan dan Coba lagi/Atur lokasi. Data kosong tidak menjadi 0°C atau suhu contoh. Data provider berusia lebih dari 30 menit juga ditandai lama.
- Widget dimatikan atau lokasi belum dipilih: tidak ada request cuaca, timer pembaruan atau pembacaan lokasi.
- Satu client native dipakai ulang; respons dibatasi 128 KiB, timeout 12 detik, HTTPS dan domain tetap. Frontend menyimpan satu hasil ringkas dengan maksimal empat jam prakiraan. Tidak menambah gambar, SDK atau service polling per detik.
- Sumber Open-Meteo dapat dibuka dari widget. Pengaturan menjelaskan penggunaan lokasi dan sumber sebelum pengguna meminta izin.

## Desain

Wadah 252×148px dipertahankan. Header menyebut lokasi dan sumber, angka suhu menjadi fokus, kondisi dan waktu data di sampingnya, empat jam di bawah. Target kontrol 44px; baris kondisi dipusatkan agar waktu data tidak bertabrakan dengan prakiraan. Pin memakai model yang sama. Teks netral, font Windows, material dan fokus mengikuti widget lain. Lokasi panjang memakai ellipsis dengan nama lengkap di title.

## Verifikasi

- `bun test`: 134 pass, 0 fail, termasuk empat tes weather untuk null/zero/negative, zona waktu, waktu data, single flight, cache dan retry.
- `bun run tauri build --no-bundle`: release berhasil, dengan frontend final tersemat di `src-tauri/target/release/notch-app.exe`.
- `cargo check --lib`: berhasil setelah penambahan Geolocator dan apartment worker.
- `cargo test --lib config::tests`: 3 pass. Konfigurasi lama tetap dimuat, lokasi default belum dipilih, follow Windows menjadi preferensi awal, koordinat invalid ditolak dan lokasi manual dapat diserialisasi.
- Native live test `cargo test --lib weather::tests::live_provider -- --ignored --nocapture`: berhasil menghubungi layanan asli, mencari Jakarta, mengambil current temperature dan prakiraan. Menggunakan kota uji publik; tidak membaca lokasi perangkat.
- Browser memakai IPC/provider fixture: ready, unset, error/retry, stale, disabled, refresh-failure/recovery, settings/manual search/empty/save, windows-settings denied/allowed/save semuanya lulus.
- Ready menguji satu request di StrictMode, respons 26°C dari fixture, translasi Hujan, empat prakiraan, sumber dan pin. Angka fixture tidak diklaim sebagai cuaca pengguna.
- Reduced motion: ready dan error/retry lulus. Probe `widget-redesign` seluruh enam widget lulus.
- Keyboard: fokus Atur lokasi terlihat 2px dan Enter mengirim `config_open`.
- Axe pengaturan cuaca: 0 violations, 12 passes, 0 incomplete. Axe widget sesudah perbaikan ARIA: 0 violations, 13 passes, 1 incomplete terkait background/pseudo element. Kontras dihitung terpisah.
- Kontras teks widget #a1a1aa terhadap batas terang material #202020 = 6,36:1. Teks pengaturan #a9adb7 terhadap #202124 = 7,17:1. Border input #777b85 terhadap #202124 = 3,80:1 untuk non-text control.
- `previews/nook/weather-current.png`, `weather-connected.png`, dan `weather-settings.png` berasal dari browser fixture; ditinjau langsung.

## Paket Windows

Manifest identity 0.1.0.1 menambahkan DeviceCapability location dan mempertahankan userNotificationListener. Paket `src-tauri/target/identity/NotchApp.Identity.0.1.0.1.msix` dibangun dan ditandatangani memakai sertifikat development NotchApp yang sudah ada. `signtool verify /pa` berhasil.

Helper `src-tauri/scripts/Update-WeatherIdentity.ps1` mendaftarkan paket bertanda tangan dengan external location aplikasi yang sudah terdaftar. Lokasi dapat diganti secara eksplisit melalui parameter. Aplikasi harus ditutup sebelum pembaruan; helper menolak berjalan jika masih ada proses NotchApp.

Perbaikan setelah pengujian launch: registrasi tertunda awal menyebabkan error 15609 saat Windows mencoba registrasi ulang tanpa external location. Helper sekarang memakai registrasi langsung, mempertahankan root aplikasi sebelumnya, lalu memeriksa versi aktif dan capability lokasi. Paket 0.1.0.1 sudah aktif dengan root `src-tauri/target/debug`. Aktivasi executable debug dan release serta `bun tauri dev` berhasil diuji. Lihat `WINDOWS-LAUNCH-REVIEW.md`.

Izin lokasi Windows aktual memerlukan interaksi pengguna pada dialog sistem. Uji denied/allowed di browser adalah mock, bukan bukti izin lokasi perangkat sudah diberikan. Tidak mengubah pengaturan lokasi Windows secara otomatis.

## Delivery Gate

- R-02 PASS: copy baru tanpa em dash.
- R-03 PASS: slot tetap, containment dan pemisahan kondisi/prakiraan diuji; target baru 44px.
- R-17 PASS: nilai production berasal dari provider, bukan konstanta contoh.
- R-18 PASS: tidak menambah testimonial atau identitas produk rekaan.
- R-23 PASS: tanpa aset dekoratif baru; screenshot diberi konteks fixture.
- R-24 PASS: setup dan atribusi mempunyai command native; navigasi stack/pin tetap bekerja.
- R-25 PASS: rasio teks dan border terhitung dicatat di atas.
- R-26 PASS: search, hasil kota, Windows permission mock, save, retry, setup dan sumber diuji.
- R-27 PASS: unset/loading/error/retry/stale dan hasil pencarian kosong tersedia.
- R-28 PASS: tidak menambah FAQ.
- R-32 PASS: input/form/button native, label, fokus 2px dan Enter diperiksa.
- R-33 PASS: source diedit langsung dengan patch; rustfmt hanya memformat Rust.
- R-34 PASS: material overlay dan warna settings mengikuti tema existing.
- R-35 PASS: browser, compiler, unit test dan request provider asli dijalankan.
- R-36 PASS: batas verifikasi lokasi fisik dijelaskan; tidak mengklaim suhu sensor atau angka RAM yang belum diukur.
- R-37 PASS: pemilik memilih data nyata dan lokasi Windows; arah visual existing dipertahankan.
- R-38 PASS: fixture terpisah dari production, tanpa fallback ke suhu rekaan.
- R-39 PASS: accessible Celsius, group prakiraan, visible label, native controls dan reduced motion tersedia.
- R-40 PASS: tidak menambah media/font/script eksternal atau klaim metrik yang belum diukur.
- R-01 PASS: material Media existing dipertahankan.
- R-04 PASS: tidak menambah ikon dekoratif.
- R-06 PASS: font Windows dan tabular angka mengikuti shell.
- R-07 PASS: tidak menambah pola latar.
- R-08 PASS: tidak menambah panah dekoratif.
- R-09 PASS: label Data lama menandai kondisi data yang nyata.
- R-10 PASS: tidak menambah blur.
- R-12 PASS: tidak menambah shadow.
- R-13 PASS: tidak menambah glow.
- R-14 PASS: susunan cuaca khusus untuk suhu, kondisi dan urutan jam.
- R-19 PASS: gerak navigasi existing dan reduced motion tetap tersedia, tanpa idle loop baru.
- R-22 PASS: tidak menambah ilustrasi.
- Liveliness, dials PASS: 1/2/2 dinyatakan dan dipertahankan.
- Liveliness, consistency PASS: data menjadi fokus; gerak hanya untuk navigasi existing.
- Liveliness, focal point PASS: satu angka suhu utama.
- Liveliness, whitespace PASS: header, kondisi dan prakiraan mempunyai baris terpisah.
- Liveliness, accent PASS: putih terang memimpin suhu; konteks memakai abu-abu.
- Liveliness, motif PASS: material Media dan data ringkas dalam slot Nook.
- Liveliness, Design Read PASS: sumber, interval dan arah visual dinyatakan sebelum implementasi.
- C-1 PASS: layout mendukung data nyata dan waktu pembaruan.
- C-2 PASS: kontrol baru mempunyai handler dan diuji.
- C-3 PASS: tidak menambah bagian di luar cuaca/lokasi.
- C-4 PASS: error/recovery, disabled, unset, stale, pin dan reduced motion diuji.
- C-5 PASS: live provider diuji, fixture dan batas pengujian lokasi disebutkan.
- R-05 PASS: tidak menambah template dashboard.
- R-11 PASS: radius mengikuti komponen existing.
- R-15 PASS: aksi Cari, Coba lagi, Atur lokasi dan Gunakan lokasi Windows spesifik.
- R-16 PASS: copy menjelaskan tindakan, tanpa jargon pemasaran.
- R-20 PASS: komposisi disesuaikan slot Nook dan pengaturan desktop.
- R-21 PASS: tema gelap mengikuti aplikasi existing.
- R-29 PASS: palet netral existing, error memakai warna semantik.
- R-30 PASS: tidak menyalin aplikasi cuaca lain.
- R-31 PASS: alasan data, layout, typography, spacing dan pengaturan tertulis.

UI/Human checklist diperiksa untuk perubahan ini: identitas Media, data nyata, states yang jujur, label/fokus/target, kontrak keyboard, slot tetap dan kontrol native. Tidak menyatakan sertifikasi aksesibilitas menyeluruh atau uji sensor lokasi Windows fisik.
