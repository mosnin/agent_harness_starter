#!/usr/bin/env bash
#
# install.sh -- the real POSIX installer for hades.
#
# This script is the only thing that ever touches the machine: it resolves
# targets, checks prerequisites, writes the launcher, and edits a shell
# profile. Its decisions mirror `src/hades/install/plan.ts` (the pure,
# unit-tested planner that is this behavior's single source of truth) --
# same precedence, same blocker codes/messages/remedies, same exit codes --
# but it is deliberately self-sufficient bash: the prerequisite checks below
# (most importantly "is node even present/new enough") must work correctly
# even when node is missing or broken, so this script cannot depend on
# shelling out to node to make those decisions.
#
# Usage: install.sh [--dry-run] [--prefix DIR] [--bin-dir DIR]
#                    [--data-dir DIR] [--no-modify-path] [--force] [--purge]
#                    [--uninstall] [--json] [--version] [--help]
#
# Exit codes: 0 = ok/noop, 1 = blocked (unmet prerequisite), 2 = usage error.
set -euo pipefail

INSTALL_SH_VERSION="1.0.0"
MIN_NODE_MAJOR=20

# ---------------------------------------------------------------------------
# Locate ourselves and the app version we are installing.
# ---------------------------------------------------------------------------
SOURCE="${BASH_SOURCE[0]}"
REPO_ROOT="$(cd -- "$(dirname -- "$SOURCE")" >/dev/null 2>&1 && pwd -P)"

app_version() {
  local pkg="${REPO_ROOT}/package.json"
  if [[ -f "$pkg" ]]; then
    local v
    v="$(grep -m1 '"version"[[:space:]]*:' "$pkg" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')"
    if [[ -n "$v" ]]; then
      printf '%s' "$v"
      return 0
    fi
  fi
  printf '0.0.0'
}
VERSION="$(app_version)"

usage() {
  cat <<'EOF'
Usage: install.sh [OPTIONS]

Options:
  --dry-run          Print what would happen; touch nothing on disk.
  --prefix DIR       Install root; implies --bin-dir DIR/bin and
                      --data-dir DIR/share/hades unless those are also given.
  --bin-dir DIR       Where to put the `hades` launcher.
  --data-dir DIR      Where hades keeps its state.
  --no-modify-path    Do not edit a shell profile to add --bin-dir to PATH.
  --force             Reinstall even if the same version is already present.
  --purge             With --uninstall, also remove --data-dir.
  --uninstall         Remove a previous install instead of creating one.
  --json              Emit a single JSON object describing the plan/result.
  --version           Print this script's own version and exit.
  --help              Show this help and exit.

Exit codes: 0 ok/noop, 1 blocked (unmet prerequisite), 2 usage error.
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
DRY_RUN=0
PREFIX_OPT=""
BIN_DIR_OPT=""
DATA_DIR_OPT=""
MODIFY_PATH=1
FORCE=0
PURGE=0
UNINSTALL=0
JSON_MODE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --prefix)
      [[ $# -ge 2 ]] || { echo "install.sh: --prefix requires an argument" >&2; usage >&2; exit 2; }
      PREFIX_OPT="$2"
      shift 2
      ;;
    --bin-dir)
      [[ $# -ge 2 ]] || { echo "install.sh: --bin-dir requires an argument" >&2; usage >&2; exit 2; }
      BIN_DIR_OPT="$2"
      shift 2
      ;;
    --data-dir)
      [[ $# -ge 2 ]] || { echo "install.sh: --data-dir requires an argument" >&2; usage >&2; exit 2; }
      DATA_DIR_OPT="$2"
      shift 2
      ;;
    --no-modify-path)
      MODIFY_PATH=0
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --purge)
      PURGE=1
      shift
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    --json)
      JSON_MODE=1
      shift
      ;;
    --version)
      echo "install.sh ${INSTALL_SH_VERSION}"
      exit 0
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "install.sh: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Shell quoting (mirrors plan.ts's shQuote exactly -- POSIX single-quote
# escaping, safe for spaces and unicode).
# ---------------------------------------------------------------------------
sh_quote() {
  local s=$1
  local q="'"
  local esc="'\\''"
  printf "%s" "'${s//$q/$esc}'"
}

