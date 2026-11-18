# Memory audit — 2026-10-31

## Findings and fixes

- Notification avatar scheduling checked the number of pending keys but did
  not skip a key already pending. Repeated polls/completions could start the
  same request again. Removing a toast or revoking permission also erased its
  pending slot before the worker stopped. Jobs now reserve a unique slot,
  capped at four, and release it only when completion arrives. Delayed results
  still require a current matching notification and allowed access.
- Native notification reconciliation cloned the full old and new inbox just
  to compare them. Comparison now borrows the data. Icon/avatar strings use
  `Arc<str>` so snapshots and caches share image buffers. Event emission also
  borrows the snapshot. Icons for apps absent from the inbox are evicted.
- The accent cache retained up to sixteen full base64 cover URLs as keys.
  The native cover limit is four MiB before base64 encoding, so counting only
  entries could retain large amounts of old artwork. It now has a two MiB
  UTF-16 string budget as well as an entry limit. Oversized entries are not
  cached. Image handlers and sources are detached when the effect is disposed.
  This budget covers cached strings, not browser image decode/GPU memory.
- Selected-app filtering is memoized so media playhead renders do not create
  a fresh filtered notification array and retrigger reconciliation each frame.

These findings establish duplicate work and avoidable memory retention, not a
proof that the entire WebView2 footprint was a permanent heap leak. Main React
listeners/timers inspected have cleanup; tray GDI resources have RAII cleanup;
tray preview and lyrics caches already have entry limits.

## Verification

129 frontend tests and 65 native tests passed (11 manual native probes ignored).
Frontend production build and native debug build succeeded. New regression
tests cover 1,000 cache insertions, oversized keys, LRU accounting, duplicate
avatar jobs, slots retained across removal/revocation, shared image buffers,
and unchanged snapshot revisions.

The updated debug app was started with its local frontend running. Read-only
process-tree measurements from `scripts/measure_notch_memory.ps1`:

| Time | Group private working set MiB | Group private bytes MiB | Native private bytes MiB | Native threads | Native handles |
| --- | ---: | ---: | ---: | ---: | ---: |
| 22:24:02 | 158.3 | 228.1 | 12.1 | 43 | 621 |
| 22:24:13 | 148.0 | 217.6 | 12.1 | 43 | 621 |
| 22:24:23 | 145.7 | 215.6 | 12.1 | 42 | 619 |

No running app was available for a comparable pre-change baseline. The short
sample shows startup settling and stable native allocation, not a measured
before/after saving or a long-session leak certification. WebView2 remains the
main contributor to the process-group footprint.
