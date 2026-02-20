#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
PLUGIN_ID="openclaw-widget-bridge"
DEFAULT_REPO_URL="https://github.com/socekin/Claw_widget.git"
DEFAULT_BRANCH="main"
DEFAULT_INSTALL_DIR="$HOME/Claw_widget"
DEFAULT_GATEWAY_PORT="18789"
TOKEN_FILE="$HOME/.openclaw/widget-token.txt"

log() {
  printf "[%s] %s\n" "$SCRIPT_NAME" "$*" >&2
}

warn() {
  printf "[%s] WARN: %s\n" "$SCRIPT_NAME" "$*" >&2
}

error_exit() {
  printf "[%s] ERROR: %s\n" "$SCRIPT_NAME" "$*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

prompt_yes_no() {
  local prompt="$1"
  local default_answer="$2"
  local hint="[y/n]"
  local answer

  case "$default_answer" in
    y|Y) hint="[Y/n]" ;;
    n|N) hint="[y/N]" ;;
    *) error_exit "Invalid default answer: $default_answer" ;;
  esac

  while true; do
    read -r -p "$prompt $hint " answer || true
    answer="${answer:-$default_answer}"
    case "$answer" in
      y|Y) return 0 ;;
      n|N) return 1 ;;
      *) echo "Please enter y or n." ;;
    esac
  done
}

prompt_input() {
  local prompt="$1"
  local default_value="$2"
  local value

  read -r -p "$prompt [$default_value]: " value || true
  if [[ -z "${value}" ]]; then
    printf "%s" "$default_value"
  else
    printf "%s" "$value"
  fi
}

