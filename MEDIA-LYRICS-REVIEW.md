# Media dan lirik: boring.notch → TauriNotchApp

Analisis 28 Oktober 2026. Target berupa sumber lengkap di
`C:/Development/reverse-engineering/boring.notch`; sesuai skill REA, digunakan
penelusuran sumber biasa, tanpa dekompilasi atau instalasi provider.
Temuan boring.notch di bawah adalah observasi statis, bukan pengujian macOS.

## Bukti dan perbandingan

| Area | Sumber boring.notch (relatif terhadap target) | Hasil pada proyek ini |
| --- | --- | --- |
| Controller media | `boringNotch/managers/MusicManager.swift`, `boringNotch/MediaControllers/` | boring menggabungkan controller khusus macOS/aplikasi; proyek ini memakai GSMTC Windows, termasuk capability, shuffle/repeat, dan verifikasi seek. |
| Proyeksi waktu | `MusicManager.swift:567–572`, `MediaControllers/NowPlayingController.swift:240–247` | Posisi diproyeksikan dari timestamp dan playback rate; latch timeline native mengikuti rate dan kontinuitas pause/resume. Batas lima detik dihapus setelah reproduksi langsung Firefox (lihat di bawah). |
| Artwork | `MusicManager.swift:203–220` | boring membandingkan artwork walaupun judul sama. Proyek ini kini membaca ulang cover pada MediaPropertiesChanged; bytes identik tidak dikirim ulang pada polling biasa. |
| Penyedia lirik | `MusicManager.swift:343–461` | boring mencoba lirik native Apple Music, lalu LRCLIB. GSMTC proyek ini tidak menyediakan lirik native; fallback tetap LRCLIB. |
| Pencarian | `MusicManager.swift:406–425` | Normalisasi aksen Latin dan karakter replacement, lalu pencarian terstruktur track_name/artist_name diadaptasi. Album tetap dipakai pada exact lookup, tidak membatasi fallback pencarian kompilasi. |
| Pemilihan lirik | `MusicManager.swift:440–449` | boring mengambil hasil pertama. Validasi judul/artis, versi, durasi, cache, cancellation, serta fallback plain yang sudah ada di proyek ini dipertahankan. |
| Parsing dan sinkronisasi | `MusicManager.swift:463–506`, `components/Notch/NotchHomeView.swift:156–185` | Keduanya memakai pencarian timestamp. Parser proyek ini juga mempertahankan multi-stamp, global offset, dan baris instrumental kosong. |
| Tampilan | `NotchHomeView.swift:169–185` | Marquee untuk baris panjang dan seluruh teks plain diadaptasi. Widget plain tetap berupa blok; strip media kini memuat semua bait, bukan hanya baris pertama. |

Implementasi diadaptasi untuk arsitektur React/Rust, bukan menyalin controller
Swift. Fitur favorite, volume aplikasi, membuka aplikasi dari cover, dan provider
Apple Music native belum dipindahkan; sebagian membutuhkan integrasi khusus
Windows/aplikasi yang tidak disediakan GSMTC saat ini.

## Regresi pergantian lagu

Laporan pengguna: progress/lirik tertahan pada 00:00 setelah pergantian lagu.
Reproduksi deterministik menunjukkan guard sampel nol hanya melindungi anchor
dengan base positif. Lagu baru dengan base nol terus mereset titik waktu lokal
ketika sampel nol diulang. Guard kini memeriksa posisi terproyeksi sehingga
jam lagu baru dapat berjalan; publikasi timestamp baru tetap menang untuk
seek/repeat sungguhan.

Filter Emitted native juga kini membandingkan hasTimeline, publication timestamp,
playback rate, dan shuffle support. Perubahan tersebut tidak boleh hilang hanya
karena judul/durasi/posisi dalam detik masih sama.

## Verifikasi dan batas bukti

### Temuan runtime lanjutan: YouTube Music di Firefox

Probe pasif `media_transition_probe` merekam pola berikut dari player pengguna:
lagu Bertaut mulai dengan timeline kosong, sempat memberi durasi 316 detik dan
posisi 79 ms, lalu seluruh properti start/end/position menjadi nol sementara
playing=true dan rate=1. Ini berlangsung lebih dari 20 detik. Pada lagu Serana
sebelumnya juga diamati durasi valid 251 detik lalu timeline kosong.

TTL lima detik milik aplikasi adalah penyebab reset setelah sekitar enam detik.
Retensi kini mengikuti identitas track/source dan status Playing/Paused, dibatasi
durasi rekaman, bukan umur sampel. Seek dinonaktifkan selama timeline asli kosong.
Track baru, sesi hilang, atau status stopped tidak memakai timeline lagu lama.
Data valid yang kembali tersedia tetap menjadi acuan utama.

Probe kedua pada kode baru menunjukkan posisi Bertaut terus maju dari 79 ms
hingga lebih dari 21 detik walaupun timeline asli tetap kosong. Ini membuktikan
perbaikan pada pembacaan native; UI aplikasi yang sudah berjalan harus memuat
binary baru. Jika aplikasi baru dibuka setelah sampel valid yang singkat itu
hilang, durasi belum dapat diketahui sampai Firefox menerbitkannya lagi.

- `bun test tests/media.test.ts tests/lyrics.test.ts tests/nook.test.ts`: 94 lulus.
- `cargo test --lib media::tests`: 10 lulus, 2 probe manual diabaikan.
- `bun run build`: lulus (di luar sandbox karena akses dependensi).
- UI fixture nyata dengan IPC/network mock: plain-marquee, synced-marquee,
  instrumental, duration-correction, duration-jitter, keyboard dan
  song-transition-clock lulus. Marquee diperiksa pada viewport 800×320.
- Probe Windows pasif berhasil membaca sesi aktif. Sampel saat diperiksa paused;
  belum membuktikan seluruh siklus pergantian lagu pada player pengguna.
- Kode sumber dan pengujian diperbarui; aplikasi desktop yang sudah berjalan
  perlu dimulai ulang melalui build/dev baru agar memuat perubahan native.

Checklist: alur media, alur lirik, perbandingan, implementasi perbaikan, serta
regresi otomatis terjawab. Kesetaraan runtime macOS dan kontrol aplikasi khusus
masih di luar bukti yang tersedia.
