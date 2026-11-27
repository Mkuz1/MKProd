# MK Prod: project status

_Source of truth for this app's claude.ai chat. As of 2026-11-27._

Team workspace for tasks, budgets, orders and contracts (project management + procurement), end-to-end encrypted, one data set on every platform.

## Current state

| | |
|---|---|
| Version | **1.5.0** on every platform (single `VERSION` file; `scripts/release.sh` bumps it) |
| Platforms | Mac (SwiftUI, universal), Windows (.exe, per user), Android (.apk, foldables), iPhone/iPad, Web |
| Downloads | GitHub releases in this repo, one tag per platform (`mac-v1.5.0`, `windows-v1.5.0`, `ios-v1.5.0`, …) |
| Web app + sync server | Cloudflare Worker + D1 at **https://mkprod.mk-uz02.workers.dev** (`web/`, deploys via `deploy.yml`) |
| Landing page | **https://mkprod.pages.dev** (`landing/`, deploys via `pages.yml` to Pages project `mkprod`) |
| App Store / Play | Not listed. iPhone is sideload IPA / TestFlight once Apple secrets are set |

## Recent changes

- 2026-11-26: **Moved to the main Cloudflare account** (PR #4). The app now runs at `mkprod.mk-uz02.workers.dev` and **started with no data**; the old data stays in the `mohamd-beam` Cloudflare account. Uses the Workers token (D1 + R2).
- 2026-11-26: Landing page on main with auto-deploy (PR #2), koussa.net invite (PR #3), SEO/share previews (PR #5), recon notes and feature list (PR #1).
- 2026-11-09: Release 1.5.0 (saved views, task types and IDs, close warnings, rescheduling, threads and reactions, Team and Activity views).

## Open items

- R2 storage may still need enabling on the main Cloudflare account (attachments).
- Existing users must be told the server moved and their old data is not on the new one.
- README install links still point at `mohamdbeam-star/MKProd` releases; switch them to `Mkuz1/MKProd`.

## Rules for every MK app (decided in the MK APPS project)

- **This file is the hand-off to the app's own Claude chat.** That chat reads it from GitHub through Project knowledge. Every change to this app (code, release, store, website, decision) must also update this file in the same PR or commit.
- **Nothing local-only.** Every asset, store file and site file lives in the app's GitHub repo. Signing keys and passwords are the only exception and are never committed (they stay in `~/keys` on the Mac).
- **Websites deploy themselves** to Cloudflare Pages from GitHub Actions on push (secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` are set on the repo). No manual or terminal deploys.
- **Every app site invites visitors to https://www.koussa.net** (the MK Apps showcase, source in `Mkuz1/MK-APPS`, served by Cloudflare project `mkuzapps`). Keep that card when editing the site, and update the app's row in `MK-APPS/build.py` when platforms, versions or store links change.
- **SEO and share previews (done 2026-11-26):** keep the OG + Twitter tags with an absolute 1200x630 image under 300 KB, canonical, favicon.ico + 192/512 icons + 180 px touch icon, web manifest, robots.txt, sitemap.xml and SoftwareApplication JSON-LD. When replacing a share image, give it a new file name so WhatsApp refreshes its cache.
- **Store badges only for what is really live.** Re-check the App Store / Play page before adding a badge.
- **Mohamad merges pull requests himself** (Claude Code's auto mode on the Mac blocks `gh pr merge`).

---
_Last updated 2026-11-27. Update this file with every change to the app._
