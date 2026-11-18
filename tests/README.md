# Activity indicator checks

## Configuration

`tests/nook-ui.html?no-lyric-widget` plus
`runNookScenario("media-lyrics-independent")` checks that synced and plain
lyrics remain in Media Control when the lyric card is disabled. Use
`?no-widgets` for Media alone with all cards disabled. Combine
`?no-media&no-lyric-widget` with `runNookScenario("media-disabled-no-lyrics")`
to check that turning off Media still suppresses lyric lookups. Lyric responses
in these probes are mocked; no external lyric service is contacted.

`tests/nook-ui.html?no-media` plus `runNookScenario("no-media")` verifies
the 276px widget-only shell and native hit rectangle, the 388px pinned size,
640px other tabs, pin/unpin and reopening. The standard `compact` scenario
continues to check the 640/752px sizes with Media enabled.

`tests/settings-ui.html?settings` opens the configuration with mocked native
storage. `?disabled` opens the notch with all services and widgets disabled.
Check the light preset, Sharing/Tray dependency, save payload and keyboard
switches. The disabled fixture should show only Nook and make no media,
notification, sharing or tray IPC calls. Native defaults/round trips are
covered by `cargo test --lib config::tests`.

## Windows notifications

`cargo test --lib notifications::tests` verifies permission changes, live inbox
reconciliation and scoped dismissal without reading or deleting actual user
notifications. `bun test tests/notifications.test.ts` covers relative time.
Open `http://localhost:1420/tests/notifications-ui.html` at 800×320 and run
`runNotificationScenario` sequentially with `permission`, `arrival`, `queue`, `closed`, `lifetime`, `filter`,
`dismiss`, `clear`, `denied`. The fixture uses fabricated notifications and
mocked IPC. Actual Windows access requires a package identity declaring
`userNotificationListener`, plus explicit user permission.
After `permission`, `filter-keyboard` checks focus entry/Escape restoration;
`photo` checks a late WhatsApp image in the active and collapsed notches and
the initials fallback for an invalid image. `cargo test --lib notifications::avatar`
checks exact ID/app/time matching, XML extraction and source validation.
The ignored `live_database_payload_probe` reads only an active WhatsApp toast,
prints sanitized match/fetch status, and contacts its approved image host.
`collapsed-preview` checks sender/app text, hidden body, clock replacement and
containment and native hit testing in the 300×46 notification shell.
`spring-close` samples elastic settling and reverses a close in flight;
`notification-size-cycle` checks HUD priority, panel-to-notification closing,
and expiry back to 200×34 idle. Check these in normal and reduced-motion modes.
`interruption-fit` checks 12px padding around the existing 520×132 card,
the matching 544×156 native hit area, and restoration of the underlying tab
after local dismissal. Run it after `permission` in both motion modes.

## Weather

Native settings-window regression: run `bun run build`, then
`powershell -File scripts/Test-SettingsNative.ps1`. This requires Windows SDK
Manifest Tool. It builds a small Tauri example using the real config module and
embedded frontend, initiates the same UI-thread boundary as the native menu,
waits for the React heading and controls, closes/recreates settings through real
`config_open` IPC, and checks concurrent opens. A 20-second watchdog fails an
unrendered window. It does not save settings or request location permission.
The helper supplies the example's Common Controls/application manifest; running
the raw Cargo example without that manifest is not the supported test command.

For Windows startup/identity regressions, run `powershell -File scripts/Test-NotchLaunch.ps1`
from the repository root. Add `-Executable <absolute release exe path>` to check
release too. The probe creates a suspended process and terminates it before app
code executes; it checks native activation without opening a window or requesting
notification/location data. The updater must run while NotchApp is closed and
preserves its existing registered external location by default.

`bun test tests/weather.test.ts` covers provider nulls, zero/negative temperature,
future timestamps, city timezones across midnight, cached and shared requests,
retry and location/mode changes. `cargo test --lib config::tests` checks backward
compatibility and persisted coordinate validation.

`cargo test --lib weather::tests::live_provider -- --ignored --nocapture` contacts
the public provider with the test city Jakarta. It does not read device location.

