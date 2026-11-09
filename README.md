# MK Prod

A team workspace for tasks, budgets, orders and contracts, in three forms that share one encrypted data set:

- **Mac app** (native SwiftUI, Liquid Glass design on macOS 26, local-first; data in `~/Library/Application Support/MKProd/workspace.json`)
- **Website** at https://mkprod.mohamd-beam.workers.dev (same glass design)
- **Windows app** (`.exe`, per user, no admin rights), **Android app** (`.apk`, made for foldables: book and tabletop postures) and **iPhone/iPad app**: **[WINDOWS.md](WINDOWS.md)**, **[ANDROID.md](ANDROID.md)**, **[IOS.md](IOS.md)**

It's an original implementation: project management (spaces, lists, tasks, whiteboards, chat, goals, time tracking) and procurement (budgets, approvals, orders, catalog, contracts) in one encrypted workspace.

## Install

- **Mac:** [Releases → MK Prod for Mac](https://github.com/mohamdbeam-star/MKProd/releases): open the `.dmg`, drag MK Prod to Applications. First launch: macOS says it "could not verify MK Prod is free of malware" because the build is not yet notarized with Apple: click Done, then System Settings → Privacy & Security → **Open Anyway** (once per install). See [MAC_SIGNING.md](MAC_SIGNING.md) to remove the warning with an Apple Developer account. Universal (Apple Silicon + Intel), macOS 14+, Liquid Glass on macOS 26.
- **Windows:** [Releases → MK Prod for Windows](https://github.com/mohamdbeam-star/MKProd/releases): per-user setup or portable `.exe`, no admin rights. See [WINDOWS.md](WINDOWS.md).
- **Android:** [Releases → MK Prod for Android](https://github.com/mohamdbeam-star/MKProd/releases): `.apk` for Android 7+, phones, tablets and foldables. See [ANDROID.md](ANDROID.md).
- **iPhone / iPad:** Safari → Share → **Add to Home Screen** today; the native app through TestFlight once the Apple Developer secrets are set, or sideload the `.ipa` from [Releases](https://github.com/mohamdbeam-star/MKProd/releases). See [IOS.md](IOS.md).
- **Web:** https://mkprod.mohamd-beam.workers.dev, installable as an app from the sidebar. Signed-in people find all downloads under **Get the apps** in the sidebar (Mac: Settings → Cloud & Team).

**One version number for everything.** The `VERSION` file at the repository root is the version of the website, the Mac, Windows and Android apps. To publish an update run `scripts/release.sh 1.2.0` (or `patch` / `minor` / `major`): it bumps the number, commits and pushes, and GitHub Actions then rebuilds the installers under the new number (`.github/workflows/mac.yml`, `windows.yml`, `android.yml`, `ios.yml`) and deploys the website (`deploy.yml`, once the Cloudflare secrets from [CLOUD_SETUP.md](CLOUD_SETUP.md) are set). The website shows its version at the bottom of the sidebar; the Windows and Android apps display the website, so they pick the update up by themselves and show an "Update now" bar when a newer build is live. The Mac app checks the same version file and, once the matching release is on GitHub, shows **Update to x.y.z** at the bottom of its sidebar; one click downloads it, replaces the app and relaunches.

## Build & run from source

```bash
./build_app.sh            # builds MK Prod.app next to the script (UNIVERSAL=1 for a two-architecture binary)
open "MK Prod.app"
```

Requirements: macOS 14+ and the Xcode Command Line Tools. Without full Xcode, the script builds against the macOS 26.5 SDK, because the macOS 27 CLT SDK needs SwiftUI macro plugins that only ship with Xcode.

## Features

| Area | What's included |
|---|---|
| Hierarchy | Workspace → Spaces (color, icon, privacy) → Folders → Lists; favorites, rename, duplicate, archive, delete |
| Tasks | Custom statuses per Space, priorities, multiple assignees, watchers, tags, start/due dates, estimates, sprint points, milestones, recurring tasks, subtasks, checklists (with assignees), dependencies (waiting on / blocking), linked tasks, attachments, comments with @mentions, threaded replies, emoji reactions and resolve, activity log; task types and task IDs (e.g. OPS-42) per Space; tasks in multiple lists; time in status; warnings before closing a task with open work; optional rescheduling of dependent tasks and subtasks |
| Custom fields | Text, number, money, dropdown, checkbox, date, URL, email, rating, people, phone, location, automatic progress and formulas (per Space; Mac and website) |
| Views | List (grouped, collapsible, inline add, drag to regroup), Board (drag between columns), Calendar (month/week, drag to reschedule), Gantt (drag bars, zoom, dependency arrows, critical path, saved baselines, today line), Table (sortable, custom-field and formula columns, sum/average/min/max/count), Chart (bar/donut/line by any property or field), Workload (capacity heatmap), Team (per person: in progress, overdue, done this week), Activity (feed of changes and comments), Mind Map, Form (submissions create tasks); work-in-progress limits per status; saved views (shared or private, one opens first) |
| Filtering | Search (also by task ID), assignee, priority, tag, task type, show closed, overdue only, "Me mode"; group by status/priority/assignee/task type/due/list; sort options; CSV export of the tasks in view (website) |
| Home | My Work (overdue/today/next/unscheduled), reminders, recents, notepad, 7-day agenda, goals |
| Inbox | Notifications for assignments, mentions, approvals, reminders; read/clear/restore. Synced across all your devices, private to you |
| Whiteboards | Stickies, text, shapes, connectors, colors, resize, zoom, convert to task; the same boards on Mac, website, Windows and Android |
| Chat | Channels, per-Space channels, post as any member, create task from message |
| Goals | Folders, owners, due dates; number, currency, true/false and task-linked targets |
| Portfolio | Every list as a project: progress vs schedule, health, owners, overdue, timeline |
| Resources | Capacity per person (hours/day, working days, time off) vs estimated work, by week |
| Content directory | Every space, list, doc, channel, goal, whiteboard and dashboard in one searchable table |
| Dashboards | Cards: status donut, priority, workload, overdue, 14-day completions, time tracked, goal progress, recent activity; per-Space scope |
| Time tracking | Global timer (toolbar, ⇧⌘T), per-task timer, manual entries, billable flag, weekly timesheets |
| Automations | When (created / status / priority / assignee / tag / due date passed) → Then (status, priority, assign, tag, move, comment, set due, archive), scoped per Space |
| Templates | Save any task (with subtasks) as a template; instantiate into any list |
| Other | ⌘K command palette and global search (website: also commands; shortcuts n, /, ?), space settings for statuses, task types, IDs, scheduling and fields, JSON backup/restore, CSV import and export of tasks, macOS notifications for reminders, settings for people/statuses/fields |

## Website, team sync & collaboration

The team website and the sync server are one free Cloudflare Worker with a D1 database (`web/`). The website and the Mac app share the same data and stay in sync within seconds. Setup and deploy steps: **[CLOUD_SETUP.md](CLOUD_SETUP.md)**.

## Security

- **End-to-end encrypted.** Workspace content is encrypted on the Mac or in the browser (AES-256-GCM, P-256 key sharing). The server and Cloudflare only ever store ciphertext.
- **Passwords never leave the device.** They're stretched locally (PBKDF2-SHA256, 600,000 rounds).
- **Invites need a one-time code**, and there's a recovery code for forgotten passwords.
- **Two-factor sign-in** (authenticator app), optional per person and enforceable per workspace by the owner; email confirmation of new accounts; sign-in alerts; a devices list; and a security log per account and per workspace.
- **Sessions:** the website uses an HttpOnly cookie, and the Mac app stores its session and keys in the Keychain.
- **Hardened delivery:** strict security headers on the site, and Mac data files readable only by your macOS user (on top of FileVault).
- **Panic mode:** the owner can lock a workspace instantly; everyone else is signed out and refused (sync, team, supplier links) until it is unlocked.
- **Right to erasure:** delete your account, delete or transfer a workspace.

Design and threat notes: **[SECURITY.md](SECURITY.md)**.

## Budget & procurement (from the previous Budget Tracker)

Available in both the Mac app and the website:

- **Entities** with configurable approval chains and per-person entity roles
- **Budgets** split into line items, showing allocated / spent / committed / pending / balance
- **Orders and direct expenses**:
  - multi-level approval
  - final admin approval for unbudgeted spend
  - PO numbers
  - Ordered → Shipped (tracking number) → Delivered → Completed
  - staff assignment and a full history
- **Shopping catalog** with a cart, plus item requests that need approval
- **Contracts**, flagged active, expiring (within 60 days), expired or renewing
- **Savings**
- **Reports**: Excel downloads on the website, CSV and a PDF executive report in the Mac app
- **Bulk import**: budgets, the shopping catalog and contracts each have one **Import / Export** button: download the template, fill it in, upload it (existing rows are updated, new ones added), or export everything. Single entries are still added one by one with **+ New …**
- **Audit log** of every finance action
- **Supplier links** (website): a read-only, expiring, encrypted page per order that the supplier opens without an account to confirm, decline or ask
- **Order record** (website): the full order with its approval trail as PDF or Excel, for auditors
- **Approval delegation** (out of office), honoured by both clients
- **Encrypted file attachments** on tasks (website upload/download; Mac shows them by name)
- **Weekly summary email** every Monday

See **[FEATURES.md](FEATURES.md)** for the full feature checklist.

## Tests

```bash
Tests/api/run.sh        # any machine with Node 20+: ~180 API checks (auth, 2FA, roles, encrypted sync, shares, files, deletion) incl. an attacker suite (cross-workspace access, role escalation, brute force, oversized/malformed input, headers, injection)
Tests/browser/*.mjs     # Playwright against the real site: sidebar & workspaces, personal sync, bulk import/export
Tests/run_sync_e2e.sh   # macOS only: two Mac-client processes against the real Worker, 34 checks
```

All start the real Worker with `wrangler dev` on a throwaway local database (the API suite with a local mail sink so email flows are exercised too). The latest results are in **[TEST_REPORT.md](TEST_REPORT.md)**.
