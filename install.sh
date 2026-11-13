#!/usr/bin/env bash
# P1, R1: install or upgrade Astra on Omarchy 4 from source (the Arch package is the other way).
#
#   ./install.sh                  install the newest release (v* tag), or upgrade to it; run again any time
#   ./install.sh --ref main       install a branch or tag instead
#   ./install.sh --check          only check this computer's prerequisites; change nothing
#   ./install.sh --restore FILE   put back a `pnpm backup` archive first, then install
#
# Astra goes into ~/.local/share/astra/app (AIOS_DIR to change it), cloned from AIOS_REPO (default:
# this clone's origin, else https://github.com/bsarer/aios.git). Then it runs `pnpm run setup`
# (first install) or `pnpm run setup --kiosk` (when a config exists) and `pnpm doctor`.
# An AI OS install from before R1 (only ~/.config/aios) keeps its folders, service and keyring.
# Nothing here reads or stores secrets; setup asks for them and keeps them in the keyring.
set -euo pipefail

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
# R1: the folder and service names, as packages/shared/src/brand.ts picks them.
if [[ ! -e $CONFIG_HOME/astra && -f $CONFIG_HOME/aios/config.toml ]]; then
  APP_DIR=aios SERVICE=aios-core.service
else
  APP_DIR=astra SERVICE=astra.service
fi
AIOS_DIR_GIVEN=${AIOS_DIR:-}
AIOS_DIR="${AIOS_DIR:-$DATA_HOME/$APP_DIR/app}"
OMARCHY_VERSION_FILE="${OMARCHY_PATH:-$DATA_HOME/omarchy}/version"
NODE_MIN=22.13
HYPRLAND_MIN=0.55

