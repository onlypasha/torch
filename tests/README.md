# Activity indicator checks

## Panel tabs (open notch)

`bun test tests/panel.test.ts` covers the tab order and the direction helper.
The open shell lives in `src/Panel.tsx` + `src/tabs.ts`; Tray, Sharing and
Notification remain empty placeholders for the widget specs that follow later.

Open `http://localhost:1420/tests/panel-ui.html` in an isolated browser at
**700×320** (the desktop window's logical size; a smaller viewport clips the
520px panel) and run `await runPanelScenario("open")`. Other cases: `next`
(Nook→Sharing slide right), `prev` (Notif→Nook slide left), `outside`
(click-outside closes back to 200×34). Samples are retained in
`window.__panelProbe`. Load the page again between scenarios: tab state is
component state and each scenario assumes a fresh Nook start.

## Nook (media, widgets, pins)

`bun test tests/nook.test.ts` covers the media formatting/artwork merge, stack
rotation and slots, the pin limits and reordering, the Monday-first calendar,
the lyric window and the Pomodoro clock.

`src-tauri/src/media.rs` is the real Windows media session
(`GlobalSystemMediaTransportControlsSessionManager`): it polls whichever app
Windows considers current, emits `media-state` (including album art once per
track) and executes previous/toggle/next on the same thread. The passive probe,
which does not start or control playback, is:

```sh
cargo test --lib media_windows_probe -- --ignored --nocapture
```

For the animated layout, open `http://localhost:1420/tests/nook-ui.html` at
**700×320** and run `await runNookScenario("media")`. Other cases:

- `stack` — wheel cooldown, slot order, only-active-card interactivity, arrows.
- `pin` — context menu, 520→642 widening, tab persistence, unpin.
- `pinlimit` — two pins split the column, third pin disabled, drag reorder.
- `timer` — Pomodoro runs across tabs, pinned click pauses/resumes, border.
- `menu` — Escape/outside, Shift+F10, ContextMenu key, native menu untouched.
- `collapsed` — wide panel closes to 200×34 and reopens at 520 without pins.

`showcase0`, `showcase`, `showcase2`, `showcase3` leave the panel in a state
worth screenshotting (media only, one pin, two pins with a running Pomodoro,
open pin menu). `media` is exercised by emitting `media-state`, so the browser
fixture never needs a real player; the widget text, timing and pin state are
the production components.

Lyrics have no source in the Windows media session, so the app shows
"Lirik belum tersedia" (the three-line motion is kept behind
`LYRIC_SOURCE_AVAILABLE` for a future source). Weather remains sample data.

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
