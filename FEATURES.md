# MK Prod features

Everything below is available in the Mac app and on the website, and therefore in the Windows, Android and iPhone/iPad apps, unless marked. Android and the website lay themselves out around the hinge of folding phones (book and tabletop postures).

## Work management

- **Hierarchy:** Workspace → Spaces → Folders → Lists; favorites, archive, templates.
- **Tasks:** custom statuses per Space, priorities, multiple assignees, watchers, tags, start/due dates, estimates, points, milestones, recurrence, subtasks, checklists, dependencies, linked tasks, attachments (encrypted files or links), comments with @mentions, activity log.
- **Custom fields:** text, number, money, dropdown, checkbox, date, URL, email, rating, people, phone, location, automatic progress (subtasks + checklists) and **formulas** (`{Unit cost} * {Quantity}`, `IF({Days left} < 0, "Late", "OK")`, ROUND/MIN/MAX/SUM/AVG/ABS/TODAY). Edited per Space; shown as Table columns with sums and in the task panel.
- **Views:** List, Board, Calendar, Gantt, Table, Chart, Workload, Team, Activity, Mind Map, Form; group by status, priority, assignee, task type, list or due date; sort; filters (assignee, priority, tag, type, overdue, closed); CSV export of the tasks in view.
- **Saved views:** a views bar on every location; save the view type, grouping, sorting and filters as a named view, shared or private (encrypted with your own key), with one that opens first.
- **Task types and task IDs** per Space (e.g. 🐞 Bug, `OPS-42`; ⌘K finds a task by its ID); **tasks in multiple lists**; **time in status**; **work-in-progress limits** per status on Board and List; **required and pinned fields**; **column calculations** (sum, average, min, max, count).
- **Close warnings** when a task still has open subtasks, checklist items, empty required fields or open blockers; optional **rescheduling of dependent tasks and subtasks** when a due date moves.
- **Comments** with threaded replies and emoji reactions.
- **Chart view:** bar, donut or line chart of the tasks in view, grouped by status, priority, assignee, tag, list, due month or a custom field, measuring task count, estimated hours, points, tracked hours or the sum of a number/money/formula field.
- **Gantt:** dependency arrows, **critical path** (the longest chain of dependent tasks, highlighted), and **baselines**: save the planned dates, then see slips as the gap between each bar and its grey baseline line.
- **Portfolio:** every list as a project with progress against its schedule, health (on track / at risk / off track / done), owners, open and overdue counts and a timeline, filterable by space and health.
- **Resource management:** per-person capacity (hours per day, working days, time off) against estimated work week by week, colour-coded by utilisation.
- **Content directory:** every space, folder, list, sprint, doc, channel, goal, whiteboard and dashboard in one searchable table with location, size, privacy and last update.
- **Home:** My work, approvals waiting, reminders, recently updated.
- **Inbox:** assignments, mentions, approvals, reminders; synced across your devices and private to you.
- **Whiteboards** (stickies, text, boxes, circles, connectors, colours, resize, zoom, convert to task; one board shared by every platform), **Chat** channels, **Goals** with targets, **Time tracking** and timesheets, **Dashboards** and **Automations** (Mac).
- **Import/export:** CSV task import, JSON backup, Excel exports.

## Procurement and budgets

- **Entities** with approval chains and per-person roles; **approval delegation** for absences.
- **Budgets** by year and category, split into line items: allocated, spent, committed, pending, balance.
- **Purchase orders and direct expenses:** multi-level approval, extra approval for unbudgeted spend, PO numbers, Ordered → Shipped → Delivered → Completed, assignment, full history, printable/Excel order record for audits.
- **Supplier links:** read-only, expiring, encrypted pages suppliers open without an account to confirm, decline or ask.
- **Shopping catalog** with cart, item requests, bulk import from Excel/CSV with a template.
- **One Import / Export button** on Budgets, Shopping catalog and Contracts (website, Windows, Android and Mac): download the template, upload it filled in (matching rows are updated, new ones added, bad rows reported), or export everything. Row-by-row entry stays separate (**+ New …**).
- **Contracts** (active, expiring, expired, renewing) with reminders 60/30/14/7/1 days before the end.
- **Savings**, **Reports**, **Audit log**.

## Team and security

- End-to-end encryption; the server stores ciphertext only.
- Accounts with email confirmation, two-factor sign-in (optional, enforceable per workspace), recovery codes, devices list, security log, sign-in alerts.
- Roles: owner, admin, member, viewer. Invite codes. Ownership transfer; account and workspace deletion.
- **Panic mode** (owner): lock the workspace instantly for everyone else, admins included; their sessions end, sync and supplier links are refused until the owner unlocks it. Recorded in the security log.
- Email notifications per person: assignments, updates, mentions, approvals, contract reminders, weekly summary.
- Presence (who is online, who has a task open), field-by-field merge of simultaneous edits, offline use.

Details: [README.md](README.md), [CLOUD_SETUP.md](CLOUD_SETUP.md), [SECURITY.md](SECURITY.md), [WINDOWS.md](WINDOWS.md).

## Updates

One version number (`VERSION`) for every platform. The website, Windows and Android apps show an **Update now** bar when a newer build is live; the Mac app shows **Update to x.y.z** in its sidebar once the release is on GitHub and installs it in place.
