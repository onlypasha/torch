# Redesign widget Nook

Revisi berikutnya memakai arah hangat yang dipilih pemilik. Lihat
`NOOK-WARM-REVIEW.md` untuk desain dan bukti verifikasi yang sekarang berlaku.

15 November 2026. Scope: utility widgets, calendar, pinned widgets and their interaction. Media Control markup, transport, lyric logic and styling are unchanged.

Design Read: compact Windows utility widgets with Apple's hierarchy, immediate response and interruptible motion, ENERGY 1 / RHYTHM 2 / MOTION 2. The native 252 × 148 slot, scroll navigation, pin model and dynamic shell width are retained.

## Direction and decisions

- A solid #151518 surface keeps the active widget legible over the retained deck; no additional blur or decorative glow.
- #c4d7f8 marks actions, progress and selection; warning colour is reserved for high system usage and errors.
- Segoe UI remains the native Windows typeface. The countdown has tabular figures and tighter tracking; small labels use normal tracking.
- Quick Settings uses two labelled sliders and a common row of four 44px actions. Labels sit beside values so controls identify themselves without an extra title row.
- Pomodoro separates duration selection from its larger remaining-time display. Start/reset have 44px targets and immediate press feedback.
- Calendar uses 44px date cells, more readable date type, and a quieter agenda area. It still shows the existing 22-day range through a scroll ribbon.
- Current lyrics use 15px type, 20px leading and a stable two-line slot. Neighbouring lines stay smaller so the active line is easy to find.
- System rings share an accent and clear values. Initial loading and failed reads have explicit text; the existing one-second poll restores data automatically.
- Weather uses a larger temperature and a quieter hourly row. The existing static data is explicitly labelled “Cuaca contoh”, including its pin.
- Main cards have an 18px radius and pins 14px. A common frame makes scroll navigation predictable; each widget's content uses its own composition.
- The stack uses a critically damped spring. Pin insertion has no bounce or artificial delay. Reduced motion removes stack translation/scale and pin travel. Direct drag remains available.
- Plain pinned widgets can receive keyboard focus and open their context menu with Shift+F10 or the Context Menu key. Range-input arrow keys retain their native value adjustment.

Styles are isolated in NookWidgets.css using widget/stack selectors, so Media keeps its existing treatment. Existing base styles remain available to other surfaces.

## Verification

- Production frontend build passed; 130 frontend tests passed.
- Production executable build passed with `bun run tauri build --no-bundle`; updated frontend is embedded in `src-tauri/target/release/notch-app.exe`.
- `widget-redesign`: all six widgets retain 252 × 148, content fits, and enabled widget controls have 44px targets. Scrolled calendar cells are intentionally clipped by their scroll frame.
- The same case verified system-stat read failure and automatic recovery, DND on/off, lock IPC, opening power controls, all three power IPC actions, Back and Escape. Native boundaries were mocked, so no actual computer power or lock action occurred.
- `quicksettings`: both ranges, mute and native payloads pass. A real browser ArrowUp press changed volume from 64 to 65 while keeping Quick Settings active.
- `compact`: Media geometry, main/pinned widths, pin and other tabs retain their expected sizes.
- `calendar`: date selection, Today, vertical wheel mapping, isolation from widget navigation and containment pass.
- `lyrics-layout`: a long line fits its two-line slot, animation does not shift the slots, and pin limits remain intact. Type was adjusted from the first 16px draft to 15px after the long-text check caught clipping.
- Reduced motion: `widget-redesign`, `stack`, `timer-modes` and `no-media` all pass. This covers control fit, scroll momentum, keyboard navigation, timer modes, 276/388px widths, pin/unpin, tab switches and close/reopen.
- Axe active Quick Settings: 0 violations, 13 passes, 1 incomplete. Pomodoro: 0 violations, 10 passes, 1 incomplete. Contrast incompletes are due to retained overlapping cards/pseudo elements; explicit pair calculations are below.
- Computed contrast: secondary text/card 8.70:1, action text/button 11.94:1, dark text/primary action 13.04:1, date selection text/background 10.89:1.
- Browser console showed no JavaScript errors. Screenshots redesign-controls.png and redesign-pomodoro.png in previews/nook were visually reviewed.

