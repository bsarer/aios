#!/usr/bin/env bash
# R1: builds the Astra package from this checkout. Run it on Arch (Omarchy) as yourself:
#   packaging/arch/build.sh -s         makes (-s installs what the build needs with pacman)
#                                       astra-<version>-1-<arch>.pkg.tar.zst in packaging/arch/out
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
# U1: the commit and this checkout, so `astra update` and /update know where to update from.
commit=$(git -C "$root" rev-parse HEAD)
info=$(node -e 'process.stdout.write(JSON.stringify({ commit: process.argv[1], source: process.argv[2] }))' "$commit" "$root")
git -C "$root" archive --format=tar.gz --prefix="astra-$ver/" --add-virtual-file="astra-$ver/BUILD_INFO.json:$info" -o "$out/astra-$ver.tar.gz" HEAD
tar -tzf "$out/astra-$ver.tar.gz" | grep -qx "astra-$ver/BUILD_INFO.json" || { echo "build.sh: git archive didn't add BUILD_INFO.json (git 2.38 or newer needed)" >&2; exit 1; }
cd "$out"
# The package runs on /usr/bin/node, so its database module must be built by that Node too, not
# by one from mise or nvm earlier on PATH (a different Node can't load it).
PATH="/usr/bin:/bin:$PATH" makepkg --cleanbuild --force --noconfirm "$@"
ls -1 "$out"/*.pkg.tar.zst
