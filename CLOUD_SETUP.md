# MK Prod cloud: website + team sync on Cloudflare (free)

**Live:** https://mkprod.mk-uz02.workers.dev. Put this address in the Mac app under Settings → Cloud & Team → Server address.

One Cloudflare Worker provides everything:

- **the website**: the React app in `web/src`
- **the sync API** that both the website and the Mac app use (`web/worker/index.ts`)
- **storage** in a Cloudflare D1 database (`web/migrations`)

Changes made on the website show up in the Mac app and vice versa, usually within about 5 seconds.

## Free-plan limits

| Resource | Free allowance | Typical team use |
|---|---|---|
| Worker requests | 100,000 / day | Each open app or browser tab polls every 4 s while visible (30 s in a background tab) → roughly 7,000 per active person per 8-hour day |
| D1 storage | 5 GB | Years of tasks, docs and orders |
| D1 reads / writes | 5 M / 100 k rows per day | Comfortable for small teams |
| Static assets | Unlimited | The website itself |

A team of **up to about 10 people** working all day stays inside the free plan. If you outgrow it, the Workers Paid plan is $5/month. Nothing needs to change in the code.

## Automatic deploys from GitHub (recommended, one-time setup)

With two secrets in the repository, every push that touches `web/` or `VERSION` deploys the site by itself (`.github/workflows/deploy.yml`), so the website, the Windows app and the Android app (both show the site) are always on the latest version without anyone running a command.

1. Cloudflare dashboard → profile icon (top right) → **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template → Use template**. Under *Permissions* add a row **Account · D1 · Edit** (the deploy applies database migrations). Create the token and copy it; it is shown once.
2. **Workers & Pages → Overview**: copy the **Account ID** from the right-hand column.
3. GitHub → the repository → **Settings → Secrets and variables → Actions → New repository secret**, twice:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | the id from step 2 |

4. **Actions → Deploy site → Run workflow** once to confirm. From then on it runs on every push. The run's last step prints the live `version.json`.

Until the secrets exist the workflow stops with a notice and nothing is deployed; use the manual deploy below.

## Deploy by hand (about 2 minutes)

You need Node.js and a Cloudflare account (`npx wrangler login` once). The source of truth is GitHub (`Mkuz1/MKProd`); nothing needs to be kept on a particular computer.

```bash
git clone https://github.com/Mkuz1/MKProd.git
cd MKProd/web
npm install
npm run deploy
```

`npm run deploy` does three things (the `mkprod` database already exists, and its id is in `web/wrangler.jsonc`):

1. builds the website
2. creates the D1 database on first run and applies the migrations
3. publishes the Worker

It prints the site address, e.g. `https://mkprod.<your-subdomain>.workers.dev`.

To use your own domain, open Cloudflare dashboard → Workers & Pages → mkprod → Settings → Domains & Routes → Add custom domain.

## First use

1. Open the site address and choose **Create account**. Your password (10+ characters) never leaves your device.
2. **Save the recovery code** you're shown. It's the only way back in if you forget your password, and it's shown once.
3. Create a workspace. It's end-to-end encrypted from the start.
4. In **Team & account** (👥 at the bottom of the sidebar), invite a teammate by email. You get a **one-time invite code**; send it to them privately.
5. The teammate creates an account with that email on the site or in the Mac app, then enters the code (**Join** under *Choose a workspace*). Your app shares the encryption key with them automatically the next time it syncs.

### Mac app

In the app: **Settings (⌘,) → Cloud & Team**.

1. Paste the site address → **Save server**.
2. Sign in with the same account as on the website.
3. Do one of the following:
   - **Open** your workspace.
   - **Publish this workspace** to upload local data as a new encrypted workspace.
   - **Join** with an invite code.

Security details: **[SECURITY.md](SECURITY.md)**.

## Roles

| Role | Can do |
|---|---|
| Owner | Everything; the only one who can create admins; can't be removed |
| Admin | Invite/remove people, change roles (not to admin), reset passwords, finance settings, final approval of unbudgeted spend |
| Member | Edit everything; approve orders where their entity role matches the pending step |
| Viewer | Read everything; their edits are not shared and roll back on the next sync |

The server enforces workspace roles. Order approvals follow each entity's approval chain (**Finance settings → Entities**), the same way the old budget tracker did.

**Forgotten password:**
- **With your recovery code:** choose **Forgot password?** on the sign-in screen. Nothing is lost.
- **Without it:** an admin chooses **Reset password**, which gives a one-time temporary password. You get new encryption keys, and teammates' apps re-share the workspace key automatically.
- **If you're the only owner and lose both** your password and recovery code, the encrypted server copy can't be decrypted (by design). Your Mac still holds a full local copy.

## One shared set of data everywhere

There is no local-only mode. Every app signs in to the same account and opens a shared workspace; everything you do is in that workspace and reaches every other device within seconds. Apps keep an encrypted copy on the device so they open instantly and keep working offline; it is a cache of the shared data, and edits made offline are sent as soon as the connection is back.

- **Mac:** on first launch the app asks you to sign in, then to open a workspace (or create one / join with an invite code). The switcher at the top of the sidebar moves between your workspaces; each is cached in its own file under `~/Library/Application Support/MKProd/`. If this Mac still has data from the old local-only version, the workspace picker offers to upload it as a new shared workspace once.
- **Sync cadence:** every 2 seconds while anyone is actively changing things, 6 seconds when quiet, 30 seconds in a background tab; a local edit is sent within a second, and the Mac app syncs immediately when it comes to the front.

## How sync behaves

