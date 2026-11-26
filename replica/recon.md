# Recon map: ClickUp (web, desktop, mobile)

Scope: the work-management core (tasks, views, hierarchy, collaboration, scheduling, reporting) compared against MK Prod 1.4.0, to find what MK Prod does not have yet. Procurement, budgets and finance are MK Prod's own and out of scope.
For: MK Prod, the user's own team workspace (Mac app + website, wrapped for Windows, Android, iPhone/iPad), end-to-end encrypted.
Date: 2026-11-06

## Rules followed

- Public sources only. No ClickUp account was used: its Terms forbid reverse engineering and copying the service (§1.5, §2.5, §4.3, §4.13) and automated access (§3.9). We read public pages at human speed and rebuild functionality, not code, copy or assets.
- No screenshots were taken; `screens/` is intentionally empty. Layout ideas come from MK Prod's own Liquid Glass design.
- This folder is git-ignored: the repository stays free of third-party product names.

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | pricing / plan comparison | https://clickup.com/pricing | full feature table by plan; the best list of what they gate |
| 2 | help center: Features and ClickApps index | https://help.clickup.com/hc/en-us/categories/5414365970455-Features-and-ClickApps | 45 feature areas |
| 3 | help center: Customizable features | https://help.clickup.com/hc/en-us/articles/9559764679831-Customizable-ClickUp-features | views bar, page views, ClickApps, permissions, templates |
| 4 | help center: Scheduling ClickApps | https://help.clickup.com/hc/en-us/sections/37683906486807-Scheduling-ClickApps | durations, skip non-working days, remap subtask dates, reschedule dependencies |
| 5 | help center: Remap Subtask Due Dates | https://help.clickup.com/hc/en-us/articles/6304545702423-Remap-Subtask-Due-Dates | prompt on due-date change; closed subtasks skipped by default |
| 6 | Terms of service | https://clickup.com/terms | restrictions above |
| 7 | MK Prod FEATURES.md + code | repo | what already exists |

## Core loop

Plan work as tasks in a hierarchy, see it through switchable saved views, and move it through custom statuses together.

## Screens (only those touched by the gaps)

| ID | screen | route / how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | Views bar | top of any Space / Folder / List / Everything | switch saved views, add a view, pin, private, default | tabs, + View menu, view menu (rename, duplicate, private, default, delete) | one view, many, private, default |
| S02 | List view | S01 tab | grouped rows, inline status, pinned fields | group header, row, field chips | empty, filled, closed hidden |
| S03 | Board view | S01 tab | status columns, WIP limits | column header with count/limit, card | under limit, at limit, over limit (red) |
| S04 | Table view | S01 tab | fields as columns, column calculations, CSV export | header, cells, footer calc | empty, filled |
| S05 | Activity view | S01 tab | feed of everything that happened in the location | day groups, entry rows | empty, filled |
| S06 | Team view | S01 tab | per person: in progress, done recently, overdue, capacity | person card, task chips | no members, filled |
| S07 | Task panel | click a task | details, task type, task ID, time in status, comments | header chips, props grid, comment thread, reactions | open, closed, blocked |
| S08 | Close warning | close a task with open work | warn about open subtasks, checklist items, required fields, blockers | dialog | none, one reason, several |
| S09 | Space settings | space ⋯ → Settings | task types, ID prefix, scheduling options, WIP limits, required/pinned fields | form rows | defaults |
| S10 | Comment thread | S07 | replies and emoji reactions | reply box, reaction bar | no replies, replies, many reactions |

## Flows