Open `/tests/weather-ui.html` and run `runWeatherScenario('ready')` to verify the
current response, four future hours, source attribution, shared pin data and one
request under StrictMode. Fresh `?mode=unset`, `error`, `stale`, or `disabled`
fixtures use scenarios of the same name. A fresh default fixture also supports
`refresh-failure`, which advances its local test clock to check failed refresh
retention and subsequent recovery. These are fabricated provider fixtures.

`?settings&mode=unset` supports `settings` for manual search/selection/save and,
after reloading, `windows-settings` for denied/allowed permission and persistence.
Actual Windows consent is tested interactively in the foreground settings window;
the browser fixture never requests system permission.

## LocalSend Sharing

Reference/design notes: `SHARING-REVIEW.md`. `bun test tests/sharing.test.ts`
checks progress and sizes; `cargo test --lib sharing::tests` exercises protocol
and TLS with loopback mock receivers. It does not send user files to LAN peers.

Open `http://localhost:1420/tests/sharing-ui.html` at **800×320**. Run
`await runSharingScenario("empty")`, then `stage`, `transfer`, `success`, `drop`,
`selection`, `persist`, and `error` in order. The network boundary is mocked, while the real
React components and retained model run. For desktop verification, open Sharing,
open LocalSend on a second LAN device, add a harmless test file to Tray, then explicitly
click Kirim and accept it on the receiver. Also check cancellation and rejection.

## Windows z-order

`cargo test --lib window_z_order_tests` from `src-tauri` uses an invisible test
window to demote/re-raise the overlay twice and checks WS_EX_TOPMOST, retained
geometry, WS_EX_NOACTIVATE and unchanged foreground window. Initial placement
now sets HWND_TOPMOST explicitly; expanded `set_notch_hit` reasserts it after
the click-through style change, before the frontend starts opening.

## Tray

Native thumbnail encoding: `cargo test --lib tray_preview::tests` from
`src-tauri`. Optional desktop icon extraction: add `-- --ignored --nocapture`
and filter `windows_shell_icon_probe`. Preview requests are lazy and null/error
results retain the type glyph. Visual reference dimensions are recorded in
`TRAY-REVIEW.md`.

`TRAY-REVIEW.md` records boring.notch source evidence, Windows adaptation, design
decisions and verification limits. `bun test tests/tray.test.ts` checks selection
and metadata; `cargo test --lib tray::tests` checks persistence and file ownership.

Open `http://localhost:1420/tests/tray-ui.html` at **800×320**. Run
`await runTrayScenario("empty")`, then `filled`, `persist`, `drop`, `remove`,
and `error` in that order. Only the native boundaries are mocked. File picker,
clipboard, Explorer open/reveal and outgoing file drag require a desktop run.
The native shelf is stored in app-data `tray.json`; remove/clear must leave
the original files untouched. `await runTrayScenario("auto-open")` also checks
file hover opens the collapsed notch directly into Tray and imports the released
file. `cargo test --lib tray_drop::tests` verifies the native OLE data path and
gesture cancellation. A physical Explorer drag needs a rebuilt desktop app.
The Tray has no add/paste buttons. `filled` uses Ctrl+V, and `paste-scope`
checks that native paste requests are accepted in Tray and ignored on Nook.
The desktop keyboard hook routes Ctrl+V only while the open Tray is active.
`await runTrayScenario("ripple")` checks hover/drop feedback, automatic cleanup,
and that duplicates/failed imports do not play the success ripple. Run with both
normal and reduced-motion media preferences.

Media/lyrics comparison and implementation notes: `MEDIA-LYRICS-REVIEW.md`.
The browser media fixture also supports `plain-marquee`, `synced-marquee`, and
`song-transition-clock` through `runMediaRegression(...)`. The transition case
starts a different track at zero and repeats its unchanged timeline snapshot;
both progress and synced lyric text must advance automatically.

## Panel tabs (open notch)

`bun test tests/panel.test.ts` covers the tab order and the direction helper.
The open shell lives in `src/Panel.tsx` + `src/tabs.ts`; Tray, Sharing and
Notification remain empty placeholders for the widget specs that follow later.
The header is icon-only (30×24 targets with `aria-label`/`title`), and the
Quick Settings and power-menu buttons are SVG glyphs with no visible labels.

