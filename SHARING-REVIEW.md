# LocalSend inside Sharing

Reference: the user's original WPF project at `C:/Development/NotchApp`.
This is a complete source tree, so the reverse-engineer-anything skill routes
the investigation through normal repository tools. No REA provider was needed.
The WPF app was not executed during this implementation.

## Evidence and adaptation

| Original source (relative to NotchApp) | Observed behavior | Tauri implementation |
| --- | --- | --- |
| `Services/LocalSendConstants.cs:10–13` | LocalSend v2, UDP multicast 224.0.0.167:53317, /api/localsend/v2 | Same protocol and discovery group. |
| `Services/LocalSendDiscovery.cs:54–107`, `:112–169`, `:229–289` | Per-interface discovery, registration response, manual IP, stale peer expiry | Multicast discovery, metadata callback server, refresh, five-minute expiry and manual IP. |
| `Services/LocalSendIdentity.cs:21–39`, `:55–71` | Persistent certificate and SHA-256 fingerprint | Persistent self-signed identity under app data. Actual callback port is advertised if 53317 is occupied. |
| `Services/LocalSendSender.cs:65–125`, `:170–220` | prepare-upload metadata → receiver session/token → streamed upload | Explicit send, receiver approval, bounded file streams and per-byte progress. Sequential uploads bound memory; original used two parallel uploads. |
| `Controls/ShareControl.xaml.cs:66–72`, `:131–184`, `:210–220` | Tray selected files or all files, explicit Send button, cancel | Tray is the only file store. Sharing uses all eligible Tray files by default, or the selection from “Kirim file lewat LocalSend”. |
| `Services/LocalSendService.cs:31–68` | Transfer survives view changes | Native retained transfer survives tab changes/collapse; source files remain in Tray. |

Protocol compatibility was also checked against the existing local official
LocalSend core sources under `C:/Development/reverse-engineering/localsend`.
The source target remains the user's original NotchApp.

## Deliberate fixes to the original behavior

- HTTPS peer identity is checked during the TLS handshake before metadata or
  file bytes are sent. The client supplies its own certificate as expected by
  LocalSend. Discovery supports self-signed identities; file sends pin the
  selected peer's fingerprint. Redirects and system proxies are disabled.
- Cancellation remains cancellation, including during receiver approval. The
  remote cancel endpoint is called to dismiss the pending request/session.
- Unknown response file IDs do not cause unrelated files to be uploaded or an
  empty upload to be reported as success. Partial acceptance is stated.
- Changed/missing files are rejected instead of silently omitted.
- A callback port conflict uses a different bound port and advertises it.
- The original server automatically accepted incoming files into Downloads.
  This port implements the requested **send-file** feature; incoming transfers
  are refused. It does not write unsolicited downloads.

## Design plan and critique

The content must fit the existing 640×200 notch and 148px body. Retain the
Segoe UI family and compact scale: 11px headings/names, 10px secondary text,
9px device alias. Colors: black shell #000000, device surface #111114,
secondary #9295a2, source text #d9dce5, action accent #b9d2ff and error #ffd0c8.

```text
  Tray icon / file count / total                         Buka Tray
┌ Perangkat sekitar                             alias / IP / refresh ┐
│ device / address / Kirim           device / address / Kirim         │
│ or receiver / approval             progress / bytes / Batal         │
└─────────────────────────────────────────────────────────────────────┘
```

The user's revision removes the separate file well and its queue. A compact
source strip summarizes the live Tray, with a Buka Tray action for editing it.
The remaining width belongs to a two-column device list, or recipient and
progress during a transfer. This removes a duplicated storage concept and
gives device names more space. There are no invented sample peers in production.
Main actions are explicit Kirim buttons beside each device.

Ctrl+V imports Explorer files only in Tray. Sharing has no paste handling, file
list, drop area, or file mutation commands. The non-activating Windows overlay
uses the existing scoped Tray keyboard hook. Manual IP
uses the small IP button with a tooltip explaining copying the destination IP
first, so no editable field needs to steal focus from the user's application.

Every native file drop opens Tray, including when Sharing was open. Sharing
resolves current Tray IDs at Send time and freezes the resulting metadata for
that transfer. Removed or unavailable selections cannot fall back to sending
other files. A “Semua file” action explicitly restores the all-files mode.
Source files and Tray entries are preserved after sending or cancellation.

## Verification and limitations

- Production frontend build and Cargo check passed.
- Full regression suites: 125 frontend tests and 53 native tests passed;
  9 optional hardware tests remain ignored.
- Native loopback tests cover streamed contents/progress, original-file
  preservation, refusal, invalid tokens, cancellation before/after approval,
  mutual TLS success and wrong-certificate rejection before HTTP request data.
- Browser fixture: empty, Tray paste, discovered devices, explicit send,
  byte progress, cancellation, confirmed success, drops routed to Tray, selected
  sends, removed selections, cleared Tray, view remount and errors passed at
  800×320. Screenshots were inspected.
- UI fixtures mock native/network boundaries and use clearly isolated test
  peers. No user files were sent to discovered devices during testing.
- Physical interoperability still requires a user-controlled transfer to a
  LocalSend device. Discovery may depend on LAN multicast/firewall settings;
  manual IP registration is available when multicast is unavailable.
- This implementation sends up to 128 regular files. Compress folders to ZIP
  before staging them. Receiving files and full subnet scanning are not exposed.
