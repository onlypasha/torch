# Calendar visual adaptation

November 15 redesign follow-up: date cells are now 44px to provide larger
targets within the same 252×148 widget. Scroll offsets and spacers use the same
44px constant. The existing 22-day range and disconnected-agenda notice remain.

Reference: local source `C:/Development/reverse-engineering/boring.notch/boringNotch/components/Calendar/BoringCalendar.swift`.
This is a static source comparison, not observation of the macOS app.

- `Config` (lines 11–19) defines seven past days and fourteen future days.
- `WheelPicker.dateButton` (lines 95–140) uses a centered scrollable date wheel,
  an accent selection rectangle, and a separate 20px circle for today.
- `CalendarView` (lines 187–228) places the abbreviated month and year to the
  left, fading the horizontal date strip at both ends.
- `EmptyEventsView` (lines 253–270) centers a calendar symbol and two text rows
  below the date strip. The reference's event data comes from CalendarManager.

Adapted in `src/CalendarWidget.tsx` and `src/CalendarWidget.css` to fit the existing
252×148 widget. Dates are clickable and the wheel scrolls/snaps in 28px steps;
the month button returns to today. Calendar scrolling does not rotate the widget
stack. The pinned date-left/month-day-right layout remains unchanged.

The Windows project has no connected agenda provider. The lower panel therefore
says “Agenda belum terhubung”, rather than asserting that the selected day has
no events. No calendar/account integration was added in this visual change.

Validation: production build passed; the browser `calendar` scenario checks 22
dates, selection of the last date, returning to today, scroll handling, and
agenda bounds at 800×320. Screenshots were visually inspected. Both normal and
reduced-motion scrolling are checked through the existing browser fixture.
