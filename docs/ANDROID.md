# Android app and Google Play

Omniverse Forge ships to Android with [Capacitor](https://capacitorjs.com): the
built web game runs inside a native Android app. The native project is in
`android/` and the app id is **`com.omniverseforge.game`**. The app id is
permanent once published: change it in `capacitor.config.ts` *and*
`android/app/build.gradle` before your first upload if you want a different
one (for example `com.yourname.omniverseforge`).

## What's already done

- Native Android project (Capacitor 8, target SDK 36, which meets Play's target-API requirement).
- Full-screen immersive mode and keep-screen-on while playing.
- The Android back button closes dialogs, pauses the game, and goes up a screen.
- Exports and photo-mode pictures open the Android share sheet (Save to Files, Drive, Photos...).
- App icon, adaptive icon, and splash screen (`scripts/make-icons.py`; run `npm run icons` after changing it).
- Play Store icon and feature graphic in `store/`.
- In-app **account deletion** for the Multiverse Hub (a Play requirement for apps with sign-up).
- A privacy policy at `public/privacy.html`, served at `https://<your-hub>/privacy.html`.
- A GitHub Actions workflow (`.github/workflows/android.yml`) that builds a test APK and a Play-ready AAB.

## 1. Point the app at your Multiverse Hub

The Android app can't use a relative `/api` like the website does. After
deploying the hub to Render (see the main README):

1. In GitHub: **Settings → Secrets and variables → Actions → Variables → New repository variable**:
   `HUB_URL` = `https://<your-render-app>.onrender.com/api`
2. `render.yaml` already sets `CORS_ORIGIN=https://localhost`, which is the Android app's origin.

Without `HUB_URL` the game still works offline; only the hub can't connect.
Players can also enter a hub address in Settings.

## 2. Create your upload key (once)

Google Play signs the final app itself (Play App Signing); you sign uploads with
your own **upload key**. On any computer with Java installed:

```sh
keytool -genkeypair -v -keystore upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload
base64 -w0 upload.jks > upload.jks.b64     # macOS: base64 -i upload.jks -o upload.jks.b64
```

Keep `upload.jks` and its passwords somewhere safe (a password manager). Never commit them.

Then in GitHub: **Settings → Secrets and variables → Actions → Secrets → New repository secret**:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | contents of `upload.jks.b64` |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | `upload` |
| `ANDROID_KEY_PASSWORD` | the key password |

## 3. Build

Every push that changes the game runs **Actions → Android build**. You can also
start it by hand with **Run workflow**, optionally with a version name such as
`1.0.0`. When it finishes, download the artifact `omniverse-forge-android-N`:

- `omniverse-forge-debug.apk`: copy it to your phone and open it to install
  (allow "install unknown apps" for your file manager). Use it for testing.
- `omniverse-forge-release.aab`: this is what you upload to Google Play.

The version code is the workflow's run number, so every build can be uploaded.

### Building on your own computer instead

Install [Android Studio](https://developer.android.com/studio), then:

```sh
npm ci
npm run android:sync     # builds the game and copies it into android/
npm run android:open     # opens the project in Android Studio
```

Run it on a phone or emulator from Android Studio, or use **Build → Generate Signed App Bundle**.

## 4. Publish on Google Play

1. **Create a developer account** at <https://play.google.com/console> ($25 one-time, identity verification).
2. **Create app**: name "Omniverse Forge", type *Game*, *Free*.
3. **Set up your app** (the Console's checklist):
   - **Privacy policy**: `https://<your-render-app>.onrender.com/privacy.html`. First, put your
     contact email in `public/privacy.html` where it says `[your contact email]`.
   - **App access**: everything is available without special access.
   - **Ads**: the app contains no ads.
   - **Content rating**: answer the IARC questionnaire. The game has fantasy and cartoon violence
     (superheroes, no blood or gore) and user-generated content that players share and can report.
   - **Target audience**: 13 and over (the hub has accounts and user-generated content).
   - **Data safety**: see below.
   - **Account deletion URL**: `https://<your-render-app>.onrender.com/privacy.html#delete`
4. **Store listing**: use the text in `store/listing.md`, the icon `store/icon-512.png`, the
   feature graphic `store/feature-graphic.png`, and at least 2 phone screenshots (take them on
   your phone; photo mode with the HUD hidden works well).
5. **Release**: start with **Testing → Internal testing**, upload the `.aab`, and add yourself as a
   tester. Personal developer accounts must then run a **closed test with at least 12 testers for
   14 days** before Google allows a production release.

### Data safety answers

| Question | Answer |
| --- | --- |
| Does the app collect or share user data? | Yes, collected (only if the player creates a hub account) |
| Personal info → User IDs | Collected: the public hub handle. Purpose: account management. Not shared. |
| App activity → Other user-generated content | Collected: content players publish, likes, reports. Purpose: app functionality. Not shared. |
| Is data encrypted in transit? | Yes (HTTPS) |
| Can users request deletion? | Yes: in-app *Delete account*, or the deletion URL above |
| Data shared with third parties | None |

Universes and other game data stay on the device and aren't "collected" in Play's sense.

## Updating the app

Push your changes (or run the workflow), download the new `.aab`, and upload it
as a new release in the Play Console. Version codes increase automatically.
