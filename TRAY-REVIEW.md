# Tray: boring.notch Shelf → Windows notch

28 October 2026. Target: `C:/Development/reverse-engineering/boring.notch`.
This target contains complete Swift sources. The REA skill routes complete
source trees through repository tools; no decompiler/provider was installed.
Findings below describe static source behavior, not an observed macOS runtime.

## Source findings

Paths below are relative to the target's `boringNotch/components/Shelf/`.

| Behavior | Evidence | Windows adaptation |
| --- | --- | --- |
| File bookmarks, text, links | `Models/ShelfItem.swift:11`, `:51` | Absolute file references plus file/folder metadata, text, HTTP(S) links. File contents are never copied into app storage. |
| Drop priority | `Services/ShelfDropService.swift:25` | Native Tauri file drops; Windows clipboard file lists/text; clipboard URLs classified as links. Browser text/URL drops also accepted where WebView2 delivers DOM events. |
| Duplicate identity / stable insertion order | `ViewModels/ShelfStateViewModel.swift:32`, `Models/ShelfItem.swift:190` | Canonical file paths; duplicate references ignored; existing items remain first. |
| Automatic persistence | `ViewModels/ShelfStateViewModel.swift:14`, `Services/ShelfPersistenceService.swift:19`, `:73` | Versioned snapshot in app-data `tray.json`, flushed temporary file replaced through MoveFileExW. Failed save does not replace in-memory state. Corrupt storage is preserved and reported. |
| Remove leaves originals alone | `Models/ShelfItem.swift:143`, `ViewModels/ShelfStateViewModel.swift:49` | Remove/clear change only the registry. Missing files remain visible/removable with an unavailable label. |
| Horizontal rack and drop invitation | `Views/ShelfView.swift:19`, `:66`, `:94` | Full-width horizontal shelf, highlight on targeted drop, actual empty state without demo content. Add via drag or Ctrl+V. |
| Selection and opening | `ViewModels/ShelfSelectionModel.swift:38`, `ViewModels/ShelfItemViewModel.swift:100`, `Services/ShelfActionService.swift:15` | Single selection, Ctrl-toggle, Shift range, double-click open, toolbar open/reveal/copy/remove, Ctrl+A/C and Delete when focused. Text open copies its content. |
| Dragging selected files out | `Views/ShelfItemView.swift:222`, `:255`, `:294`, `:327` | Thresholded native OLE file drag carrying the selected paths, copy-only. No automatic removal. Text/link drag uses DOM payloads where supported. |

The separate macOS Quick Share tile, Quick Look, image editing, compression,
and Open With are not represented by placeholder actions. Per user feedback,
the initial add/paste tile has been removed; Ctrl+V pastes into the active Tray.

## Design plan and review

### Visual pass following the user's closer-reference request

Re-read `Views/ShelfView.swift:66–126`, `Views/ShelfItemView.swift:33–46,
113–173` and `ViewModels/ShelfItemViewModel.swift:35–40`. Observed values now
adapted directly: 16px shelf radius, 3px round-ended dashed stroke with 10px
dashes, 8px item spacing, 56px preview, 12px two-line filename, 12px tile radius,
15% selection fill and stronger accent selection outline. The permanent title,
count, dark inner card and file size/type row were removed from the visual rack.
Actions appear on hover/selection. The separate share/add tile stays omitted
per the user's earlier instruction; Ctrl+V remains the paste route.

Windows Shell now supplies actual file/folder thumbnails or registered icons
through `tray_preview.rs`; 112px bitmap results display at 56 logical pixels.
The frontend loads visible/adjacent items lazily and caches at most 64 previews;
Shell rendering is serialized on a background worker. Unavailable previews use
the existing type glyph. These previews are generated locally, not downloaded.

Verification: production build and Cargo check passed; preview encoding tests
passed. A real Windows executable icon was extracted successfully, inspected,
and decoded by Chromium at 112×112. Browser measurements confirmed 56px previews,
12px filenames, 8px gaps and 10px dash lengths at an 800×320 viewport. Empty,
filled, selection/copy, paste scope, remount, drop, remove, error and auto-open
scenarios passed. Visual inspection used the Windows/browser implementation;
the macOS reference's runtime appearance remains inferred from its source.

The existing 640×200 black notch is the primary constraint, with 148 pixels
available below its tab bar. Preserve its type family and window geometry.

- Palette: shell `#000000`, shelf `#0e0e10`, source tile `#17171a`, text
  `#f4f4f6`, secondary text `#91929d`, selection `#b9d2ff`.
- Type: inherit the existing notch family; 12px empty prompt, 11px toolbar,
  10px two-line filenames and 9px file metadata. Reserve color for type and
  selection rather than large decorative surfaces.