# JSON-string-escape a value (used only in --json mode output).
json_escape() {
  local s=$1
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  local out="" c
  local i len
  len=${#s}
  out=""
  for (( i = 0; i < len; i++ )); do
    c="${s:i:1}"
    if [[ "$c" == $'\n' ]]; then
      out+='\n'
    elif [[ "$c" == $'\t' ]]; then
      out+='\t'
    elif [[ "$c" == $'\r' ]]; then
      out+='\r'
    else
      out+="$c"
    fi
  done
  printf '%s' "$out"
}

json_str() {
  printf '"%s"' "$(json_escape "$1")"
}

# ---------------------------------------------------------------------------
# Target resolution (mirrors plan.ts's resolveTargets precedence exactly:
# explicit option > HADES_BIN_DIR/HADES_DATA_DIR > XDG_BIN_HOME/XDG_DATA_HOME
# > ~/.local/bin and ~/.hades, with --prefix DIR as a DIR/bin, DIR/share/hades
# shorthand tier).
# ---------------------------------------------------------------------------
strip_trailing_slash() {
  local p=$1
  if [[ "$p" != "/" && "$p" == */ ]]; then
    printf '%s' "${p%/}"
  else
    printf '%s' "$p"
  fi
}

if [[ -n "$PREFIX_OPT" ]]; then
  PREFIX_OPT="$(strip_trailing_slash "$PREFIX_OPT")"
fi

if [[ -n "$BIN_DIR_OPT" ]]; then
  BIN_DIR="$BIN_DIR_OPT"
elif [[ -n "$PREFIX_OPT" ]]; then
  BIN_DIR="${PREFIX_OPT}/bin"
elif [[ -n "${HADES_BIN_DIR:-}" ]]; then
  BIN_DIR="$HADES_BIN_DIR"
elif [[ -n "${XDG_BIN_HOME:-}" ]]; then
  BIN_DIR="$XDG_BIN_HOME"
else
  BIN_DIR="${HOME}/.local/bin"
fi

if [[ -n "$DATA_DIR_OPT" ]]; then
  DATA_DIR="$DATA_DIR_OPT"
elif [[ -n "$PREFIX_OPT" ]]; then
  DATA_DIR="${PREFIX_OPT}/share/hades"
elif [[ -n "${HADES_DATA_DIR:-}" ]]; then
  DATA_DIR="$HADES_DATA_DIR"
elif [[ -n "${XDG_DATA_HOME:-}" ]]; then
  DATA_DIR="$(strip_trailing_slash "$XDG_DATA_HOME")/hades"
else
  DATA_DIR="${HOME}/.hades"
fi

if [[ -n "$PREFIX_OPT" ]]; then
  PREFIX="$PREFIX_OPT"
else
  PREFIX="$(dirname -- "$BIN_DIR")"
fi

LAUNCHER_PATH="${BIN_DIR}/hades"

# ---------------------------------------------------------------------------
# Shell / profile detection (mirrors plan.ts's detectShell/profileForShell).
# ---------------------------------------------------------------------------
SHELL_BASE="$(basename -- "${SHELL:-}" 2>/dev/null || true)"
case "$SHELL_BASE" in
  bash) SHELL_KIND="bash" ;;
  zsh) SHELL_KIND="zsh" ;;
  fish) SHELL_KIND="fish" ;;
  sh) SHELL_KIND="sh" ;;
  *) SHELL_KIND="unknown" ;;
esac

PROFILE_PATH=""
PROFILE_LINE=""
case "$SHELL_KIND" in
  bash)
    PROFILE_PATH="${HOME}/.bashrc"
    PROFILE_LINE="export PATH=\"${BIN_DIR}:\$PATH\""
    ;;
  zsh)
    PROFILE_PATH="${HOME}/.zshrc"
    PROFILE_LINE="export PATH=\"${BIN_DIR}:\$PATH\""
    ;;
  sh)
    PROFILE_PATH="${HOME}/.profile"
    PROFILE_LINE="export PATH=\"${BIN_DIR}:\$PATH\""
    ;;
  fish)
    PROFILE_PATH="${HOME}/.config/fish/config.fish"
    PROFILE_LINE="set -gx PATH $(sh_quote "$BIN_DIR") \$PATH"
    ;;
esac

