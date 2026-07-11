#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/opt/android-sdk}}"

fail=0
check() {
  if command -v "$1" >/dev/null 2>&1; then
    printf 'ok   %-12s %s\n' "$1" "$(command -v "$1")"
  else
    printf 'miss %-12s %s\n' "$1" "$2" >&2
    fail=1
  fi
}

check java 'install JDK 21'
check keytool 'install JDK 21'
check node 'install Node.js 20 or newer'
check npm 'install npm'

if [[ -x "$SDK_ROOT/platform-tools/adb" ]]; then
  printf 'ok   %-12s %s\n' adb "$SDK_ROOT/platform-tools/adb"
else
  printf 'miss %-12s expected under %s\n' adb "$SDK_ROOT" >&2
  fail=1
fi

if [[ -d "$SDK_ROOT/platforms/android-36" ]]; then
  printf 'ok   %-12s %s\n' android-36 "$SDK_ROOT/platforms/android-36"
else
  printf 'miss %-12s install platforms;android-36\n' android-36 >&2
  fail=1
fi

if [[ ! -f "$ROOT_DIR/android/local.properties" ]]; then
  printf 'sdk.dir=%s\n' "$SDK_ROOT" > "$ROOT_DIR/android/local.properties"
  printf 'made %-12s %s\n' local.properties "$ROOT_DIR/android/local.properties"
fi

exit "$fail"
