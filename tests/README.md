# Activity indicator checks

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
performances of the same song, and the fetch cache.

`src-tauri/src/media.rs` is the real Windows media session
(`GlobalSystemMediaTransportControlsSessionManager`): it polls whichever app
Windows considers current, reads the timeline position from Windows' own
`LastUpdatedTime`, verifies seeks against the session they were sent to (with
the pause/seek/resume fallback), and emits `media-state` plus `media-seek`. The
passive probe, which does not start or control playback, is:

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
- `shuffle` — shuffle/repeat commands, player-reported state, hidden controls.
- `lyrics` — delayed LRCLIB answer survives position polls, rows advance, temporary missing metadata recovers, old-song answers are ignored.
- `lyrics-timeout` — a stalled request reports failure after seven seconds instead of staying in loading.
- `lyrics-layout` — long active lines wrap to two compact lines; fixed slots stay inside 252×148 during transitions; pinned lyrics fit with two pins. `lyrics-layout-showcase` leaves the full lyric card visible for screenshots.

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
