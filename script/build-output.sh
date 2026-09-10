#!/bin/bash
# Sourced by build and archive entrypoints; stdout is only the selected path.
hades_validate_build_path() {
  local output="$1" allow_directory="${2:-0}" component resolved
  local -a components
  case "$output" in *$'\n'*|*$'\r'*) echo "Build output paths cannot contain newlines." >&2; return 1;; esac
  [[ "$output" == /* ]] || { echo "Build output must be absolute." >&2; return 1; }
  while [[ "$output" != / && "$output" == */ ]]; do output="${output%/}"; done
  if [[ ( -e "$output" || -L "$output" ) && "$allow_directory" != 1 ]]; then
    echo "Build-only output already exists; choose a fresh HADES_APP_OUTPUT: $output" >&2; return 1
  fi
  IFS='/' read -r -a components <<< "$output"
  resolved="/"
  for component in "${components[@]}"; do
    case "$component" in ''|.) continue;; ..) resolved="${resolved%/*}"; [[ -n "$resolved" ]] || resolved="/"; continue;; esac
    resolved="${resolved%/}/$component"
    if [[ ( -e "$resolved" || -L "$resolved" ) && ! -d "$resolved" ]]; then echo "Invalid output ancestor: $resolved" >&2; return 1; fi
    if [[ -d "$resolved" ]]; then
      case "$resolved/" in *.[aA][pP][pP]/*) echo "Build-only output cannot be inside an existing app: $resolved" >&2; return 1;; esac
      resolved="$(cd "$resolved" && pwd -P && printf '.')" || return 1
      resolved="${resolved%$'\n.'}"
      case "$resolved" in *$'\n'*|*$'\r'*) echo "Build output paths cannot contain newlines." >&2; return 1;; esac
      case "$resolved/" in *.[aA][pP][pP]/*) echo "Build-only output cannot be inside an existing app: $resolved" >&2; return 1;; esac
    fi
  done
  if [[ ( -e "$resolved" || -L "$resolved" ) && "$allow_directory" != 1 ]]; then echo "Build-only output already exists: $resolved" >&2; return 1; fi
  printf '%s\n' "$resolved"
}
hades_select_build_output() {
  local root="$1" output parent candidate
  case "$root" in *$'\n'*|*$'\r'*) echo "Build root cannot contain newlines." >&2; return 1;; esac
  if [[ "${HADES_APP_OUTPUT+x}" == x ]]; then
    output="$HADES_APP_OUTPUT"
    if [[ -z "$output" ]]; then echo "HADES_APP_OUTPUT must not be empty." >&2; return 1; fi
    [[ "$output" == /* ]] || output="$root/$output"
    hades_validate_build_path "$output"
  else
    parent="$(hades_validate_build_path "$root/dist-mac/candidates" 1)" || return 1
    mkdir -p "$parent" || return 1
    parent="$(hades_validate_build_path "$parent" 1)" || return 1
    candidate="$(mktemp -d "$parent/candidate.XXXXXX")" || return 1
    hades_validate_build_path "$candidate/Hades.app"
  fi
}