PATH_ALREADY_CONTAINS_BIN_DIR=0
IFS=':' read -r -a __path_entries <<< "${PATH:-}"
for __p in "${__path_entries[@]:-}"; do
  if [[ "$__p" == "$BIN_DIR" ]]; then
    PATH_ALREADY_CONTAINS_BIN_DIR=1
    break
  fi
done

# ---------------------------------------------------------------------------
# Launcher script generation (mirrors plan.ts's launcherScript exactly --
# byte-for-byte, so launcherSha256 always matches what buildInstallPlan
# would compute for the same inputs).
# ---------------------------------------------------------------------------
generate_launcher() {
  local repo_root="$1" version="$2" node_bin="${3:-node}"
  local hades_entry
  hades_entry="$(strip_trailing_slash "$repo_root")/src/hades/bin/hades.ts"
  printf '%s' \
"#!/usr/bin/env bash
set -euo pipefail
# hades launcher -- generated by install.sh. Do not edit; re-run install.sh instead.
# installed version: ${version}
export HADES_INSTALL_VERSION=$(sh_quote "$version")
exec $(sh_quote "$node_bin") --import tsx $(sh_quote "$hades_entry") \"\$@\"
"
}

# Command substitution strips trailing newlines, but plan.ts's
# launcherScript() always ends with one -- guard it with a sentinel so the
# bytes this script writes/hashes/reports match buildInstallPlan() exactly.
LAUNCHER_SCRIPT="$(generate_launcher "$REPO_ROOT" "$VERSION"; printf 'X')"
LAUNCHER_SCRIPT="${LAUNCHER_SCRIPT%X}"
if command -v sha256sum >/dev/null 2>&1; then
  LAUNCHER_SHA256="$(printf '%s' "$LAUNCHER_SCRIPT" | sha256sum | cut -d' ' -f1)"
elif command -v shasum >/dev/null 2>&1; then
  LAUNCHER_SHA256="$(printf '%s' "$LAUNCHER_SCRIPT" | shasum -a 256 | cut -d' ' -f1)"
else
  echo "install.sh: neither sha256sum nor shasum is available" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Prerequisite checks & blockers (mirrors plan.ts's buildInstallPlan exactly
# -- same codes, same messages, same remedies -- implemented independently in
# bash because node-missing/node-too-old must be detectable without a
# working node).
# ---------------------------------------------------------------------------
declare -a BLOCKER_CODES=()
declare -a BLOCKER_MESSAGES=()
declare -a BLOCKER_REMEDIES=()

add_blocker() {
  BLOCKER_CODES+=("$1")
  BLOCKER_MESSAGES+=("$2")
  BLOCKER_REMEDIES+=("$3")
}

UNAME_S="$(uname -s 2>/dev/null || echo unknown)"
case "$UNAME_S" in
  Linux) PLATFORM="linux" ;;
  Darwin) PLATFORM="darwin" ;;
  FreeBSD) PLATFORM="freebsd" ;;
  OpenBSD) PLATFORM="openbsd" ;;
  *) PLATFORM="$(printf '%s' "$UNAME_S" | tr '[:upper:]' '[:lower:]')" ;;
esac

case "$PLATFORM" in
  linux|darwin|freebsd|openbsd) ;;
  *)
    add_blocker "unsupported-platform" \
      "platform ${PLATFORM} is not supported by install.sh" \
      'install manually: run "node --import tsx src/hades/bin/hades.ts" from the repo, or use a supported POSIX platform (linux, darwin, freebsd, openbsd)'
    ;;
esac

NODE_VERSION_RAW=""
if command -v node >/dev/null 2>&1; then
  NODE_VERSION_RAW="$(node --version 2>/dev/null || true)"
fi

