#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIGNING_DIR="$ROOT_DIR/.papo"
KEYSTORE="$SIGNING_DIR/android-release.keystore"
PROPERTIES="$SIGNING_DIR/android-signing.properties"

command -v keytool >/dev/null || { echo 'JDK keytool is required' >&2; exit 1; }
command -v openssl >/dev/null || { echo 'openssl is required' >&2; exit 1; }

mkdir -p "$SIGNING_DIR"
chmod 700 "$SIGNING_DIR"

if [[ ! -f "$KEYSTORE" || ! -f "$PROPERTIES" ]]; then
  password="$(openssl rand -hex 24)"
  keytool -genkeypair -v -keystore "$KEYSTORE" -storepass "$password" \
    -alias papo -keypass "$password" -keyalg RSA -keysize 3072 -validity 10000 \
    -dname 'CN=Papo, OU=Papo, O=Jerrypsy, C=DE'
  {
    printf 'storeFile=%s\n' "$KEYSTORE"
    printf 'storePassword=%s\n' "$password"
    printf 'keyAlias=papo\n'
    printf 'keyPassword=%s\n' "$password"
  } > "$PROPERTIES"
  chmod 600 "$KEYSTORE" "$PROPERTIES"
  echo "Created local Android signing identity in $SIGNING_DIR"
fi

cd "$ROOT_DIR"
npm run android:sync
(
  cd android
  ./gradlew assembleRelease
)
mkdir -p artifacts
cp android/app/build/outputs/apk/release/app-release.apk artifacts/papo-release.apk
echo "Built $ROOT_DIR/artifacts/papo-release.apk"