- Layout: one full-width shelf. Names
  align beneath a restrained file-type glyph; actions align right in the shelf
  toolbar. The rack scrolls horizontally rather than resizing the native window.

```text
┌ Tray / selected count                       actions ┐
│ document     image      folder       link     text  │
│ filename     name       name         name     name  │
│ type/size                                          │
└────────────────────────────────────────────────────┘
```

The reference's separate share tile is omitted to give the entire panel to files.
The shelf uses native-looking document glyphs instead of invented thumbnail
previews. Screenshot review at 800×320 confirmed the empty/filled states fit
the existing silhouette, without increasing the window or obscuring navigation.

## Implementation

- `src/tray.ts`: wire types, metadata formatting and selection rules.
- `src/useTray.ts`: retained state, revision-ordered updates, native operations,
  busy/error feedback, scoped Ctrl+V handling and drag state.
- `src/TrayTab.tsx`, `src/TrayTab.css`: shelf UI and interaction.
- `src/App.tsx`, `src/Panel.tsx`: native drag routing and tab integration.
- `src-tauri/src/tray.rs`: persistence, file metadata, picker, clipboard,
  Shell open, Explorer reveal and outgoing OLE file drag.
- `src-tauri/src/tray_drop.rs`: OLE landing surface for drag-to-open while the
  main window is click-through. The 1/255-alpha non-activating popup exists only
  near the collapsed notch during a held-button drag. CF_HDROP validation opens
  Tray; Drop extracts paths and routes them to the retained model. Nothing is
  imported merely on hover. Escape/release hides the landing surface.

Limits: 128 entries and 64 KB per text entry. Save/remove never delete the
originals. Clipboard reads occur only on Ctrl+V while Tray is open. The scoped
Windows keyboard hook is needed because WS_EX_NOACTIVATE keeps focus in the
underlying app. It consumes the handled V press/repeats/release and emits one
paste request; other tabs and a collapsed panel leave Ctrl+V to Windows.

## Verification and remaining boundaries

Drop feedback: `TrayDropRipple.tsx` overlays a clipped, non-interactive wave on
the whole notch. Hover uses a subdued repeating wave; a successful file-path
import triggers a 700ms success wave. Duplicates, failed imports, and clipboard
paste do not trigger success feedback. Reduced motion uses a 180ms opacity flash.
Animation completion and an 800ms fallback both remove the transient element.
The browser `ripple` scenario passed under normal and reduced-motion preferences.

- Production frontend build and `cargo check --bins` passed.
- `bun test tests`: 123 passed.
- `cargo test --lib`: 36 passed, 8 hardware/manual probes ignored.
- Native storage tests round-trip references, replace existing JSON, and verify
  clearing metadata leaves the original file untouched. Missing paths are
  marked unavailable. Text bounds and allowed link schemes are covered.
- Browser fixture at 800×320: empty, filled, range selection/copy, remount,
  native drag event routing, duplicate drop, remove and error state passed.
  It uses real components with native boundaries mocked.
- OS picker, clipboard transfer, Shell launch/reveal and outgoing OLE drag
  compile against Windows APIs but still require end-to-end desktop checking.
  Browser fixtures are not proof of a physical Explorer transfer.
- Dragging a file onto the collapsed notch now opens Tray automatically.
  A dedicated OLE target handles the original bar area until the gesture ends;
  the expanded shelf continues to use Tauri drop events. Ordinary mouse drags
  without a file data object do not open Tray. Listener subscriptions stay alive
  through tab switches so a quick release does not fall into a subscription gap.
- Three native drag tests pass: movement/cancellation state, negative screen
  coordinates/approach bounds, and a real Shell IDataObject round-trip through
  DragEnter/DragOver/Drop without changing the source file. Browser `auto-open`
  verifies collapsed → Tray → imported item. A physical Explorer gesture still
  requires desktop checking after the native binary is rebuilt.
- Outgoing Shell data objects now explicitly include CF_HDROP; the Shell ID-list
  object alone did not render this format in testing. Implementation follows
  Microsoft's [Shell data-object contract](https://learn.microsoft.com/en-us/windows/win32/shell/dataobject)
  and [clipboard file-list format](https://learn.microsoft.com/en-us/windows/win32/shell/clipboard).
- DOM text/link drag behavior depends on WebView2/native drop interception;
  the native Ctrl+V action provides an input route without requiring
  keyboard focus in this non-activating overlay.

Checklist: source trace, ownership/persistence, reference comparison, Windows
implementation and automatic verification completed. Full macOS action parity
and the desktop transfer boundaries above remain explicitly unverified.