```
F01 Save a filtered view and come back to it
    S02 set filters/grouping -> S01 "+ View" -> name, private? -> tab appears; reopen location -> default view opens
    happy path clicks: 4
    edge: view deleted on another device, view from a list that was deleted, private view of someone else (hidden)

F02 Close a task that still has open work
    S02 tick -> S08 warning lists open subtasks / checklist items / empty required fields / open blockers -> "Close anyway" or "Cancel"
    happy path clicks: 2
    edge: no open work (no dialog), recurring task, closing from Board drag

F03 Reschedule a blocker
    S07 change due date of task A -> dependents of A shift by the same number of days; subtasks of A shift too (if enabled)
    edge: dependency cycle, dependent has no dates, closed subtasks (not moved)

F04 Discuss on a task
    S07 comment -> S10 reply / react 👍 -> others see it after sync
    edge: reacting twice toggles off, deleting a parent comment

F05 Board with WIP limits
    S09 set "In Progress" limit 3 -> S03 column shows 4/3 in red

F06 Put one task in two lists
    S07 "Also in…" -> pick list -> task shows in both lists' views; its home list stays
```

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| Views bar tab | built-in, saved, private (lock), default (star) | active, hover, editing | S01 |
| Type badge | icon + colour per task type | — | S02, S03, S07 |
| Task ID chip | PREFIX-123, copyable | — | S02, S03, S07 |
| WIP column header | count, count/limit | ok, at limit, over | S03 |
| Reaction pill | emoji + count | mine (highlighted), others | S10 |
| Warning dialog | list of reasons | — | S08 |
| Time-in-status bars | per status duration | current status highlighted | S07 |

## Inferred data model (as built for MK Prod)

```
View      id, name, scope ("everything" | "mine" | "space:<id>" | "folder:<id>" | "list:<id>"),
          mode, groupBy?, sortBy?, filters {search, assignee, priority, tag, showClosed, onlyOverdue},
          ownerId, isPrivate, isDefault, order
          evidence: source 3 (views bar, private/public, set default views); confidence: high
TaskType  id, name, icon, colorHex (per Space)          evidence: source 2 "Custom task types"; high
Task +    typeId?, number? (ID = space prefix + number), extraListIds? (tasks in multiple lists),
          statusLog? [{statusId, at}] (time in status)   evidence: sources 1, 2; high
Comment + parentId? (threads), reactions? [{emoji, memberIds}]  evidence: source 2 "Threaded Comments", "Comment Reactions"; high
StatusDef + wipLimit?                                    evidence: source 2 "Work in Progress Limits"; high
FieldDef + required?, pinned?                            evidence: source 1 "Required / Pinned Custom Fields"; high
Space +   idPrefix?, taskTypes?, rescheduleDependencies?, remapSubtasks?  evidence: sources 2, 4, 5; medium (settings shape is ours)
```

Relationships: Space 1-n TaskType, Space 1-n List, List 1-n Task (home) and n-n Task (extraListIds), Task 1-n Comment (tree via parentId), View n-1 location.

## Feature matrix

See `features.csv`. Must: 6, should: 12, could: 10, skip: 21, already in MK Prod: 30.

## Out of scope (cannot or should not be cloned)

- AI (Brain, agents, AI fields, notetaker, image/video generation): would send decrypted workspace content to an AI provider, which breaks MK Prod's end-to-end encryption. The owner's call.
- Guests, custom permissions, teams sharing: need per-space encryption keys. The owner's call.
- Docs and wikis: MK Prod removed its Docs page on purpose in 1.3.0.
- Integrations (Slack, Jira, Google Drive, Zapier, email inbox), webhooks, public API, SSO/SCIM, data residency, HIPAA, white labelling, support tiers: services, contracts or a server that can read data.
- Video calls (SyncUps), screen recording (Clips), Giphy, Office previews, Sheets, Creative studio: third-party services or large separate products.
- Map view: would send addresses to a map service.
- The template library content, the user network, the brand.

## Size

Screens 10, flows 6, entities 7 (1 new kind, 6 extended). Hard parts: keeping Mac and web data shapes identical (the Mac drops fields it doesn't know), saved views syncing across devices with private ones hidden, rescheduling dependencies without loops. Size: M for the must + should set on both clients.
