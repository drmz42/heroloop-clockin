#!/usr/bin/env bash
# Build the HeroLoop Seeker TWA APK (android/seeker-twa) reproducibly on VPS1.
# usage: scripts/build-seeker-apk.sh <version-code> <version-name> [host]
# Toolchain (JDK 17, Android SDK 36, Gradle cache) lives under $HEROLOOP_ANDROID_TOOLS
# (default /var/tmp/hk-android) and is downloaded on first use. Signing needs sudo:
# the key and its password stay root-only in /var/lib/heroloop-android-signing and
# the signed APK plus its SHA-256 land in /var/lib/heroloop-android-builds/<name>-<code>/.
set -euo pipefail
code=${1:?usage: build-seeker-apk.sh <version-code> <version-name> [host]}
name=${2:?usage: build-seeker-apk.sh <version-code> <version-name> [host]}
host=${3:-staging2.heroloop.xyz}
[[ $code =~ ^[1-9][0-9]{0,8}$ && $name =~ ^[0-9A-Za-z.+-]{1,40}$ && $host =~ ^[a-z0-9.-]+$ ]] || { echo 'ERROR: bad arguments' >&2; exit 2; }
repo=$(cd "$(dirname "$0")/.." && pwd)
tools=${HEROLOOP_ANDROID_TOOLS:-/var/tmp/hk-android}
jdk=$tools/jdk17
sdk=$tools/sdk
mkdir -p "$tools"
if [[ ! -x $jdk/bin/java ]]; then
  curl -fsSL -o "$tools/jdk17.tgz" 'https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse'
  mkdir -p "$jdk" && tar -xzf "$tools/jdk17.tgz" -C "$jdk" --strip-components=1
fi
export JAVA_HOME=$jdk PATH=$jdk/bin:$PATH ANDROID_HOME=$sdk GRADLE_USER_HOME=$tools/gradle-home
if [[ ! -x $sdk/cmdline-tools/latest/bin/sdkmanager ]]; then
  curl -fsSL -o "$tools/cmdtools.zip" https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
  mkdir -p "$sdk/cmdline-tools" && unzip -qo "$tools/cmdtools.zip" -d "$sdk/cmdline-tools"
  rm -rf "$sdk/cmdline-tools/latest" && mv "$sdk/cmdline-tools/cmdline-tools" "$sdk/cmdline-tools/latest"
fi
if [[ ! -d $sdk/platforms/android-36 || ! -x $sdk/build-tools/36.0.0/apksigner ]]; then
  # `yes |` would trip pipefail with SIGPIPE, so feed the licence answers by redirection.
  "$sdk/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$sdk" 'platforms;android-36' 'build-tools;36.0.0' >/dev/null < <(yes)
fi
bt=$sdk/build-tools/36.0.0
project=$repo/android/seeker-twa
printf 'sdk.dir=%s\n' "$sdk" >"$project/local.properties"
# android/seeker-twa is a Bubblewrap-generated project (@bubblewrap/core 1.25.0); its host
# and launch URL live in app/build.gradle, so a different host means regenerating it.
grep -q "hostName: '$host'" "$project/app/build.gradle" || { echo "ERROR: project is generated for another host than $host" >&2; exit 2; }
sed -i -E "s/^( *versionCode )[0-9]+/\1$code/; s/^( *versionName )\"[^\"]*\"/\1\"$name\"/" "$project/app/build.gradle"
(cd "$project" && ./gradlew -q clean assembleRelease)
work=$(mktemp -d "$tools/apk.XXXXXX")
"$bt/zipalign" -f -p 4 "$project/app/build/outputs/apk/release/app-release-unsigned.apk" "$work/aligned.apk"
out=/var/lib/heroloop-android-builds/$name-$code
apk=$out/heroloop-seeker-$name-$code.apk
sudo -n install -d -o root -g root -m 0755 /var/lib/heroloop-android-builds "$out"
sudo -n env JAVA_HOME="$JAVA_HOME" PATH="$PATH" "$bt/apksigner" sign \
  --ks /var/lib/heroloop-android-signing/lab-upload.jks --ks-key-alias heroloop-lab \
  --ks-pass file:/var/lib/heroloop-android-signing/lab-upload.password --out "$apk" "$work/aligned.apk"
rm -rf "$work"
"$bt/apksigner" verify --print-certs "$apk" | grep 'SHA-256'
(cd "$out" && sha256sum "${apk##*/}" | sudo -n tee "${apk##*/}.sha256")
sudo -n chmod 0644 "$apk" "$apk.sha256"
printf 'source_commit=%s\n' "$(git -C "$repo" rev-parse HEAD)" | sudo -n tee "$out/build-info.txt" >/dev/null
