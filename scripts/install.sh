#!/bin/sh
set -eu

plugin=provider-usage.ts
url=https://raw.githubusercontent.com/bnomei/amp-provider-usage/main/provider-usage.ts

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Install the Amp Provider Usage plugin.

Usage:
  curl -fsSL https://raw.githubusercontent.com/bnomei/amp-provider-usage/main/scripts/install.sh | sh

Environment:
  AMP_PLUGIN_DIR  Install directory. Defaults to $HOME/.config/amp/plugins.
EOF
}

main() {
  case "${1:-}" in
    -h|--help)
      usage
      exit 0
      ;;
    "")
      ;;
    *)
      usage >&2
      die "unknown argument '$1'"
      ;;
  esac

  command -v curl >/dev/null 2>&1 || die "curl is required"

  if [ -n "${AMP_PLUGIN_DIR:-}" ]; then
    install_dir=$AMP_PLUGIN_DIR
  else
    [ -n "${HOME:-}" ] || die "HOME is not set; set AMP_PLUGIN_DIR"
    install_dir=$HOME/.config/amp/plugins
  fi

  mkdir -p "$install_dir" || die "failed to create install directory '$install_dir'"
  tmp=$(mktemp "$install_dir/.provider-usage.XXXXXX") || die "failed to create temporary file"
  trap 'rm -f "$tmp"' 0 1 2 3 15

  printf 'Downloading %s\n' "$url"
  curl -fsSL -o "$tmp" "$url" || die "failed to download $plugin"
  chmod 644 "$tmp" || die "failed to set plugin permissions"
  mv "$tmp" "$install_dir/$plugin" || die "failed to install $plugin"
  trap - 0 1 2 3 15

  printf 'Installed %s to %s\n' "$plugin" "$install_dir/$plugin"
}

main "$@"
