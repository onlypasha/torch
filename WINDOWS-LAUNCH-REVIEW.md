# Error 15609 pada bun tauri dev

15 November 2026. Regresi setelah pembaruan paket lokasi Windows.

Penyebab terkonfirmasi pada mesin ini: pembaruan identity 0.1.0.1 yang ditunda memicu RegisterByPackageFamilyName saat executable diluncurkan. Log AppXDeploymentServer event 404/866 menyatakan paket harus dipasang dengan external location. Operasi gagal dengan 0x80073CF9, sehingga CreateProcess mengembalikan Win32 15609 sebelum kode aplikasi dijalankan. Versi 0.1.0.0 masih terdaftar ketika error terjadi.

Hipotesis yang diuji: perpindahan root debug/release, registrasi tertunda yang gagal, atau ketidakcocokan manifest. Log dan registrasi langsung mengonfirmasi registrasi tertunda sebagai penyebab pada kasus ini. Root lama ternyata masih menunjuk target/debug.

## Perubahan

- `Update-WeatherIdentity.ps1` menghapus deferred registration.
- Updater menolak berjalan saat NotchApp masih aktif.
- Tanpa parameter, updater mempertahankan PackageRootFolder yang terdaftar; jika belum ada registrasi, default ke target/debug.
- Setelah Add-AppxPackage, updater memeriksa versi aktif 0.1.0.1 dan DeviceCapability location.
- Paket didaftarkan langsung dengan external location target/debug. Capability notifikasi tetap ada.
- `scripts/Test-NotchLaunch.ps1` menjadi probe aktivasi Windows: CreateProcess dengan CREATE_SUSPENDED/CREATE_NO_WINDOW, lalu hanya proses probe itu diterminasi sebelum thread aplikasi berjalan. Tidak mengubah executable, membaca data notifikasi, atau meminta lokasi.

## Bukti

- Sebelum fix, probe minimal executable debug gagal: nativeError=15609.
- Probe regresi tersimpan juga gagal dengan 15609 sebelum fix.
- Registrasi langsung berhasil; versi aktif 0.1.0.1, Status Ok, capability lokasi dan userNotificationListener tersedia.
- Sesudah fix, probe executable debug PASS.
- Sesudah fix, probe executable release PASS.
- `bun tauri dev` berhasil menjalankan target/debug/notch-app.exe; WebView memuat frontend melalui Vite port 1420.
- Saat dev berjalan, updater menolak registrasi dengan pesan untuk menutup aplikasi. Proses dev tetap berjalan.
- Sesi Vite dan instance NotchApp yang dibuat untuk pengujian kemudian dihentikan; port 1420 bebas untuk perintah dev pengguna.

Tidak ada perubahan Rust, frontend, atau dependensi pada perbaikan ini. Tidak menghapus paket atau data pengguna. Pemeriksaan izin lokasi Windows aktual tetap dilakukan melalui dialog sistem ketika pengguna memilih Gunakan lokasi Windows.
