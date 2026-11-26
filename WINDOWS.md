# MK Prod on Windows

MK Prod runs on Windows as an installed app: its own window, Start-menu entry, taskbar icon,
notifications, and it opens while offline. It installs **per user, with no admin rights** and no
installer file, because it is the website packaged by the browser (a "progressive web app").
Every feature matches the website exactly, since it *is* the same code, including end-to-end
encryption, two-factor sign-in, approvals, supplier links, file attachments and the order record.

## Install (about 20 seconds)

Microsoft Edge (already on every Windows 10/11 PC) or Google Chrome:

1. Open **https://mkprod.mk-uz02.workers.dev** and sign in.
2. Click **⬇ Install as an app** at the bottom of the left sidebar. (If you don't see it: Edge menu
   **⋯ → Apps → Install MK Prod**, or in Chrome the install icon at the right end of the address bar.)
3. Confirm. MK Prod opens in its own window and appears in the Start menu. Pin it to the taskbar
   from there if you like.

Nothing else to do. Updates arrive automatically the next time the app opens online.

## Everyday use

- **Offline:** the app opens and shows your workspace from its encrypted local copy; edits sync
  when you're back online.
- **Notifications:** allow them when asked, so assignments, mentions and approvals pop up on the
  desktop.
- **Sign out / remove:** Start menu → right-click MK Prod → Uninstall (per user, no admin), or
  inside the app: Team & account → Sign out.

## Company-managed PCs

- Works on standard user accounts; nothing is written outside the user's profile.
- Only outbound HTTPS to `mkprod.mk-uz02.workers.dev` is needed.
- If Edge is locked down so that app installation is blocked by policy, the website works in a
  normal browser tab with identical features; only the separate window and Start-menu entry are
  lost.

## The .exe (alternative)

If you prefer a classic program: **github.com/mohamdbeam-star/MKProd → Releases → MK Prod for
Windows**.

- `MK-Prod-<version>-win-x64.exe`: one-click setup for the current user. No admin rights; it
  installs under your own profile with Start-menu and desktop shortcuts.
- `MK-Prod-<version>-portable.exe`: nothing to install; runs from any folder or USB stick.

Both are a thin window around the same web app, so features are identical and always current.
Windows SmartScreen shows "Windows protected your PC" the first time because the file isn't
code-signed: click **More info → Run anyway**. (A code-signing certificate removes the warning;
see `desktop/README.md`.)