Open `http://localhost:1420/tests/panel-ui.html` in an isolated browser at
**800×320** (the desktop window's logical size; a smaller viewport clips the
640px panel) and run `await runPanelScenario("open")`. Other cases: `next`
(Nook→Sharing slide right), `prev` (Notif→Nook slide left), `outside`
(click-outside closes back to 200×34). Samples are retained in
`window.__panelProbe`. Load the page again between scenarios: tab state is
component state and each scenario assumes a fresh Nook start.

## Nook (media, widgets, pins)

`runNookScenario("widget-redesign")` checks the redesigned utility widgets:
fixed-slot containment, 44px controls, system-monitor error recovery, DND,
lock and power mock actions, Back and Escape. Also run it with reduced motion.
The calendar ribbon now uses 44px cells; inline Media lyrics are unchanged.

`await runNookScenario("calendar")` checks the boring.notch-style date wheel,
date selection, return to today and scroll isolation. Reference evidence and
the current agenda limitation are in `CALENDAR-REVIEW.md`.

The model and last selected tab live in `App`, so collapse only unmounts the
view: widget selection, pin order and Pomodoro survive until the app exits.
This does not persist state across restarts. Click the duration inside the
Pomodoro ring to cycle focus (25), short break (5) and long break (15 minutes).
Only Calendar, Pomodoro and Weather can be pinned; Quick Settings, System
Monitor and Lyric stay in the rotating stack.

`bun test tests/pomodoro.test.ts` covers the 25/5/15-minute mode cycle, deadline
catch-up, pause/resume/reset/restart, and the three-second completion feedback.
`bun test tests/nook.test.ts` covers the media formatting/artwork merge, the
seek geometry and the shuffle/repeat cycle, the stack rotation and slots, the
pin limits and reordering, the Monday-first calendar, and the Pomodoro clock.
`bun test tests/lyrics.test.ts` covers LRCLIB parsing, choosing between
performances of the same song, preferring a version that matches a `live`/
`acoustic` title, plain-only answers, and the fetch cache.

`src-tauri/src/media.rs` is the real Windows media session
(`GlobalSystemMediaTransportControlsSessionManager`): it polls whichever app
Windows considers current, reads the timeline position from Windows' own
`LastUpdatedTime`, stamps the payload with `sampledAtMs`, verifies seeks against
the session and track they were sent to (with the pause/seek/resume fallback),
and emits `media-state` plus `media-seek`. The passive probe, which does not
start or control playback, is:

```sh
cargo test --lib media_windows_probe -- --ignored --nocapture
```

The seek path - direct change, verification, and the pause/seek/resume fallback -
can be checked against the current player; it moves playback five seconds ahead:

```sh
cargo test --lib media_seek_probe -- --ignored --nocapture
```

`src-tauri/src/volume.rs` drives the default render endpoint through Core
Audio, so the volume row in Quick Settings is the same volume the Windows
flyout changes:

```sh
cargo test --lib volume_windows_probe -- --ignored --nocapture
```

For the animated layout, open `http://localhost:1420/tests/nook-ui.html` at
**800×320** and run `await runNookScenario("media")`. Other cases:

