#!/usr/bin/env bash
# Build, install and launch the TradeLens app on an Android emulator.
# Works on macOS, Linux and Git Bash (Windows).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AVD_NAME="${AVD_NAME:-TradeLens_Pixel}"
PKG="com.tradelens.app"

step() { echo "==> $*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

# Resolve SDK location
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) IS_WIN=1; EXE=".exe"; BAT=".bat" ;;
  *) IS_WIN=0; EXE=""; BAT="" ;;
esac
if [ -z "${ANDROID_HOME:-}" ]; then
  if [ "$IS_WIN" = 1 ] && [ -n "${LOCALAPPDATA:-}" ] && [ -d "$(cygpath -u "$LOCALAPPDATA")/Android/Sdk" ]; then
    ANDROID_HOME="$(cygpath -u "$LOCALAPPDATA")/Android/Sdk"
  elif [ "$(uname -s)" = "Darwin" ] && [ -d "$HOME/Library/Android/sdk" ]; then
    ANDROID_HOME="$HOME/Library/Android/sdk"
  else
    ANDROID_HOME="$HOME/Android/Sdk"
  fi
fi
[ -d "$ANDROID_HOME" ] || fail "Android SDK not found at '$ANDROID_HOME'. Install it or set ANDROID_HOME."
export ANDROID_HOME ANDROID_SDK_ROOT="$ANDROID_HOME"
ADB="$ANDROID_HOME/platform-tools/adb$EXE"
EMULATOR="$ANDROID_HOME/emulator/emulator$EXE"
[ -x "$ADB" ] || fail "adb not found at '$ADB'. Install platform-tools via the SDK Manager."
[ -x "$EMULATOR" ] || fail "emulator not found at '$EMULATOR'. Install the Android Emulator via the SDK Manager."
step "Using Android SDK: $ANDROID_HOME"

# Make sure Gradle can find the SDK
if [ ! -f "$ROOT/app/local.properties" ]; then
  SDK_PROP="$ANDROID_HOME"
  [ "$IS_WIN" = 1 ] && SDK_PROP="$(cygpath -m "$ANDROID_HOME")"
  SDK_PROP="${SDK_PROP//:/\:}" # properties files need the drive colon escaped (C\:/...)
  echo "sdk.dir=$SDK_PROP" > "$ROOT/app/local.properties"
fi

# Start emulator if none is running
running_device() { "$ADB" devices | awk 'NR>1 && $1 ~ /^emulator-/ && $2=="device" {print $1; exit}'; }
"$ADB" start-server >/dev/null 2>&1 || true
if [ -z "$(running_device)" ]; then
  step "No emulator running. Checking AVD '$AVD_NAME'..."
  "$EMULATOR" -list-avds | tr -d '\r' | grep -qx "$AVD_NAME" \
    || fail "AVD '$AVD_NAME' not found. Available: [$("$EMULATOR" -list-avds | tr -d '\r' | tr '\n' ' ')]. Create it in Android Studio or set AVD_NAME."
  step "Starting emulator '$AVD_NAME' in the background..."
  mkdir -p "$ROOT/server/logs"
  nohup "$EMULATOR" -avd "$AVD_NAME" -no-snapshot-save > "$ROOT/server/logs/emulator.log" 2>&1 &
  step "Waiting for adb to see the device..."
  "$ADB" wait-for-device
else
  step "Emulator already running: $(running_device)"
fi

step "Waiting for boot to complete (sys.boot_completed=1)..."
for i in $(seq 1 180); do
  [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
  sleep 2
  [ "$i" = 180 ] && fail "Emulator did not finish booting in 6 minutes. See server/logs/emulator.log"
done
step "Emulator booted."

step "Building and installing debug app (gradlew installDebug)..."
cd "$ROOT/app"
chmod +x gradlew 2>/dev/null || true
./gradlew installDebug || fail "Gradle build/install failed."

step "Launching $PKG/.MainActivity..."
"$ADB" shell am start -n "$PKG/.MainActivity" || fail "Could not launch the app."
step "Done. TradeLens should now be visible on the emulator."