say() { printf '%s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

# True when version $1 >= $2 (dotted numbers; anything after the numbers is ignored).
version_ge() {
  local IFS=.
  # shellcheck disable=SC2206
  local a=(${1%%[^0-9.]*}) b=(${2%%[^0-9.]*})
  local i
  for i in 0 1 2; do
    local x=${a[i]:-0} y=${b[i]:-0}
    ((10#$x > 10#$y)) && return 0
    ((10#$x < 10#$y)) && return 1
  done
  return 0
}

# Prints one line per prerequisite; returns 1 when any is missing.
check_prereqs() {
  local bad=0 v
  if [[ -r $OMARCHY_VERSION_FILE ]] && v=$(head -n1 "$OMARCHY_VERSION_FILE") && [[ $v == 4.* ]]; then
    say "✓ Omarchy $v"
  else
    say "✗ Omarchy 4 not found (read ${OMARCHY_VERSION_FILE}: ${v:-missing}). Astra targets Omarchy 4."
    bad=1
  fi
  v=$(hyprctl version 2>/dev/null | grep -oE 'Hyprland [0-9]+\.[0-9]+(\.[0-9]+)?' | head -n1 | cut -d' ' -f2 || true)
  if [[ -z $v ]]; then
    say "! Hyprland version unknown (run this inside the desktop session to check it)"
  elif version_ge "$v" "$HYPRLAND_MIN"; then
    say "✓ Hyprland $v"
  else
    say "✗ Hyprland $v is older than $HYPRLAND_MIN; update Omarchy first"
    bad=1
  fi
  v=$(node -p 'process.versions.node' 2>/dev/null || true)
  if [[ -n $v ]] && version_ge "$v" "$NODE_MIN"; then
    say "✓ Node $v"
  else
    say "✗ Node ${v:-missing}; Astra needs $NODE_MIN or newer (Omarchy: \`mise use -g node@22\`)"
    bad=1
  fi
  if v=$(pnpm --version 2>/dev/null); then
    say "✓ pnpm $v"
  else
    say "✗ pnpm missing (\`corepack enable pnpm\` sets it up from Node)"
    bad=1
  fi
  for v in git tar secret-tool; do
    if command -v "$v" >/dev/null 2>&1; then say "✓ $v"; else say "✗ $v missing"; bad=1; fi
  done
  return $bad
}

# A path relative to $HOME, or empty when it is outside it.
home_rel() { [[ $1 == "$HOME"/* ]] && printf '%s' "${1#"$HOME"/}"; return 0; }

# Checks a `pnpm backup` archive before anything is unpacked: only plain files and folders,
# only under this install's config and data folders or built apps' launcher entries, no '..'.
check_backup() {
  local file=$1 cfg data apps line type name names
  [[ -f $file ]] || { say "no such file: $file"; return 1; }
  local listing
  listing=$(tar -tvzf "$file" 2>/dev/null) || { say "$file is not a .tar.gz archive"; return 1; }
  names=$(tar -tzf "$file")
  [[ -n $names ]] || { say "$file is empty"; return 1; }
  # R1: an AI OS backup (aios folders) goes back as an AI OS install, an Astra one as Astra.
  local c d has_aios=0 has_astra=0
  c=$(home_rel "$CONFIG_HOME") d=$(home_rel "$DATA_HOME")
  while IFS= read -r name; do
    name=${name#./}
    case $name in
      "$c"/aios | "$c"/aios/* | "$d"/aios | "$d"/aios/*) has_aios=1 ;;
      "$c"/astra | "$c"/astra/* | "$d"/astra | "$d"/astra/*) has_astra=1 ;;
    esac
  done <<<"$names"
  ((has_aios && has_astra)) && { say "refused: $file holds both AI OS and Astra folders"; return 1; }
  if ((has_aios)); then APP_DIR=aios SERVICE=aios-core.service; elif ((has_astra)); then APP_DIR=astra SERVICE=astra.service; fi
  cfg=$(home_rel "$CONFIG_HOME/$APP_DIR") data=$(home_rel "$DATA_HOME/$APP_DIR") apps=$(home_rel "$DATA_HOME/applications")
  [[ -n $c && -n $d && -n $apps ]] || { say "the $APP_DIR folders are outside $HOME; restore by hand"; return 1; }
  while IFS= read -r line; do
    type=${line:0:1}
    [[ $type == - || $type == d ]] || { say "refused: $file holds a link or special file: $line"; return 1; }
  done <<<"$listing"
  while IFS= read -r name; do
    name=${name#./}
    name=${name%/}
    if [[ $name == /* || /$name/ == */../* ]]; then
      say "refused: unsafe path in $file: $name"
      return 1
    fi
    case $name in
      "$cfg" | "$cfg"/* | "$data" | "$data"/*) ;;
      "$apps"/aios-app-*.desktop) [[ ${name#"$apps"/aios-app-} =~ ^[a-z0-9-]+\.desktop$ ]] || { say "refused: unexpected file in $file: $name"; return 1; } ;;
      *) say "refused: $file holds something that is not this install's ($APP_DIR): $name"; return 1 ;;
    esac
    [[ $name == "$data"/app || $name == "$data"/app/* ]] && { say "refused: $file holds an installed copy of the app ($name)"; return 1; }
  done <<<"$names"
  return 0
}

# Puts a checked backup back. What is there now is moved aside, never deleted.
restore_backup() {
  local file=$1 stamp aside
  stamp=$(date +%Y%m%d-%H%M%S)
  systemctl --user stop "$SERVICE" 2>/dev/null || true
  if [[ -e $CONFIG_HOME/$APP_DIR ]]; then
    mv "$CONFIG_HOME/$APP_DIR" "$CONFIG_HOME/$APP_DIR.before-restore-$stamp"
    say "moved the current config to $CONFIG_HOME/$APP_DIR.before-restore-$stamp"
  fi
  if [[ -d $DATA_HOME/$APP_DIR ]]; then
    aside="$DATA_HOME/$APP_DIR.before-restore-$stamp"
    local entry moved=0
    shopt -s dotglob nullglob
    for entry in "$DATA_HOME/$APP_DIR"/*; do
      [[ $entry == "$DATA_HOME/$APP_DIR/app" ]] && continue
      mkdir -p "$aside"
      mv "$entry" "$aside/"
      moved=1
    done
    shopt -u dotglob nullglob
    ((moved)) && say "moved the current data to $aside"
  fi
  tar -xzf "$file" -C "$HOME" --no-same-owner --no-same-permissions
  chmod 700 "$CONFIG_HOME/$APP_DIR" 2>/dev/null || true
  say "restored $file"
}

repo_url() {
  if [[ -n ${AIOS_REPO:-} ]]; then printf '%s' "$AIOS_REPO"; return; fi
  local here
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  git -C "$here" remote get-url origin 2>/dev/null || printf '%s' 'https://github.com/bsarer/aios.git'
}

# Clones or updates $AIOS_DIR and checks out $1 (default: the newest v* tag, else main).
fetch_source() {
  local ref=$1
  if [[ -d $AIOS_DIR/.git ]]; then
    [[ -z $(git -C "$AIOS_DIR" status --porcelain) ]] || die "$AIOS_DIR has local changes; commit or remove them first"
    git -C "$AIOS_DIR" fetch --tags --force --prune origin
  elif [[ -e $AIOS_DIR ]]; then
    die "$AIOS_DIR exists and is not a git clone; move it away first"
  else
    mkdir -p "$(dirname "$AIOS_DIR")"
    git clone --quiet "$(repo_url)" "$AIOS_DIR"
  fi
  if [[ -z $ref ]]; then
    ref=$(git -C "$AIOS_DIR" tag -l 'v*' --sort=-v:refname | head -n1)
    ref=${ref:-main}
  fi
  if git -C "$AIOS_DIR" rev-parse --verify --quiet "refs/remotes/origin/$ref" >/dev/null; then
    git -C "$AIOS_DIR" checkout --quiet -B "$ref" "origin/$ref"
  else
    git -C "$AIOS_DIR" checkout --quiet --detach "refs/tags/$ref" 2>/dev/null || die "no tag or branch called $ref"
  fi
  say "Astra $ref ($(git -C "$AIOS_DIR" rev-parse --short HEAD)) in $AIOS_DIR"
}

main() {
  local ref='' check=0 restore=''
  while (($#)); do
    case $1 in
      --ref) ref=${2:?--ref needs a tag or branch}; shift ;;
      --check) check=1 ;;
      --restore) restore=${2:?--restore needs a backup file}; shift ;;
      -h | --help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; return 0 ;;
      *) die "unknown option $1 (see --help)" ;;
    esac
    shift
  done
  [[ -n ${HOME:-} ]] || die "HOME is not set"
  # AIOS_ALLOW_ROOT is for tests in containers that run as root.
  [[ $EUID -ne 0 || -n ${AIOS_ALLOW_ROOT:-} ]] || die "run this as yourself, not root"

  say "Checking this computer:"
  if ! check_prereqs; then
    ((check)) && return 1
    die "fix the ✗ lines above, then run install.sh again"
  fi
  if [[ -n $restore ]]; then
    check_backup "$restore" || die "nothing was changed"
    say "✓ $restore is a backup of $APP_DIR"
  fi
  ((check)) && { say "Ready to install."; return 0; }

  if [[ -n $restore ]]; then
    restore_backup "$restore"
    # The backup decides which names this install has (R1).
    [[ -n $AIOS_DIR_GIVEN ]] || AIOS_DIR="$DATA_HOME/$APP_DIR/app"
  fi
  fetch_source "$ref"
  cd "$AIOS_DIR"
  pnpm install --frozen-lockfile
  pnpm --filter @aios/ui build
  # setup asks questions; read them from the terminal even when this script came through a pipe.
  local args=()
  [[ -f $CONFIG_HOME/$APP_DIR/config.toml ]] && args=(--kiosk)
  if [[ ! -t 0 ]] && { : </dev/tty; } 2>/dev/null; then
    pnpm run setup "${args[@]}" </dev/tty
  else
    pnpm run setup "${args[@]}"
  fi
  say ""
  say "Checking the install (pnpm doctor):"
  pnpm doctor || say "Some checks failed; each line above says how to fix it. Run \`pnpm doctor\` in $AIOS_DIR again after."
}

# Tests source this file to call the functions; running it installs.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