- `compact` — 640×200 base, 752×200 pinned, fixed 352/252/100px columns, 96px artwork, icon-only header, all media rows fit, native hit rect follows the shape, outside click still closes to 200×34.
- `stack` — immediate touchpad response, long decaying momentum is ignored, a new push during momentum advances once, slot order, only-active-card interactivity, arrows.
- `stack-scroll` — nested lists keep wheel input until their edge; zoom/horizontal gestures are not consumed.
- `quicksettings` — both slider mousedowns reach the range inputs (the shell must not cancel them), mute keeps the endpoint level, `volume_set` carries the dragged level, and `brightness_set` reaches the panel after the drag throttle.
- `hud` — a volume/brightness reading takes the 300×46 bar with 22px corners and 12px ears (no glow), the clock steps aside, mute empties the bar and greys the speaker, the hold collapses fully to 200×34, and a reading never closes the open panel.
- `quicksettings-unsupported` — open the page with `?brightness=unsupported`; the brightness slider is disabled and reads `—` instead of inventing a number.
- `pin` — context menu, 640→752 widening, tab persistence, unpin.
- `pinlimit` — two pins split the column, third pin disabled, drag reorder.
- `timer` — Pomodoro runs across tabs, pinned click pauses/resumes, border.
- `timer-modes` — WPF's 25/5/15-minute modes, changing mode stops/reset, selected duration and running/paused deadlines survive collapse, timer outranks media, indicators fit without moving the clock.
- `timer-finished` — accelerated wall clock completes a session while collapsed; confirmation lasts three seconds, media returns, restart uses the selected duration. The test restores `Date.now` afterwards.
- `retained` — last tab, widget selection and reordered pins survive collapse; non-Nook views and closed panels reduce native media polling.
- `island` — idle/playing/paused media keep the clock centred on both axes in the unchanged 200×34 bar.
- `menu` — Escape/outside, Shift+F10, ContextMenu key, native menu untouched.
- `collapsed` — wide panel closes to 200×34, shows the playing badge, and reopens directly at 752 with its pins and active widget retained.
- `seek` — drag preview, one seek per release, optimistic hold, rejection notice.
- `seek-close` — collapse during a preview discards the abandoned drag without seeking; reopening displays the player's real position.
- `seek-guard` — a seek carries a request token and the track it was built for; an older answer is ignored, and a track change drops the held target.
- `shuffle` — shuffle/repeat commands, player-reported state, hidden controls.
- `lyrics` — delayed LRCLIB answer survives position polls, rows advance, temporary missing metadata recovers, old-song answers are ignored.
- `lyrics-plain` — untimed words render as one static block (never as timed rows), and a duration arriving after the first lookup asks the service again.
- `lyrics-timeout` — a stalled request reports failure after seven seconds instead of staying in loading.
- `lyrics-layout` — long active lines wrap to two compact lines; fixed slots stay inside 252×148 during transitions; pinned lyrics fit with two pins. `lyrics-layout-showcase` leaves the full lyric card visible for screenshots.

### Media regression checks

The same Nook fixture also exposes `await runMediaRegression("cancel")` from
`tests/media-ui-regressions.js`. These checks use the production hook and seek
component, paused timelines for deterministic assertions, and mocked Windows
events/network responses. Keep the browser tab foreground at **800×320** so
timer and animation throttling cannot affect the result. Success returns
`{ scenario, ok: true }`; a failed assertion rejects with its exact reason.

- `cancel`, `lost-capture` — discard a drag without issuing a seek or leaving a preview.
- `track-change`, `track-round-trip` — a drag begun on A cannot seek B, even after A→B→A.
- `capability-change` — a revoked seek capability cancels the drag.
- `late-result`, `new-drag-old-result`, `untokened-result` — only a matching active request can change the playhead; old or uncorrelated replies cannot erase a new preview.
- `near-sample-then-result` — a timeline near the target releases the visual hold, but does not discard the request's awaited result.
- `timeout` — the three-second hold expires without requiring a new media event.
- `null-session`, `timeline-expiry` — clear the old clock and optimistic seek when the session or native timeline disappears.
- `keyboard` — ArrowRight, Home and End still send tokened seeks and settle correctly.
- `duration-correction`, `duration-jitter` — revalidate corrected lyric durations, without refetching for jitter within the duration-matching tolerance.
- `instrumental` — timed empty lines clear both the karaoke strip and active lyric row, rather than showing old words or an unavailable notice.

The native worker retains a previously valid finite timeline for the same active
track while Firefox publishes empty timeline properties, without a five-second
expiry. It clears retention on a track/session change or stopped session and
disables seek while raw timeline properties are missing. The frontend preserves
artwork only; it must not restore a missing timeline or seek capability.
`media-seek` fixture replies must echo the request token, just
like the worker does for UI-issued seeks. Tokenless manual probes are not
confirmations of a UI request.

`showcase0`, `showcase`, `showcase2`, `showcase3` leave the panel in a state
worth screenshotting (media only, one pin, two pins with a running Pomodoro,
open pin menu). `media` is exercised by emitting `media-state`, so the browser
fixture never needs a real player; the widget text, timing and pin state are
the production components.

Lyrics are fetched from LRCLIB in the webview (the service sends
`access-control-allow-origin: *`), so the widget shows timed words when the
service has them and says "Lirik belum tersedia" when it does not. The `lyrics`
scenario stubs `fetch`, so it does not depend on the network.

