# Reports

**Reports** in the sidebar opens to two read-only, spreadsheet-style pages. Both
have a search box, filters, and **Export to Excel**, which downloads exactly the
rows on screen as an `.xlsx` file.

| Page | Route | Columns |
|---|---|---|
| Member & device report | `/reports/members` | Member Name (ID), Team, Seat Number, Device Name, Device Number — one row per device; a person with no devices gets one row |
| IT task report | `/reports/it-tasks` | Assigned Date, Completed Date, Team Member Name, Team, IT Member, Request, Status, Task Description |

## Who sees what

Scoping is enforced in the store queries (`backend/internal/store/reports.go`),
not in the UI. Everyone signed in holds `reports.view`.

| Role | Member & device report | IT task report |
|---|---|---|
| Admin | Every team; can filter to one | Every task; filter by team and IT member |
| Team lead | Their own team only (a `teamId` for another team is ignored) | Their team's tasks only |
| IT | Every team; can filter to one | Only tasks assigned to them (their account, or the staff entry linked to it); the IT-member filter is ignored |

## What counts as a task

An IT request that is assigned to someone in IT (routed to a staff entry or
taken by an IT account) and is open, in progress or resolved. Cancelled and
rejected requests are left out; seat-move transfers are not included.

- **Assigned Date**: the latest "assigned" event on the request, else when work started, else when it was raised.
- **Completed Date**: when it was resolved (blank until then).
- **Team Member Name**: the person named on the request, else whoever raised it.
- **Task Description**: built by `domain.ITTaskDescription` — the devices asked
  for or handed over, or the issue and the device it concerns, followed by IT's
  resolution note. A new or replacement device's number only appears if IT wrote
  it in that note.

## API

```
GET /api/v1/reports/members   ?teamId=&q=&format=xlsx
GET /api/v1/reports/it-tasks  ?teamId=&itMember=&status=completed|open&q=&format=xlsx&utcOffset=345
```

`q` matches every word against the row's text. `format=xlsx` returns the
workbook (written by `backend/internal/xlsx`, standard library only);
`utcOffset` is minutes east of UTC for the dates in it.
