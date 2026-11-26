# MK Prod for iPhone and iPad

The same app as the website, Mac, Windows and Android: same account, same encrypted workspace,
every feature, synced within seconds. Source in `ios/`, built by `.github/workflows/ios.yml`.

## Three ways to get it on an iPhone

Apple only lets an iPhone install apps that are signed by an Apple Developer account. That
decides which route works for you.

### 1. Today, no account: Add to Home Screen

On the iPhone or iPad, open **https://mkprod.mk-uz02.workers.dev** in **Safari** →
**Share** → **Add to Home Screen**. It gets the MK Prod icon, opens full screen without browser
bars, keeps you signed in, and updates itself ("Update now" bar). Everything works, including
file attachments and Excel exports.

### 2. The native app for the whole team: TestFlight (recommended)

Needs the Apple Developer Program ($99/year, developer.apple.com/programs). One-time setup:

1. **App Store Connect → Apps → +** → New App: platform iOS, name *MK Prod*, bundle ID
   `com.mkoussa.mkprod` (register it under Certificates, Identifiers & Profiles → Identifiers if
   it isn't offered), SKU `mkprod`.
2. **Users and Access → Integrations → App Store Connect API → Team Keys → +**: name
   *GitHub*, access **App Manager**. Download the `.p8` file (once only) and note the **Key ID**
   and the **Issuer ID** shown above the list.
3. Your **Team ID**: developer.apple.com → Account → Membership details.
4. GitHub → repository → **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
|---|---|
| `APPLE_TEAM_ID` | the Team ID (it may already exist from the Mac signing setup) |
| `ASC_KEY_ID` | the Key ID |
| `ASC_ISSUER_ID` | the Issuer ID |
| `ASC_KEY_P8_B64` | on a Mac: `base64 -i AuthKey_XXXX.p8 \| pbcopy`, then paste |

5. **Actions → iOS app → Run workflow.** The app is signed and uploaded; after Apple's
   automatic check (10–30 minutes) it appears in App Store Connect → TestFlight. Add the team
   under **Internal Testing** (up to 100 people, no review); they install it with Apple's
   **TestFlight** app and get every new version automatically.

From there, publishing to the App Store is a form in App Store Connect (screenshots, privacy
answers) and a review.

### 3. Without a paid account: sideload the .ipa

Each GitHub release has `MK-Prod-<version>-ios-unsigned.ipa`. Tools such as **Sideloadly** or
**AltStore** (on a Mac or PC) sign it with your own free Apple ID and install it over USB or
Wi-Fi. Apple limits this to 3 apps per device and the signature expires after 7 days, after
which the tool re-signs it. Fine for trying it out; use TestFlight for the team.

## What the app adds around the website

- Home-screen icon, launch screen in light and dark, full screen edge to edge with the notch and
  home indicator respected.
- Native alerts and text prompts (create a space, name a whiteboard, confirmations).
- Downloads: Excel exports, order records and decrypted attachments open the share sheet →
  **Save to Files**, AirDrop, Mail, Teams.
- Attach files from Files, Photos or the camera.
- Links to other sites (GitHub, supplier portals, mailto:) open in Safari or the right app.
- Swipe from the left edge to go back; offline screen with **Try again**.
- `mkprod://approvals`, `mkprod://mine`, `mkprod://whiteboards`… open that page in the app
  (useful in Shortcuts or a Home-screen shortcut).
- iPad: every orientation, Split View and Slide Over; the layout adapts like on a foldable.

## Building it yourself

```bash
brew install xcodegen
cd ios && xcodegen generate && open MKProd.xcodeproj
```

The Xcode project is generated from `ios/project.yml`; don't commit `MKProd.xcodeproj`.
