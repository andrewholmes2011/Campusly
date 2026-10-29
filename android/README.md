# Campusly for Android

This is the Android Studio project for the live Campusly school hub.

- **Application ID:** `com.andrewsarmy.campusly`
- **Minimum Android version:** Android 8.0 (API 26)
- **Target SDK:** API 36
- **Live site:** https://campusly.andrewsarmy-cf.workers.dev/

The app opens the live Campusly site in Android System WebView. Sign-in, class access, messages, and account permissions continue to use the existing Campusly Cloudflare service; this app does not create a separate account database.

## Open in Android Studio

1. Download or clone the Campusly repository.
2. In Android Studio, select **Open** and choose the repository's `android` folder (not the repository root).
3. Allow Gradle sync to finish. Install Android SDK Platform 36 if Android Studio asks.
4. Select an Android emulator or connect your Android phone with USB debugging enabled.
5. Press **Run**.

## Build an APK

In Android Studio, select **Build → Build App Bundle(s) / APK(s) → Build APK(s)**. The debug APK will be written to:

`app/build/outputs/apk/debug/app-debug.apk`

For a command-line build on a machine with Android SDK Platform 36 installed:

```bash
gradle assembleDebug
```

The APK is for testing. To publish on Google Play, create a signed release build and complete Play Console's app and policy requirements.

## Security and behavior

- HTTPS only; cleartext traffic is disabled.
- Only the Campusly site stays inside the app. Other web links open in the browser.
- JavaScript and DOM storage are enabled because the Campusly website requires them.
- WebView file/content access is disabled, third-party cookies are disabled, and Android Safe Browsing is enabled.
- Login/session handling remains on the Campusly website and Cloudflare API.
