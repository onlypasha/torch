# Feature and widget configuration

Right-click the notch and choose **Konfigurasi NotchApp**. The settings window
is focusable and independent of the transparent overlay. Reopening the menu
focuses the existing settings window. Closing it releases that webview.

Features: media, Tray, Sharing, Windows notifications, and device activity
(charger, network, Bluetooth and USB). Widgets: Quick Settings, system monitor,
calendar, Pomodoro, lyrics and weather. Sharing requires Tray. Lyrics requires
media. The light preset keeps Tray, Quick Settings and calendar.

**Simpan dan mulai ulang** writes `features.json` in Tauri's app configuration
directory, then restarts the app. Defaults preserve all existing features.
Disabled native services are skipped during setup. Disabled hooks do not
subscribe or request snapshots; disabled widgets are excluded from Nook.
Disabling the lyric widget hides only its card. Media Control keeps its inline
lyrics and shares the same lyric lookup with the card when both are shown.
Disabling Media suppresses lyric fetching, the media listener and animation
clock. Device activity watchers are skipped when
disabled. The window and core notch interactions remain available.

The settings entry uses lazy loading and does not mount the overlay models.
Main and settings webviews load configuration before mounting UI.

Verification: production frontend build, native debug build, 129 frontend
tests and 67 native tests passed (11 manual probes ignored). Browser QA checked
visual layout, light preset, save payload, Sharing/Tray dependencies, an empty
Nook with all services disabled (zero service IPC calls), and default-profile
WhatsApp photo behavior. Native tests verify defaults and serialization of
disabled features/empty widgets. No user preferences were changed by QA.

Memory savings depend on selected features and WebView2's own allocation.
This change does not claim a fixed reduction in MiB.

## Inline lyrics correction, 15 November 2026

Reproduced with `tests/nook-ui.html?no-lyric-widget` and
`runNookScenario("media-lyrics-independent")`: the lookup count was zero and
Media displayed only the unavailable notice. The shared lookup was gated on
the optional widget. It now follows the Media feature; widget selection still
controls only which cards appear in the stack.

Browser regressions passed with mocked lyric responses and native IPC:

- Lyric card disabled: synced words remain in Media and follow a position change;
  plain words also remain visible.
- All cards disabled: the same checks pass with Media alone at 376px.
- Media disabled: no lyric requests occur and Media remains absent.
- Both consumers enabled: one lookup serves both, their current lines agree,
  and an old song's late response cannot replace the new song's lyrics.

All 130 frontend tests and the production frontend build passed. No new visual
elements or controls were added. The regression probes never contact LRCLIB
or change user preferences.

`bun run tauri build --no-bundle` also succeeded with the updated frontend
embedded in `src-tauri/target/release/notch-app.exe`.
