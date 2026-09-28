#!/usr/bin/env bash
# Gradle and Maven for the JVM fixtures, unpacked under $FG_TMP/tools/<name> so that
# tools/gradle/bin and tools/maven/bin exist. Versions are resolved when this runs: Gradle's current
# release from services.gradle.org, Maven's newest final release from the Maven Central metadata.
# A Temurin JDK (the most recent LTS, from the Adoptium API) goes to tools/jdk only when no working
# java is found, or when FG_INSTALL_JDK=1.
set -euo pipefail

: "${FG_TMP:?run this through scripts/toolchains.sh}"
tools="$FG_TMP/tools"
downloads="$FG_TMP/cache/downloads"
mkdir -p "$tools" "$downloads"

# Hex digest of file $2 with SHA-$1.
digest() {
  if command -v "sha$1sum" > /dev/null; then "sha$1sum" "$2"; else shasum -a "$1" "$2"; fi |
    cut -d' ' -f1
}

check() {
  local bits=$1 file=$2 want=$3 got
  got=$(digest "$bits" "$file")
  if [ "$got" != "$want" ]; then
    echo "checksum mismatch for $file: expected $want, got $got" >&2
    exit 1
  fi
}

# Unpacks archive $2 and moves its single top-level directory (or, for a macOS JDK, the
# Contents/Home inside it) to $tools/$1.
unpack() {
  local name=$1 archive=$2 staging="$downloads/$1-staging" top
  rm -rf "$staging" && mkdir -p "$staging"
  case "$archive" in
    *.zip) unzip -q "$archive" -d "$staging" ;;
    *) tar -xzf "$archive" -C "$staging" ;;
  esac
  top=$(find "$staging" -mindepth 1 -maxdepth 1 -type d)
  [ -d "$top/Contents/Home" ] && top="$top/Contents/Home"
  rm -rf "${tools:?}/$name"
  mv "$top" "$tools/$name"
  rm -rf "$staging"
}

installed() {
  [ -f "$tools/$1/.falsegreen-version" ] && [ "$(cat "$tools/$1/.falsegreen-version")" = "$2" ]
}

# Prints the value at a dotted key path ("0.binary.package.link") of the JSON on stdin.
json() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      console.log(process.argv[1].split(".").reduce((v, k) => v[k], JSON.parse(s)));
    });' "$1"
}

gradle_version=$(curl -fsSL https://services.gradle.org/versions/current | json version)
if installed gradle "$gradle_version"; then
  echo "gradle $gradle_version already in $tools/gradle"
else
  echo "installing gradle $gradle_version"
  url="https://services.gradle.org/distributions/gradle-$gradle_version-bin.zip"
  zip="$downloads/gradle-$gradle_version-bin.zip"
  curl -fsSL -o "$zip" "$url"
  check 256 "$zip" "$(curl -fsSL "$url.sha256")"
  unpack gradle "$zip"
  echo "$gradle_version" > "$tools/gradle/.falsegreen-version"
fi

maven_base=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven
# Final releases only: the metadata's <release> can be a release candidate.
maven_version=$(curl -fsSL "$maven_base/maven-metadata.xml" |
  sed -n 's/.*<version>\([0-9.]*\)<\/version>.*/\1/p' | sort -V | tail -1)
if installed maven "$maven_version"; then
  echo "maven $maven_version already in $tools/maven"
else
  echo "installing maven $maven_version"
  url="$maven_base/$maven_version/apache-maven-$maven_version-bin.tar.gz"
  tarball="$downloads/apache-maven-$maven_version-bin.tar.gz"
  curl -fsSL -o "$tarball" "$url"
  check 512 "$tarball" "$(curl -fsSL "$url.sha512" | cut -d' ' -f1)"
  unpack maven "$tarball"
  echo "$maven_version" > "$tools/maven/.falsegreen-version"
fi

if [ "${FG_INSTALL_JDK:-0}" != 1 ] && java -version > /dev/null 2>&1; then
  echo "using the java already on PATH: $(java -version 2>&1 | head -1)"
  exit 0
fi

lts=$(curl -fsSL https://api.adoptium.net/v3/info/available_releases | json most_recent_lts)
case "$(uname -s)" in
  Darwin) os=mac ;;
  Linux) os=linux ;;
  *) echo "no Temurin download for $(uname -s); install JDK $lts yourself" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=aarch64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) echo "no Temurin download for $(uname -m); install JDK $lts yourself" >&2; exit 1 ;;
esac
assets=$(curl -fsSL "https://api.adoptium.net/v3/assets/latest/$lts/hotspot?architecture=$arch&image_type=jdk&os=$os&vendor=eclipse")
url=$(json 0.binary.package.link <<< "$assets")
if installed jdk "$url"; then
  echo "Temurin $lts already in $tools/jdk"
  exit 0
fi
echo "installing Temurin JDK $lts ($os/$arch)"
tarball="$downloads/temurin-$lts-$os-$arch.tar.gz"
curl -fsSL -o "$tarball" "$url"
check 256 "$tarball" "$(json 0.binary.package.checksum <<< "$assets")"
unpack jdk "$tarball"
echo "$url" > "$tools/jdk/.falsegreen-version"
"$tools/jdk/bin/java" -version 2>&1 | head -1