NODE_MAJOR=""
if [[ -n "$NODE_VERSION_RAW" ]]; then
  if [[ "$NODE_VERSION_RAW" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
    NODE_MAJOR="${BASH_REMATCH[1]}"
  fi
fi

if [[ -z "$NODE_VERSION_RAW" || -z "$NODE_MAJOR" ]]; then
  add_blocker "node-missing" \
    "node was not found on PATH" \
    "install Node.js >= 20 (e.g. via nvm or your OS package manager) and re-run install.sh"
elif (( NODE_MAJOR < MIN_NODE_MAJOR )); then
  add_blocker "node-too-old" \
    "node ${NODE_VERSION_RAW} is older than the required v${MIN_NODE_MAJOR}" \
    "upgrade Node.js to >= 20 (e.g. via nvm install 20) and re-run install.sh"
fi

dir_writable() {
  # Climbs to the nearest existing ancestor of "$1", then attempts a real
  # (harmless, immediately-removed) write probe rather than trusting the
  # permission bits via `-w` -- the latter is unreliable when running as
  # root (root's DAC_OVERRIDE capability makes `-w` report true even for a
  # 000-mode or chattr +i directory it in fact cannot write into).
  local d="$1"
  while [[ ! -d "$d" ]]; do
    local parent
    parent="$(dirname -- "$d")"
    if [[ "$parent" == "$d" ]]; then
      break
    fi
    d="$parent"
  done
  local probe="${d}/.hades-write-probe.$$.$RANDOM"
  if ( : > "$probe" ) 2>/dev/null; then
    rm -f -- "$probe"
    return 0
  fi
  return 1
}

if [[ -n "$PREFIX_OPT" ]]; then
  if ! dir_writable "$PREFIX_OPT"; then
    add_blocker "prefix-not-writable" \
      "prefix ${PREFIX_OPT} is not writable" \
      "choose a writable --prefix, fix permissions on the directory, or re-run with sudo"
  fi
fi
if ! dir_writable "$BIN_DIR"; then
  add_blocker "bin-dir-not-writable" \
    "bin directory ${BIN_DIR} is not writable" \
    "choose a writable --bin-dir, fix permissions on the directory, or re-run with sudo"
fi

# ---------------------------------------------------------------------------
# Existing-install detection & mode.
# ---------------------------------------------------------------------------
EXISTING_VERSION=""
if [[ -f "$LAUNCHER_PATH" ]]; then
  EXISTING_VERSION="$(grep -m1 '^# installed version: ' "$LAUNCHER_PATH" 2>/dev/null | sed 's/^# installed version: //' || true)"
fi

version_cmp() {
  # Echoes -1, 0, or 1. Unparsable input sorts as 0.0.0 (mirrors
  # plan.ts's compareNodeVersion).
  local a="$1" b="$2"
  local am=0 an=0 ap=0 bm=0 bn=0 bp=0
  if [[ "$a" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
    am="${BASH_REMATCH[1]}"; an="${BASH_REMATCH[2]}"; ap="${BASH_REMATCH[3]}"
  fi
  if [[ "$b" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
    bm="${BASH_REMATCH[1]}"; bn="${BASH_REMATCH[2]}"; bp="${BASH_REMATCH[3]}"
  fi
  if (( am != bm )); then [[ $am -lt $bm ]] && echo -1 || echo 1; return; fi
  if (( an != bn )); then [[ $an -lt $bn ]] && echo -1 || echo 1; return; fi
  if (( ap != bp )); then [[ $ap -lt $bp ]] && echo -1 || echo 1; return; fi
  echo 0
}

MODE=""
if [[ "$UNINSTALL" -eq 1 ]]; then
  if [[ -z "$EXISTING_VERSION" ]]; then
    MODE="noop"
    add_blocker "nothing-to-uninstall" \
      "no hades installation was found to uninstall" \
      "nothing to do -- install first with install.sh, or pass --prefix/--bin-dir matching the existing install"
  else
    MODE="uninstall"
  fi
elif [[ -z "$EXISTING_VERSION" ]]; then
  MODE="install"
elif [[ "$FORCE" -eq 1 ]]; then
  MODE="reinstall"
elif [[ "$(version_cmp "$EXISTING_VERSION" "$VERSION")" == "-1" ]]; then
  MODE="upgrade"
else
  MODE="noop"
  add_blocker "existing-install" \
    "hades ${EXISTING_VERSION} is already installed at ${LAUNCHER_PATH}" \
    "use --force to reinstall, or bump the version being installed"
fi

OK=1
if [[ "${#BLOCKER_CODES[@]}" -gt 0 ]]; then
  OK=0
fi

# ---------------------------------------------------------------------------
# --json output (field names match renderPlanJson(buildInstallPlan(...))).
# ---------------------------------------------------------------------------
emit_json() {
  local ok_json="false"
  [[ "$OK" -eq 1 ]] && ok_json="true"
  local path_json="false"
  [[ "$PATH_ALREADY_CONTAINS_BIN_DIR" -eq 1 ]] && path_json="true"

  local profile_path_json="null"
  local profile_line_json="null"
  if [[ -n "$PROFILE_PATH" ]]; then
    profile_path_json="$(json_str "$PROFILE_PATH")"
    profile_line_json="$(json_str "$PROFILE_LINE")"
  fi

  local blockers_json="[]"
  if [[ "${#BLOCKER_CODES[@]}" -gt 0 ]]; then
    blockers_json="["
    local i
    for (( i = 0; i < ${#BLOCKER_CODES[@]}; i++ )); do
      [[ $i -gt 0 ]] && blockers_json+=","
      blockers_json+="{\"code\":$(json_str "${BLOCKER_CODES[$i]}"),\"message\":$(json_str "${BLOCKER_MESSAGES[$i]}"),\"remedy\":$(json_str "${BLOCKER_REMEDIES[$i]}")}"
    done
    blockers_json+="]"
  fi

  printf '{'
  printf '"mode":%s,' "$(json_str "$MODE")"
  printf '"ok":%s,' "$ok_json"
  printf '"version":%s,' "$(json_str "$VERSION")"
  printf '"prefix":%s,' "$(json_str "$PREFIX")"
  printf '"binDir":%s,' "$(json_str "$BIN_DIR")"
  printf '"dataDir":%s,' "$(json_str "$DATA_DIR")"
  printf '"launcherPath":%s,' "$(json_str "$LAUNCHER_PATH")"
  printf '"launcherScript":%s,' "$(json_str "$LAUNCHER_SCRIPT")"
  printf '"launcherSha256":%s,' "$(json_str "$LAUNCHER_SHA256")"
  printf '"shell":%s,' "$(json_str "$SHELL_KIND")"
  printf '"profilePath":%s,' "$profile_path_json"
  printf '"profileLine":%s,' "$profile_line_json"
  printf '"pathAlreadyContainsBinDir":%s,' "$path_json"
  printf '"blockers":%s' "$blockers_json"
  printf '}\n'
}

if [[ "$JSON_MODE" -eq 1 ]]; then
  emit_json
  if [[ "$OK" -eq 1 ]]; then
    exit 0
  else
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Human-readable report, always printed (mirrors renderPlanText's content).
# ---------------------------------------------------------------------------
echo "hades installer -- mode: ${MODE}$( [[ "$OK" -eq 1 ]] || echo ' (blocked)' )"
echo "  version:   ${VERSION}"
echo "  prefix:    ${PREFIX}"
echo "  bin dir:   ${BIN_DIR}"
echo "  data dir:  ${DATA_DIR}"
echo "  launcher:  ${LAUNCHER_PATH}"
echo "  sha256:    ${LAUNCHER_SHA256}"
if [[ -n "$PROFILE_PATH" ]]; then
  echo "  shell:     ${SHELL_KIND} (${PROFILE_PATH})"
else
  echo "  shell:     ${SHELL_KIND}"
fi

if [[ "${#BLOCKER_CODES[@]}" -gt 0 ]]; then
  echo "blockers:"
  for (( i = 0; i < ${#BLOCKER_CODES[@]}; i++ )); do
    echo "  - [${BLOCKER_CODES[$i]}] ${BLOCKER_MESSAGES[$i]}"
    echo "    remedy: ${BLOCKER_REMEDIES[$i]}"
  done
fi

if [[ "$OK" -ne 1 ]]; then
  exit 1
fi

if [[ "$MODE" == "noop" ]]; then
  echo "nothing to do."
  exit 0
fi

# ---------------------------------------------------------------------------
# Execute the plan. install.sh never writes outside binDir, dataDir, or the
# selected profile file.
# ---------------------------------------------------------------------------
if [[ "$MODE" == "uninstall" ]]; then
  echo "steps:"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  - (remove) would remove launcher script ${LAUNCHER_PATH}"
    if [[ -n "$PROFILE_PATH" ]]; then
      echo "  - (remove) would remove the PATH export line for ${BIN_DIR} from ${PROFILE_PATH}, if present"
    fi
    if [[ "$PURGE" -eq 1 ]]; then
      echo "  - (remove) would recursively remove ${DATA_DIR}"
    else
      echo "  - (note) data under ${DATA_DIR} would be left in place (pass --purge to remove it)"
    fi
    exit 0
  fi

  echo "  - (remove) remove launcher script ${LAUNCHER_PATH}"
  rm -f -- "$LAUNCHER_PATH"

  if [[ -n "$PROFILE_PATH" && -f "$PROFILE_PATH" ]]; then
    echo "  - (remove) remove the PATH export line for ${BIN_DIR} from ${PROFILE_PATH}, if present"
    if grep -qxF "$PROFILE_LINE" "$PROFILE_PATH" 2>/dev/null; then
      TMP_PROFILE="$(mktemp "${PROFILE_PATH}.XXXXXX")"
      grep -vxF "$PROFILE_LINE" "$PROFILE_PATH" > "$TMP_PROFILE" || true
      mv -- "$TMP_PROFILE" "$PROFILE_PATH"
    fi
  fi

  if [[ "$PURGE" -eq 1 ]]; then
    echo "  - (remove) recursively remove ${DATA_DIR}"
    rm -rf -- "$DATA_DIR"
  else
    echo "  - (note) data under ${DATA_DIR} was left in place (pass --purge to remove it)"
  fi

  echo "uninstalled."
  exit 0
fi

# install / upgrade / reinstall
echo "steps:"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "  - (check) node ${NODE_VERSION_RAW} satisfies >= v${MIN_NODE_MAJOR}"
  echo "  - (check) platform ${PLATFORM} is supported"
  echo "  - (mkdir) would create ${BIN_DIR} if missing"
  echo "  - (mkdir) would create ${DATA_DIR} if missing"
  echo "  - (write) would write launcher script to ${LAUNCHER_PATH}"
  echo "  - (chmod) would make ${LAUNCHER_PATH} executable"
  if [[ "$MODIFY_PATH" -eq 1 ]]; then
    if [[ "$PATH_ALREADY_CONTAINS_BIN_DIR" -eq 1 ]]; then
      echo "  - (note) ${BIN_DIR} is already on PATH; shell profile would be left untouched"
    elif [[ -n "$PROFILE_PATH" ]]; then
      echo "  - (append-profile) would append PATH export for ${BIN_DIR} to ${PROFILE_PATH} (only if not already present)"
    else
      echo "  - (note) unknown shell -- add this to your shell profile manually: export PATH=\"${BIN_DIR}:\$PATH\""
    fi
  fi
  exit 0
fi

echo "  - (check) node ${NODE_VERSION_RAW} satisfies >= v${MIN_NODE_MAJOR}"
echo "  - (check) platform ${PLATFORM} is supported"

echo "  - (mkdir) create ${BIN_DIR} if missing"
mkdir -p -- "$BIN_DIR"
echo "  - (mkdir) create ${DATA_DIR} if missing"
mkdir -p -- "$DATA_DIR"

echo "  - (write) write launcher script to ${LAUNCHER_PATH}"
TMP_LAUNCHER="$(mktemp "${BIN_DIR}/.hades.XXXXXX")"
printf '%s' "$LAUNCHER_SCRIPT" > "$TMP_LAUNCHER"
mv -- "$TMP_LAUNCHER" "$LAUNCHER_PATH"

echo "  - (chmod) make ${LAUNCHER_PATH} executable"
chmod 755 -- "$LAUNCHER_PATH"

if [[ "$MODIFY_PATH" -eq 1 ]]; then
  if [[ "$PATH_ALREADY_CONTAINS_BIN_DIR" -eq 1 ]]; then
    echo "  - (note) ${BIN_DIR} is already on PATH; shell profile left untouched"
  elif [[ -n "$PROFILE_PATH" ]]; then
    echo "  - (append-profile) append PATH export for ${BIN_DIR} to ${PROFILE_PATH} (only if not already present)"
    mkdir -p -- "$(dirname -- "$PROFILE_PATH")"
    touch -- "$PROFILE_PATH"
    if ! grep -qxF "$PROFILE_LINE" "$PROFILE_PATH" 2>/dev/null; then
      printf '%s\n' "$PROFILE_LINE" >> "$PROFILE_PATH"
    fi
  else
    echo "  - (note) unknown shell -- add this to your shell profile manually: export PATH=\"${BIN_DIR}:\$PATH\""
  fi
else
  echo "  - (note) --no-modify-path: shell profile left untouched"
fi

echo "${MODE} complete."
exit 0