These checks use real React components with fabricated fixture data and mocked native IPC. They do not certify every Windows device or all accessibility criteria.

## Delivery Gate

### Hard Gate

- R-02 PASS: authored interface text has no em dash.
- R-03 PASS: content fits its desktop slot, controls use 44px targets, dynamic shell widths are regression-tested. This is the native desktop overlay, not a new mobile page.
- R-17 PASS: no invented live data; static weather is visibly labelled as an example.
- R-18 PASS: no testimonials or fabricated identities.
- R-23 PASS: no new logo, avatar or illustration; existing functional icons are reused.
- R-24 PASS: existing tab and context-menu destinations remain functional.
- R-25 PASS: explicit text/background pairs meet 4.5:1; ratios recorded above.
- R-26 PASS: all changed control types were clicked and their effects verified as recorded above.
- R-27 PASS: existing unavailable lyric, disconnected agenda and unsupported controls remain; system monitor now exposes loading and read errors with recovery.
- R-28 PASS: no FAQ.
- R-32 PASS: native controls, visible focus, slider arrow operation, stack keyboard navigation and keyboard pin menus are supported.
- R-33 PASS: direct source edits; no script rewrites source/CSS.
- R-34 PASS: existing single overlay theme is retained; no additional theme toggle.
- R-35 PASS: frontend executed, built and clicked through; browser evidence recorded above.
- R-36 PASS: no security or performance claim is introduced.
- R-37 PASS: direction and dials declared before implementation.
- R-38 PASS: examples are visibly identified; no new realistic fabricated content.
- R-39 PASS: new range labels are visible and associated; controls retain names, pointer, focus and interaction states. Reduced motion is explicitly handled.
- R-40 PASS: no new remote media, font downloads or blocking third-party scripts; no field performance number is claimed.

### Purpose Gate

- R-01 PASS: restrained accent denotes selection, progress and primary action.
- R-04 PASS: existing speaker, sun, lock and power glyphs retain their functional meanings.
- R-06 PASS: native system typography; timer and lyric scale serve hierarchy and readability.
- R-07 PASS: no decorative background pattern.
- R-08 PASS: no decorative button arrows.
- R-09 PASS: no marketing badges.
- R-10 PASS: no additional blurred surfaces.
- R-12 PASS: only existing drag elevation is retained.
- R-13 PASS: no glow added to widgets.
- R-14 PASS: common frames support stable navigation, while each widget has a composition suited to its information.
- R-19 PASS: input feedback, interruptible springs and reduced-motion alternatives serve interaction, without added idle loops.
- R-22 PASS: no illustration added.

### Liveliness

- Dials PASS: 1/2/2 stated and applied.
- Consistency PASS: calm frames, varied content compositions, responsive motion.
- Focal point PASS: countdown, active lyric, temperature or values lead their widget.
- Whitespace PASS: grouping and proximity connect each value with its control.
- Accent PASS: pale blue marks meaningful action and state.
- Motif PASS: compact native utility surfaces with clear numeric hierarchy.
- Design Read PASS: recorded before generation and in this report.

### Craftsmanship and Quality Locks

- C-1 PASS: major visual choices and reasons are written above.
- C-2 PASS: changed controls retain real actions; test actions target native mocks.
- C-3 PASS: each widget supports existing product functionality.
- C-4 PASS: containment, long text, disabled Media, errors and reduced motion tested.
- C-5 PASS: data provenance is explicit; no unverifiable claims.
- R-05 PASS: content-specific compositions within an existing utility slot.
- R-11 PASS: radius distinguishes shell, cards, pins and controls.
- R-15 PASS: labels describe existing actions.
- R-16 PASS: no marketing buzzwords.
- R-20 PASS: design follows NotchApp's fixed overlay proportions and functions.
- R-21 PASS: dark surfaces belong to the existing black notch.
- R-29 PASS: neutral surfaces and one core accent, with semantic warning/error colours.
- R-30 PASS: uses Apple's interaction principles without copying another product screen.
- R-31 PASS: colour, type, layout, spacing and icon choices have written purposes.
