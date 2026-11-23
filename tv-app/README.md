# Localhost Music TV (Android WebView wrapper)

A minimal Android TV app that hosts Localhost Music's `/tv` 10-foot UI in a WebView and
feeds the remote's d-pad straight into the page's focus engine (no cursor, unlike
a Chrome/TWA wrapper). On first run it asks for your server's address and then loads its `/tv` page.
Press Menu on the remote to change the server later.

## Build
Requires a JDK 17 + the Android SDK (cmdline-tools, platform-tools,
build-tools;34/35, platforms;android-35). With those installed:

    ANDROID_HOME=/path/to/android-sdk JAVA_HOME=/path/to/jdk17 ./gradlew assembleDebug

Output: `app/build/outputs/apk/debug/app-debug.apk`. Sideload it on the TV
(e.g. via the Downloader app pointed at the served `/lhm.apk`).

Only the native wrapper needs a reinstall; everything inside `/tv` is live web,
so layout/feature changes just need a server rebuild + reopening the app.
