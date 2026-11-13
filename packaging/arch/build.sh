#!/usr/bin/env bash
# R1: builds the Astra package from this checkout. Run it on Arch (Omarchy) as yourself:
#   packaging/arch/build.sh            makes astra-<version>-1-<arch>.pkg.tar.zst in packaging/arch/out
#   sudo pacman -U packaging/arch/out/astra-*.pkg.tar.zst
# It packs the committed files (git archive), so commit first.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(git -C "$here" rev-parse --show-toplevel)
ver=$(node -p "require('$root/package.json').version")
grep -q "^pkgver=$ver\$" "$here/PKGBUILD" || { echo "build.sh: package.json is $ver but PKGBUILD has another pkgver" >&2; exit 1; }
out="$here/out"
rm -rf "$out" && mkdir -p "$out"
cp "$here/PKGBUILD" "$out/"
git -C "$root" archive --format=tar.gz --prefix="astra-$ver/" -o "$out/astra-$ver.tar.gz" HEAD
cd "$out"
makepkg --cleanbuild --force --noconfirm "$@"
ls -1 "$out"/*.pkg.tar.zst