- Every object (task, doc, budget, order…) is one row in D1 with a change counter. Clients pull everything after their last counter, then push what changed.
- **Two people editing the same item:** changes merge field by field. Comments, checklist items and order lines from both sides are kept. If both change the same field, the later save wins.
- **Offline:** the Mac app stores everything locally, and the website caches in the browser (IndexedDB). Both catch up when back online.
- **Presence:** the sidebar shows who is online, and a task shows who else has it open.
- **Inbox and reminders** are yours alone but follow you: assignments, @mentions, assigned comments, orders waiting for *your* approval, status changes of *your* orders and due reminders land in the Inbox on every device you use, read state included. They are encrypted with your own key, so teammates can't see them. Reminders are set on the website's Home page or in the Mac app and fire once, from whichever device is online at the time. You also get a desktop notification if you allow it.

## Local development

```bash
cd web
npm install
npm run db:local       # create the local D1 tables
npm run dev            # builds the site and serves it + the API on http://127.0.0.1:8787
```

Point the Mac app's server address at `http://127.0.0.1:8787` to test both clients together.

## Tests

- `Tests/interop/run.sh` checks that the Mac app's cryptography (CryptoKit) and the website's (WebCrypto) produce byte-compatible keys and ciphertext.
- `Tests/run_sync_e2e.sh` starts the real Worker under `wrangler dev` with a throwaway database. Two separate Mac-client processes (Alice and Bob) then run through the following, and the script finally confirms the database holds only ciphertext:

- invites
- assignments and @mentions
- presence
- trash
- viewer lock-down
- concurrent-edit merge
- a full purchase order: submit → manager approval → ordered → delivered → budget spent
- invite codes and key sharing
- recovery code and admin password reset (with key re-sharing)
- member removal with key rotation

## Email

Emails go out from **mohamd.beam@gmail.com** through Gmail. The sender address, server and port are already in `web/wrangler.jsonc`; the only thing missing is the Gmail **App Password**, which must stay a secret:

1. Google Account → Security → 2-Step Verification (turn it on if it isn't) → **App passwords** → create one named "MK Prod". Google shows a 16-character password once.
2. In `web/` run `npx wrangler secret put SMTP_PASS` and paste it.
3. `npm run deploy`, then **Send test email** under Team & account › Email notifications.

Gmail allows about 500 emails a day from a personal account, which is plenty for a team of this size. To send from another address later, change `SMTP_USER`/`SMTP_FROM` in `wrangler.jsonc` and set the matching `SMTP_PASS`.

Until the password is set, no email is sent, accounts don't need email confirmation, and the settings screens say email is off.

### What is sent

Account emails (written by the server; contain no workspace data):

- **Email confirmation code** after sign-up. Until it's entered, the account can't create or join workspaces.
- **New sign-in alert** with device, approximate location and time. Can be turned off per person.

Workspace notifications (written by the teammate's app, because only the apps can read the encrypted data; the server applies the recipient's preferences, removes duplicates and sends):

- **Task assigned:** to the new assignee.
- **Task updated:** to assignees and watchers. Edits made within 15 minutes go out as one email.
- **@mention:** to the person mentioned.
- **Order approval:** to the people who can approve the order (including delegates), and to the requester when its status changes.
- **Contract ending:** 60, 30, 14, 7 and 1 day before the end date, to the people assigned to the contract's entity. If the contract has no entity, it goes to the owners and admins.
- **Weekly summary** on Monday: approvals waiting, overdue and upcoming tasks, orders in progress, contracts ending within 30 days.

Nobody gets an email about their own edits. Each person can turn off any type, or hide the details so the email only says that something happened.

## Account security

- **Two-factor sign-in** (authenticator app): Team & account › Two-factor sign-in. Scan the QR code, enter the 6-digit code, save the 8 backup codes. The **owner can require it** for the whole workspace (Workspace policy); members without it are locked out of that workspace until they turn it on.
- **Signed-in devices:** see every device with its last activity and sign any of them out.
- **Security activity:** sign-ins, password and two-factor changes for your account; owners and admins also see the workspace log (joins, role changes, resets, key rotations, supplier links).
- **Delete account** (Team & account, bottom) or **delete workspace** (owner, Workspace policy). Both need the password. An owner who leaves first **transfers ownership** to a teammate.

## Suppliers, files, delegation

- **Supplier links:** open an order → **Share with supplier**. The supplier gets a read-only page (no account needed) showing the items, prices and delivery date, and can confirm, decline or ask a question. The page content is encrypted with a key that lives only in the link, so only whoever has the link can read it. Links expire (7–90 days) and can be revoked. Replies appear on the order.
- **Order record:** open an order → **Record (PDF)** prints the complete order with its approval trail; **Record (Excel)** downloads the same as a workbook. For finance and auditors.
- **Approval delegation:** Finance settings › Approval delegation. Hand your approvals to a colleague until a date (out of office). Their approvals are recorded "on behalf of" you.
- **File attachments** on tasks (up to 25 MB each, 2 GB per workspace) are encrypted in the browser and stored in Cloudflare R2 (10 GB free). R2 has to be enabled once in the Cloudflare dashboard: **R2 Object Storage → Get started** (Cloudflare asks for a payment method, but the free allowance is not charged). `npm run deploy` then creates the `mkprod-files` bucket automatically. Until R2 is enabled, `npm run deploy` warns and deploys without it: everything else works and attachments are links only. (The Mac app shows file attachments by name; downloading them from the Mac is a planned update.)

## Back-ups

Cloudflare D1 keeps 30 days of point-in-time history. For anything older, export now and then (the export is ciphertext, so it can be stored anywhere):

```bash
cd web && npx wrangler d1 export mkprod --remote --output ../backups/mkprod-$(date +%F).sql
```
