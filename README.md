# TradeLens

Monorepo: Android app (Kotlin, Jetpack Compose) + Node.js/TypeScript server.

```
app/       Android app (com.tradelens.app, minSdk 26)
server/    Express + TypeScript API (default port 4000)
scripts/   preview-android.sh, dev.sh, check.sh
.vscode/   tasks, settings, recommended extensions
```

## Prerequisites
- Node.js 20+ and npm
- JDK 17+
- Android SDK (platform-tools, emulator, platform 36, build-tools) and an AVD
- Bash (macOS/Linux, or Git Bash on Windows)
- VS Code (optional, for the tasks)

Create the default AVD once (adjust the system image to one you have installed):
```
avdmanager create avd -n TradeLens_Pixel -k "system-images;android-35;google_apis;x86_64" -d pixel_6
```

## Run everything in VS Code
Press **Ctrl+Shift+B** (or Terminal > Run Task > **TradeLens: Start All**). It starts the server
(logs in `server/logs/server.log`), starts the emulator if needed, installs the app, and launches it.
The server is stopped when the task ends. Individual tasks: *Start Server*, *Preview Android App*.

From a terminal: `bash scripts/dev.sh` or `bash scripts/preview-android.sh`.

## Configuration
- `AVD_NAME` – AVD to boot (default `TradeLens_Pixel`):
  `AVD_NAME=Pixel_8_API_35 bash scripts/dev.sh` (Windows PowerShell: `$env:AVD_NAME="Pixel_8_API_35"`).
  List yours with `emulator -list-avds`.
- `ANDROID_HOME` – SDK path (default `$HOME/Android/Sdk`; the script also tries `%LOCALAPPDATA%\Android\Sdk` on Windows and `~/Library/Android/sdk` on macOS).
- Server: copy `server/.env.example` to `server/.env`.

## Troubleshooting: emulator not starting
- Check `server/logs/emulator.log` for the actual error.
- "AVD not found": run `emulator -list-avds` and set `AVD_NAME`, or create the AVD (see above).
- "Android SDK not found": set `ANDROID_HOME`.
- Hardware acceleration: enable virtualization in BIOS; on Windows enable Windows Hypervisor Platform / Hyper-V; on Linux ensure KVM access (`/dev/kvm`).
- Stuck/corrupt emulator: `adb kill-server`, close the emulator, then start with `-wipe-data` or cold boot from Android Studio's Device Manager.
- Boot timeout: first boot can take several minutes; re-run the task.
- Gradle download failures: check network/proxy and re-run.

## Android architecture (Phase 1)
Hilt (KSP) · Retrofit 3 + OkHttp 5 + Moshi codegen · Navigation Compose · DataStore · Vico charts.
Packages under `com.tradelens.app`: `core/{network,di,theme,ui}`, `data/{settings,market,signals}`, `ui/{navigation,main,screens}`, `state/AppState`.
- Server URL: `BuildConfig.SERVER_URL` (from `SERVER_URL` in `app/local.properties`; default `http://10.0.2.2:4000`, the emulator's alias for your computer). `AppState.serverUrl` follows a Settings override (Phase 7), applied per request by `BaseUrlInterceptor`.
- Strings: `res/values/strings.xml` only. The app is English only.
- Charts use Vico because it is Compose-native and Material 3 aware (MPAndroidChart is View-based and needs `AndroidView` interop).

### Windows + OneDrive note
If the repo is in OneDrive, Gradle's `build/` folder gets locked. `app/build.gradle.kts` therefore builds into `%LOCALAPPDATA%\TradeLens\build` on Windows (override with `TRADELENS_BUILD_DIR`).

## Daily use
1. Open the **TradeLens** folder in VS Code.
2. Press **Ctrl+Shift+B** (**Cmd+Shift+B** on macOS) to run **TradeLens: Start All**. It starts the server, boots the emulator, installs the app, and opens it.
3. Run `bash scripts/check.sh` before you share changes. It runs all server and Android tests and lint and prints a pass/fail table.

## Offline demo data
`npm run seed` (in `server/`) writes sample candles and signals to `server/data/demo` and never contacts Binance.
Run the server on them with `DEMO_MODE=true npm run dev`, or run `TRADELENS_SEED=1 bash scripts/dev.sh` to seed and start everything in one step.

## Server checks
In `server/`: `npm run lint`, `npm test`, `npm run build`.

## Docker (optional)
`server/Dockerfile` builds a production image. You do not need it for normal development.
```
docker build -t tradelens-server server
docker run --rm -p 4000:4000 --env-file server/.env -v tradelens-data:/app/data tradelens-server
```
Production mode requires `JWT_SECRET` in the env file.

## Release build
`./gradlew assembleRelease` (in `app/`) builds with R8 (code and resource shrinking, rules in `app/app/proguard-rules.pro`).
To sign it, copy `app/local.properties.example` to `app/local.properties` and fill in your keystore path, passwords, and alias.
`local.properties` is git-ignored and must never be committed. Without it the release APK is unsigned.
Google sign-in uses the Web client ID in `app/app/build.gradle.kts`; the same ID must be set as `GOOGLE_WEB_CLIENT_ID` in `server/.env` (the server will not start without it).

## Known limits
- **Binance access:** market data comes from Binance. Some networks and server regions block it; the app then shows a clear error. Set `MARKET_DATA_BASE_URL` to another provider, or use the offline demo data.
- **Background alerts** depend on the phone's battery settings and on the foreground service. If the phone restricts TradeLens, alerts can arrive late or not at all. Set TradeLens to "Not optimized" or "Unrestricted".
- **Signals are informational only and are not financial advice.** Trade at your own risk.
