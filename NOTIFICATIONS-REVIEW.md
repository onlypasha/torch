# Notification tab investigation

## Reference and version boundary

The supplied `C:/Development/reverse-engineering/boring.notch` working tree is
v2.7.3. Its README still lists Notifications as under consideration. The same
local Git repository contains tag `v2.8-rc.2` (`1fa326d56b6ae7165afea934282449892e0b8164`),
and `updater/appcast.xml:44–51` describes its Notification Mirroring release.
The tag was inspected read-only with `git show`; no reference app was run.

| v2.8-rc.2 source | Observed behavior | Windows adaptation |
| --- | --- | --- |
| `boringNotch/managers/SystemNotificationManager.swift:23–30,60–97,128–186` | One active banner, queue capped at five, eight-second display, hover hold, token-safe dismissal, newest replacement. | New Windows arrivals take over the open notch one at a time, queue up to five while open, display for eight seconds while closed, and remain visible while open. Closing resumes a two-second timeout. The tab still reads the current OS inbox. |
| `boringNotch/components/Notch/NotificationLiveActivity.swift:8–67,71–161` and `boringNotch/ContentView.swift:547–553` | App icon, closed dot and ring pulse; expanded app/title/body/time, `+N` queue browse and dismiss in place of tabs. | Dedicated compact sender/app preview and a steady dot; expanded message with 46px app icon, relative time, `+N` rotation and local close. The tab uses the same single-message layout with access to the inbox. |
| `BoringNotchXPCHelper/NotificationWatcher.swift:87–103,259–287,296–334,351–436` | Accessibility observer watches visible macOS banners; Notification Center panels and widgets excluded. | Native Windows `UserNotificationListener` supplies current Toast notifications. It does not park or hide Windows banners. |
| `boringNotch/components/Settings/Views/NotificationSettingsView.swift:17–129` | Access explanation and all/selected-app filter. | Explicit permission action, truthful access state, saved all/selected-app filter based on observed app identities. |

`NotificationCenter.default` in Swift is an internal event bus, not the source
of macOS notifications. The Windows UI is a product adaptation: it also displays
the current Windows notification inbox in a tab, while boring.notch only mirrors
transient visible banners. Closing the expanded interruption changes only the
notch presentation; dismissing from the tab removes that notification from
Windows. It does not imply identical platform behavior.

The original Windows WPF project provides another reference:
`C:/Development/NotchApp/Services/NotificationService.cs:81–155,201–249` uses
`UserNotificationListener` and extracts `ToastGeneric` title/body/app data.
The Tauri port additionally verifies OS dismissal, does not treat failed reads
as an empty inbox, and does not persist message content.

## Product and interface

The tab occupies the fixed 640×148 content surface: a 26px heading and one
focused message rather than a grid of cards. An incoming message interrupts
the expanded notch and temporarily replaces its tabs, as in the reference.
Base #000000, text #f4f4f6, secondary #9295a2, action #c4d7f8 and Segoe UI
Variable follow the other tabs. The 46px app icon and message text carry the
visual priority; `+N` opens the next item in the local presentation queue.
The tab badge reports the filtered Windows inbox count. The filter panel stores
only selected app IDs, never message content. No sample notifications appear
in production.

The apple-design pass places the title above the body in visual importance,
uses a quiet inset message surface, and increases queue/close targets to 28px.
Press feedback happens immediately; message changes and the trigger-anchored
filter use non-bouncing springs without locking input. Escape and outside
pointer presses close the filter, and Escape restores trigger focus.
Reduced motion uses short opacity transitions, reduced transparency removes
backdrop blur, and increased contrast defines surface boundaries.
An incoming notification expands the collapsed notch to the same 300×46 shape
as volume/brightness, showing avatar, sender/title and app name. It temporarily
replaces clock/media status, omits message body text, and uses a steady dot.
HUDs retain priority; the notification returns afterward while still active.
Native hit testing receives the same 300×46 footprint. Shrinking the shell
uses a visibly elastic, slower spring (response about 0.44s, damping ratio
about 0.74), including panel-to-notification and expiry back to idle. Panel,
HUD and notification expansion share that rhythm. The same Motion element is
retargeted for mid-close reversal. Browser frame sampling verified undershoot,
settling and reopening during a close; normal/reduced-motion scenarios also
checked HUD priority, native hit area and the complete notification size cycle.
Reduced motion uses a short non-bouncing size transition for all shell states.