Touchpad checks use synthetic delta/time traces, not a physical-device capture.
Pixel wheel input is classified by decay and renewed acceleration because the
browser exposes no gesture/momentum phase. Line/page mouse-wheel input retains
the WPF-style 350ms throttle. Physical touchpads can have different delta curves;
the final interaction feel should also be checked on the user's device.

## Keyboard HUD

`bun test tests/hud.test.ts` covers the percentage, mute announcement and the
three speaker waves. The native side is `src-tauri/src/keyboard.rs` (a global
low-level hook that swallows hardware volume keys and applies 6.25% steps,
1.5625% with Shift, a 350ms hold and 90ms repeat) and `src-tauri/src/hud.rs`
(the brightness watcher). Injected keys are deliberately left alone, so
automation and other remappers keep working.

The Fn brightness keys on this ASUS panel never reach either the low-level hook
or the raw-input consumer collection; the firmware/OSD handles them first. The
notch therefore watches the LCD level every 120ms and shows the panel's own
step instead of pretending to intercept the key. Volume is written and re-read
through Core Audio, so a refused or clamped change is reported as a failure,
not drawn as success. The ignored `volume_step_windows_probe` in
`src-tauri/src/volume.rs` exercises that path on real hardware:

```sh
cargo test --lib volume_step_windows_probe -- --ignored --nocapture
```

Run `bun test tests/usb.test.ts` for the pure queue/capacity tests, and
`cargo test --lib` in `src-tauri` for the native transition tests.

The optional read-only Windows hardware probe is:

```sh
cargo test --lib usb_hardware_inventory -- --ignored --nocapture
```

It reports present USB names, storage classification and physical capacity;
it does not access user files, mount volumes or simulate plugging/unplugging.

For animation checks, start `bun run dev` and open
`http://localhost:1420/tests/usb-ui.html` in a separate browser at 480×220.
This page mounts the real app with **Tauri IPC mocks**, so desktop mouse/focus
changes cannot interfere with the timeline. It is not part of the production
entrypoint and does not replace testing real native events on hardware.

In the browser console, run `await runUsbScenario("ready")`. Other scenarios:
`late`, `timeout`, `remove`, `queued`, `panel`, `full`, `nostorage`, `long`,
`autohide`, `network`. Each throws on failed assertions and retains sampled state in
`window.__usbProbe`. Reload between scenarios (especially `full`, which leaves
Bluetooth notices queued). Use real timers; reduced motion deliberately does
not disable these animations.

For example, with agent-browser:

```sh
agent-browser --session usb-test open http://localhost:1420/tests/usb-ui.html
agent-browser --session usb-test set viewport 480 220
agent-browser --session usb-test eval 'runUsbScenario("ready")'
```

## Bluetooth

`bun test tests/bluetooth.test.ts` covers per-connection identities, cancellation,
same-name devices, and battery metadata. Native tests in
`src-tauri/src/activity/bluetooth.rs` additionally cover Classic/BLE deduplication,
startup baseline, partial Windows property updates and reconnects.

Open `http://localhost:1420/tests/bluetooth-ui.html` in an isolated browser at
480×220 and run `await runBluetoothScenario("connected")`. Other cases: `unknown`,
`late`, `zero`, `long`, `cancel`, `queued`, `full`, `panel`, `autohide`. Samples
are retained in `window.__bluetoothProbe`. These are real-timer animation checks
with mocked IPC, not proof of a physical Bluetooth connection.

Optional passive Windows watcher probe (does not open NotchApp, pair, or connect):

```sh
cargo test --lib bluetooth_windows_inventory -- --ignored --nocapture
```

It waits up to six seconds by default. Set `NOTCH_BT_PROBE_SECONDS=35` to allow
more time for initial Windows enumeration; the output reports whether enumeration
completed. Missing batteries stay unknown; the implementation only reads cached
Windows properties and does not initiate GATT reads or vendor-specific protocols.

Both browser fixtures use `mock-native.js`, which adapts the SDK mock's `id`
unlisten parameter to the API's `eventId`. This avoids stale callback warnings
during React StrictMode cleanup without changing Tauri or production IPC. The
panel fixture uses it too.
