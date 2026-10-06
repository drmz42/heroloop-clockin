#!/usr/bin/env bash
# Build an unsigned-for-release, debug-signed HeroLoop Seeker APK from android/seeker-app.
# Needs JDK 17 (JAVA_HOME) and an Android SDK with platform 36 + build-tools 36.0.0 (ANDROID_HOME).
# usage: scripts/clockin-build-apk-debug.sh   -> android/seeker-app/app/build/outputs/apk/debug/app-debug.apk
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
[[ -n $sdk && -d $sdk ]] || { echo 'ERROR: set ANDROID_HOME to an Android SDK (platform 36, build-tools 36.0.0)' >&2; exit 2; }
# README sets JAVA_HOME only; prefer that JDK over whatever java is on PATH.
[[ -z ${JAVA_HOME:-} ]] || export PATH=$JAVA_HOME/bin:$PATH
java -version 2>&1 | grep -q 'version "17' || { echo 'ERROR: JDK 17 is required (set JAVA_HOME/PATH)' >&2; exit 2; }
project=$repo/android/seeker-app
printf 'sdk.dir=%s\n' "$sdk" >"$project/local.properties"
(cd "$project" && ./gradlew -q assembleDebug)
apk=$project/app/build/outputs/apk/debug/app-debug.apk
[[ -s $apk ]] || { echo 'ERROR: APK was not produced' >&2; exit 1; }
echo "APK: $apk"; sha256sum "$apk"