WhatsApp notifications now use the circular photo referenced by the original
toast when it can be resolved, with a small WhatsApp badge. The same component
supplies the tab, interruption and collapsed indicator. It falls back to
conversation initials or the app logo when no photo is available. The
[WhatsApp avatar investigation](WHATSAPP-AVATAR-INVESTIGATION.md) records the
read-only payload evidence, exact notification matching and resolver limits.

```text
  Notifikasi                            Aplikasi  Bersihkan  ↻
  icon  App  time                                     +N  ×
        Title
        Body
```

Opening the source app is not equivalent to invoking an action inside the
original toast. The transient interruption's close control leaves Windows'
notification intact. Dismissing and clearing from the tab remove only the
displayed notification IDs from Windows; there is no broad
`ClearNotifications` call. Permission is requested only after an explicit user
action. Revocation clears the snapshot and transient activity.

## Windows deployment requirement

Microsoft's [notification listener documentation](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/notification-listener)
requires a package manifest declaring `userNotificationListener` and explicit
user permission. The current Tauri configuration has `bundle.active=false` and
runs as an unpackaged executable in development. On such a run, the tab reports
that package identity is required; it does not show a misleading empty inbox.
For deployment, give the executable package identity and the declared
capability through Microsoft's [external-location packaging](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/grant-identity-to-nonpackaged-apps).
`src-tauri/windows-identity/AppxManifest.xml` declares the app and the
`uap3:userNotificationListener` capability; `app.manifest` is embedded by the
Tauri build, and their identity fields match. The included logos satisfy the
manifest's visual asset references. Build an identity package with Windows SDK
`MakeAppx.exe pack /o /d src-tauri\windows-identity /nv /p NotchApp.Identity.msix`,
sign it with a trusted certificate whose subject is `CN=NotchAppDevelopment`
(change Publisher in both manifests for a production certificate), and register
it with `Add-AppxPackage -Path NotchApp.Identity.msix -ExternalLocation
<directory containing notch-app.exe>`. The `/nv` option is required because the
executable lives at that external location. The development-only helper
`src-tauri/scripts/Register-DevelopmentIdentity.ps1` imports the certificate
to `LocalMachine\TrustedPeople` and registers the package; it requires an
elevated PowerShell session. The certificate private key remains in the user's
personal certificate store and is not exported. This self-signed certificate is
only for local development, not distribution.

On this machine, Windows SDK 10.0.26100 tools built and signed
`src-tauri/target/identity/NotchApp.Identity.msix`. The development certificate
was trusted in `LocalMachine\TrustedPeople` through UAC and package
`NotchApp.Identity_0.1.0.0_neutral__0jvwhazkrczhp` registered with
`src-tauri/target/debug` as its external location. A passive probe from that
exact `notch-app.exe` returned `packageIdentity=true` and
`UserNotificationListenerAccessStatus(1)` (`Allowed`). Its embedded MSIX
metadata was also verified with Manifest Tool. The developer-only
`--notification-status` switch prints identity and access status without
notification contents.

## Verification

The browser fixture `tests/notifications-ui.html` uses fabricated notification
contents and mocked IPC. It passed permission, open-notch interruption,
queue browsing, closed-notch pulse, eight-second hold while open,
two-second dismissal after closing, app filtering, dismissal, clearing and
denied-access scenarios at 800×320. Both the interruption and tab layout were
visually inspected. Frontend build and 126 tests pass.
Native build and 59 tests pass (10 optional hardware/permission probes ignored).
Native tests use in-memory state only. Their ignored passive probe originally
reported `packageIdentity=false` and `GetAccessStatus=0x80070057` because the
test binary itself is unpackaged. The registered debug executable now reports
identity and `Allowed` access. No real notification content was read, dismissed
or opened by automated tests. An end-to-end arrival and dismissal test still
requires a real Windows notification while the app is running. Browser fixture
tests cover those state transitions with fabricated messages.
