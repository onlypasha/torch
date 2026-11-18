# Konfigurasi kosong pada Windows

15 November 2026. Jendela Konfigurasi NotchApp terbuka putih dan tidak menampilkan kontrol.

## Penyebab

Menu native memanggil `config::open` secara sinkron, kemudian `WebviewWindowBuilder::build` berjalan di callback UI Windows. Command `config_open` juga sinkron sehingga jalur Atur lokasi dari widget memiliki masalah yang sama. Tauri mendokumentasikan deadlock WebView2 ketika builder dipakai dari synchronous command atau event handler: [WebviewWindowBuilder](https://docs.rs/tauri/2.12.4/tauri/webview/struct.WebviewWindowBuilder.html).

Hipotesis alternatif adalah URL konfigurasi atau JavaScript gagal dimuat. Tes native memakai frontend dan URL yang sama sebelum/sesudah perubahan; memindahkan pembuatan WebView keluar dari callback menyelesaikan masalah.

## Perubahan

- Menu hanya mengantrekan tugas pembukaan lalu mengembalikan kontrol ke UI thread.
- `config_open` menjadi async. Kedua pintu masuk menggunakan fungsi async yang sama.
- Pembuatan WebView dan show/focus berjalan di blocking worker Tauri.
- Async mutex mengurutkan permintaan agar klik bersamaan memakai satu jendela.
- Tidak mengubah tampilan, config tersimpan, registrasi paket, atau izin lokasi.

## Bukti dan regresi

- Computer Use memeriksa jendela native lama: putih, accessibility tree kosong, heading tidak tersedia. Assertion SETTINGS_NOT_READY gagal.
- `scripts/Test-SettingsNative.ps1` memakai `examples/settings_smoke.rs` dengan config module asli dan frontend embedded.
- Sebelum fix: test gagal setelah watchdog 20 detik, completed phases=0. Cocok dengan jendela yang muncul tetapi React tidak pernah dirender.
- Sesudah fix: menu/UI callback membuka konfigurasi dan React heading/kontrol terdeteksi.
- Setelah jendela ditutup: real config_open IPC dari WebView membuat ulang konfigurasi dan React heading/kontrol terdeteksi.
- Tiga permintaan bersamaan sukses memakai jendela yang sama.
- Script final dijalankan ulang dan ketiga pemeriksaan PASS.
- `cargo test --lib config::tests`: 3 lulus. Binary debug berhasil dibangun setelah instance lama yang mengunci executable dihentikan.
- `bun run tauri build --no-bundle`: TypeScript, frontend dan release berhasil.
- Aplikasi nyata dijalankan dengan `bun tauri dev` dan port diagnostik WebView lokal sementara. Real `config_open` IPC selesai; halaman `index.html?settings` mencapai readyState complete, heading Atur notch Anda, 12 input, dan field lokasi cuaca terdeteksi. Tiga IPC bersamaan juga selesai.
- `previews/nook/settings-fixed-native.png` adalah screenshot halaman dari WebView aplikasi sebenarnya, bukan browser fixture.
- Tes tidak menyimpan preferensi atau meminta izin lokasi. Instance native pengujian berhenti otomatis.
- Proses lama PID 15788 yang memiliki jendela putih ditutup. Instance lama PID 11540 kemudian ditutup karena mengunci executable debug sehingga build tidak bisa ditulis.

Pemeriksaan visual Computer Use selanjutnya dihentikan ketika desktop Windows terkunci. Readiness DOM/IPC di atas sudah terverifikasi pada WebView native; tidak mengklaim pemeriksaan klik visual pada desktop terkunci.

Pemeriksaan visual dilanjutkan setelah pengguna membuka kunci desktop:

- Executable release dibuka dan konfigurasi diperiksa langsung dengan Computer Use. Halaman tampil normal dengan judul dan kontrol fitur.
- Scroll native sampai lokasi cuaca berhasil. Tombol Gunakan lokasi Windows, penjelasan izin, pencarian kota dan footer terlihat serta dapat dijangkau.
- Klik native pada input kota menghasilkan fokus `weather-city`, terkonfirmasi di WebView. Tidak mengetik atau memilih lokasi.
- Alt+F4 menutup konfigurasi; tab WebView settings hilang. Pembukaan kembali melalui IPC menghasilkan jendela baru dengan heading dan field lokasi lengkap.
- Tombol simpan tetap disabled sebelum/sesudah, sehingga tidak ada perubahan preferensi.
- `previews/nook/settings-native-weather.png` dan `settings-native-reopened.png` merekam halaman release sebenarnya. Dialog izin lokasi tidak diaktifkan dalam pemeriksaan visual ini.

Sesi dev diagnostik dan proses aplikasi yang dibuat untuk pemeriksaan akhir dihentikan setelah tes. Port 1420 bebas untuk menjalankan dev kembali. Port diagnostik hanya diberikan melalui environment proses pengujian, bukan pengaturan Windows atau konfigurasi aplikasi permanen.

Smoke example memerlukan manifest Common Controls. Helper memasangnya pada executable contoh dengan Windows SDK Manifest Tool. Pesan missing icon resource dan invalid window/class saat teardown example tercatat di stderr; readiness/IPC/concurrency tetap lulus dengan exit code 0. Ini bukan klaim bahwa seluruh log aplikasi bebas warning.

## Pemeriksaan lingkup perubahan

- R-26 PASS: kedua pintu pembukaan menjalankan perilaku native dan merender kontrol.
- R-32 PASS: native controls/fokus frontend existing dipertahankan, tidak mengubah keyboard handling.
- R-35 PASS: reproduksi Windows aktual gagal sebelum fix dan lulus sesudah fix.
- R-39 PASS: tidak mengubah label, peran, motion atau target kontrol.
- C-2 PASS: pembukaan dari IPC benar-benar mengembalikan jendela berisi kontrol.
- C-4 PASS: tutup/buka ulang dan pembukaan bersamaan diperiksa.
- C-5 PASS: membedakan test browser, test native dan warning teardown.

Perubahan backend ini mempertahankan arah visual dan palette yang sudah disetujui. Tidak menambah aset, copy produk, atau klaim aksesibilitas menyeluruh.
