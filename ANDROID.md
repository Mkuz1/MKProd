# MK Prod on Android

A native Android app around the web app, so every feature is identical to the website and the
Mac/Windows apps and is always current. Android 7.0 and newer: phones, tablets and foldables.

## Install

**github.com/Mkuz1/MKProd → Releases → "MK Prod for Android"** → download
`MK-Prod-<version>-android.apk` on the phone and open it.

- Android asks once to allow installs from the browser or files app (**Settings → Apps → Special
  app access → Install unknown apps**).
- Google Play Protect may warn about an app from outside the store: **More details → Install
  anyway**. (Publishing on Google Play removes that step; it needs a developer account, $25 once.)

Alternative without any download: open https://mkprod.mk-uz02.workers.dev in Chrome and tap
**Install as an app** at the bottom of the menu. That gives the same app as a Chrome-managed
install, updated automatically.

## Foldables (Honor Magic V series, Galaxy Z Fold, Pixel Fold…)

The app is declared resizable and handles every configuration change itself, so folding,
unfolding, rotating, split-screen and floating windows never restart it or lose what you were
typing. The layout is the same responsive one as the website: a phone layout with a slide-in menu
on the cover screen, and the full sidebar layout on the inner screen or a tablet.

## What works, what doesn't

- Everything on the website, including two-factor sign-in, approvals, supplier links, attachments
  (upload from Files/Gallery, download to the Downloads folder) and Excel exports.
- Dark mode follows the system setting.
- Push notifications are not available in this shell (Android's web view has no notification
  support); the Inbox inside the app and email notifications cover it. A later version can add
  true push notifications.

## Signing key (one-time, for the owner)

Each APK must be signed. The GitHub build signs with a **temporary** key until you give it a
permanent one; with a temporary key, a newer version can't install over an older one (users
would have to uninstall first). Create the permanent key once, on your Mac (no Java needed; macOS's built-in `openssl` does it):

```bash
mkdir -p ~/Documents/MKProd-keys && cd ~/Documents/MKProd-keys
PW=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)
openssl req -x509 -newkey rsa:2048 -nodes -days 10000 -subj "/CN=MK Prod/O=MK Prod" -keyout mkprod-key.pem -out mkprod-cert.pem 2>/dev/null
openssl pkcs12 -export -inkey mkprod-key.pem -in mkprod-cert.pem -name mkprod -out mkprod-android.p12 -passout "pass:$PW"
rm mkprod-key.pem mkprod-cert.pem
echo "$PW" > mkprod-android.password.txt
base64 -i mkprod-android.p12 | pbcopy
echo "Password: $PW  (saved in mkprod-android.password.txt). Keystore base64 is on your clipboard."
```

Then on GitHub: **Settings → Secrets and variables → Actions → New repository secret**, four times:

| Name | Value |
|---|---|
| `ANDROID_KEYSTORE_B64` | paste the clipboard |
| `ANDROID_KEYSTORE_PASSWORD` | the password you chose |
| `ANDROID_KEY_ALIAS` | `mkprod` |
| `ANDROID_KEY_PASSWORD` | the same password |

Keep `mkprod-android.jks` and the password somewhere safe (password manager): losing them means
future versions can't update existing installs. Re-run the "Android app" workflow (Actions tab →
Run workflow) and the release is re-signed with the permanent key.

## Build locally

Android Studio: open the `android` folder. Command line (JDK 17 + Android SDK):

```bash
cd android && gradle assembleRelease     # unsigned unless KEYSTORE_* env vars are set
```

## Folding phones

Built for book-style foldables such as the Honor Magic V series, Galaxy Z Fold and Pixel Fold,
and for flip phones:

- **Cover screen:** the phone layout (menu button, slide-in sidebar).
- **Unfolded:** the sidebar stays on screen next to the page; the task panel fills exactly the
  right-hand half, so nothing sits on the crease.
- **Book posture** (half open, like a book): sidebar and navigation in the left half, the page in
  the right half.
- **Tabletop posture** (half open, lying flat): the page above the fold, the task panel below it.
- Folding, unfolding, rotating or going split-screen never reloads the app or loses what you
  are typing.

The app reads the hinge from Android (Jetpack WindowManager) and passes it to the page; the same
layouts work in Chrome on a foldable through the browser's Viewport Segments API.