resolve_archive_url() {
  local repo_url="$1"
  local branch="$2"

  if [[ "$repo_url" =~ ^https://github.com/([^/]+)/([^/.]+)(\.git)?$ ]]; then
    local owner="${BASH_REMATCH[1]}"
    local repo="${BASH_REMATCH[2]}"
    printf "https://github.com/%s/%s/archive/refs/heads/%s.tar.gz" "$owner" "$repo" "$branch"
    return 0
  fi

  return 1
}

download_with_http() {
  local repo_url="$1"
  local branch="$2"
  local install_dir="$3"

  local archive_url
  archive_url="$(resolve_archive_url "$repo_url" "$branch")" || {
    error_exit "Non-GitHub repo URL is not supported without git."
  }

  local temp_root
  temp_root="$(mktemp -d)"
  local archive_file="$temp_root/repo.tar.gz"
  local extract_dir="$temp_root/extract"

  mkdir -p "$extract_dir"

  if command_exists curl; then
    log "Downloading source archive with curl..."
    curl -fsSL "$archive_url" -o "$archive_file"
  elif command_exists wget; then
    log "Downloading source archive with wget..."
    wget -qO "$archive_file" "$archive_url"
  else
    error_exit "curl or wget is required when git is unavailable."
  fi

  tar -xzf "$archive_file" -C "$extract_dir"

  local src_dir
  src_dir="$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [[ -n "$src_dir" ]] || error_exit "Failed to extract source archive."

  mkdir -p "$install_dir"
  if command_exists rsync; then
    rsync -a --delete --exclude ".git" "$src_dir/" "$install_dir/"
  else
    rm -rf "$install_dir"/*
    cp -a "$src_dir/." "$install_dir/"
    rm -rf "$install_dir/.git"
  fi

  rm -rf "$temp_root"
}

sync_source() {
  local repo_url="$1"
  local branch="$2"
  local install_dir="$3"

  if command_exists git; then
    if [[ -d "$install_dir/.git" ]]; then
      log "Updating existing git repository in $install_dir"
      git -C "$install_dir" fetch --all --prune
      git -C "$install_dir" checkout "$branch"
      git -C "$install_dir" pull --ff-only origin "$branch"
      return 0
    fi

    if [[ -d "$install_dir" ]] && [[ -n "$(ls -A "$install_dir" 2>/dev/null || true)" ]]; then
      warn "$install_dir exists and is not a git repository."
      if ! prompt_yes_no "Replace existing files in $install_dir?" "n"; then
        error_exit "Installation aborted by user."
      fi
      rm -rf "$install_dir"
    fi

    log "Cloning source from $repo_url"
    git clone --depth 1 --branch "$branch" "$repo_url" "$install_dir"
    return 0
  fi

  warn "git is not available, switching to archive download mode."
  download_with_http "$repo_url" "$branch" "$install_dir"
}

generate_token() {
  if command_exists openssl; then
    openssl rand -hex 32
    return 0
  fi

  if command_exists xxd; then
    head -c 32 /dev/urandom | xxd -p -c 256
    return 0
  fi

  error_exit "Cannot generate token: install openssl (preferred) or xxd."
}

configure_openclaw_plugin() {
  local install_dir="$1"

  log "Installing plugin in link mode..."
  openclaw plugins install -l "$install_dir"

  local token_value=""
  if [[ -f "$TOKEN_FILE" ]] && [[ -s "$TOKEN_FILE" ]]; then
    token_value="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  fi

  if [[ -n "$token_value" ]]; then
    if prompt_yes_no "Reuse existing widget token from $TOKEN_FILE?" "y"; then
      log "Reusing existing token."
    else
      token_value="$(generate_token)"
      printf "%s\n" "$token_value" > "$TOKEN_FILE"
      chmod 600 "$TOKEN_FILE"
      log "Generated a new token at $TOKEN_FILE"
    fi
  else
    token_value="$(generate_token)"
    mkdir -p "$(dirname "$TOKEN_FILE")"
    printf "%s\n" "$token_value" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
    log "Generated token at $TOKEN_FILE"
  fi

  local cli_path
  cli_path="$(command -v openclaw)"

  openclaw config set "plugins.entries.${PLUGIN_ID}.enabled" true
  openclaw config set "plugins.entries.${PLUGIN_ID}.config.apiToken" "$token_value"
  openclaw config set "plugins.entries.${PLUGIN_ID}.config.cliPath" "$cli_path"
  openclaw config set "plugins.entries.${PLUGIN_ID}.config.timeoutMs" 8000
  openclaw config set "plugins.entries.${PLUGIN_ID}.config.usageDays" 30
}

extract_tunnel_id() {
  local tunnel_name="$1"
  cloudflared tunnel list 2>/dev/null | awk -v name="$tunnel_name" 'NR>1 && $2==name {print $1; exit}'
}

configure_cloudflared_named_tunnel() {
  local local_port="$1"

  if ! command_exists cloudflared; then
    warn "cloudflared is not installed."
    warn "Install guide: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    return 1
  fi

  if ! prompt_yes_no "Configure Cloudflare Named Tunnel for a public URL now?" "y"; then
    return 1
  fi

  if [[ ! -f "$HOME/.cloudflared/cert.pem" ]]; then
    log "Cloudflare login is required. Starting: cloudflared tunnel login"
    cloudflared tunnel login
  fi

  local tunnel_name
  tunnel_name="$(prompt_input "Tunnel name" "openclaw-widget")"

  local hostname
  hostname="$(prompt_input "Public hostname (example: widget.example.com)" "widget.example.com")"
  [[ -n "$hostname" ]] || error_exit "Hostname cannot be empty."

  local tunnel_id
  tunnel_id="$(extract_tunnel_id "$tunnel_name" || true)"
  if [[ -n "$tunnel_id" ]]; then
    log "Using existing tunnel: $tunnel_name ($tunnel_id)"
  else
    log "Creating tunnel: $tunnel_name"
    local create_output
    create_output="$(cloudflared tunnel create "$tunnel_name" 2>&1 | tee /dev/stderr)"
    tunnel_id="$(printf "%s" "$create_output" | grep -Eo '[0-9a-fA-F-]{36}' | head -n 1)"
    [[ -n "$tunnel_id" ]] || error_exit "Failed to parse tunnel ID from cloudflared output."
  fi

  cloudflared tunnel route dns "$tunnel_name" "$hostname" || warn "DNS route may already exist."

  local credentials_file="$HOME/.cloudflared/${tunnel_id}.json"
  [[ -f "$credentials_file" ]] || warn "Credentials file not found at $credentials_file"

  local config_file
  if [[ "$(id -u)" -eq 0 ]]; then
    config_file="/etc/cloudflared/config.yml"
  else
    config_file="$HOME/.cloudflared/config.yml"
  fi

  mkdir -p "$(dirname "$config_file")"
  cat > "$config_file" <<YAML
tunnel: ${tunnel_id}
credentials-file: ${credentials_file}

ingress:
  - hostname: ${hostname}
    path: ^/widget/summary$
    service: http://127.0.0.1:${local_port}
  - service: http_status:404
YAML

  log "Wrote cloudflared config: $config_file"

  if [[ "$(id -u)" -eq 0 ]] && command_exists systemctl; then
    cloudflared service install || warn "cloudflared service install returned non-zero (possibly already installed)."
    systemctl enable --now cloudflared || warn "Failed to start cloudflared via systemd."
  else
    warn "Run manually if needed: cloudflared tunnel run $tunnel_name"
  fi

  printf "https://%s/widget/summary" "$hostname"
}

restart_gateway() {
  log "Restarting OpenClaw gateway..."
  openclaw gateway restart

  local retries=15
  local sleep_sec=2
  local i
  for i in $(seq 1 "$retries"); do
    if openclaw gateway status >/dev/null 2>&1; then
      log "Gateway is up."
      return 0
    fi
    sleep "$sleep_sec"
  done

  warn "Gateway status check did not pass within timeout."
  return 1
}

print_summary() {
  local local_url="$1"
  local public_url="$2"

  local token
  token="$(openclaw config get "plugins.entries.${PLUGIN_ID}.config.apiToken" | tr -d '\"[:space:]')"

  echo
  echo "=============================================="
  echo "OpenClaw Widget Bridge installation complete"
  echo "=============================================="
  echo "Plugin ID: ${PLUGIN_ID}"
  echo "Token: ${token}"
  echo "Local URL: ${local_url}"
  if [[ -n "$public_url" ]]; then
    echo "Public URL: ${public_url}"
  else
    echo "Public URL: (not configured)"
  fi
  echo
  echo "Test command:"
  echo "curl -sS -H \"Authorization: Bearer ${token}\" \"${local_url}?days=7\" | jq"
  if [[ -n "$public_url" ]]; then
    echo "curl -sS -H \"Authorization: Bearer ${token}\" \"${public_url}?days=7\" | jq"
  fi
  echo "=============================================="
}

main() {
  command_exists openclaw || error_exit "openclaw is required but not found in PATH."
  command_exists tar || error_exit "tar is required."

  local repo_url
  repo_url="$(prompt_input "GitHub repository URL" "$DEFAULT_REPO_URL")"
  local branch
  branch="$(prompt_input "Git branch" "$DEFAULT_BRANCH")"

  local install_dir
  install_dir="$(prompt_input "Install path" "$DEFAULT_INSTALL_DIR")"

  log "Install path: $install_dir"
  if ! prompt_yes_no "Continue installation with this path?" "y"; then
    error_exit "Installation aborted by user."
  fi

  sync_source "$repo_url" "$branch" "$install_dir"
  configure_openclaw_plugin "$install_dir"

  local local_port
  local local_port_default="$DEFAULT_GATEWAY_PORT"
  local_port="$(prompt_input "Gateway port" "$local_port_default")"
  local local_url="http://127.0.0.1:${local_port}/widget/summary"

  local public_url=""
  if public_url="$(configure_cloudflared_named_tunnel "$local_port")"; then
    log "Cloudflare public URL configured."
  else
    public_url=""
  fi

  restart_gateway || true
  print_summary "$local_url" "$public_url"
}

main "$@"
