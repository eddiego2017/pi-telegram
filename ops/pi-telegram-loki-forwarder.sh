#!/usr/bin/env bash
# pi-telegram -> Loki log forwarder (self-healing supervisor)
#
# pi runs inside `tmux new-session ... 'while true; do pi; sleep 2; done'`, so the
# pi parent's stdout (structured pi-telegram debug JSON via console.log) goes to the
# tmux pane pty, never to the container stdout that Alloy/Loki scrape.
#
# This supervisor keeps `tmux pipe-pane` active on the pi window, forwarding each
# line to the container's stdout (PID 1 fd 1 = /dev/pts/0). A line filter drops any
# non-JSON / TUI-escape noise so only clean structured logs reach Loki.
#
# Idempotent + self-healing: re-arms pipe-pane if it ever drops (tmux server
# restart, pi /reload, window recreation).
set -uo pipefail

export PATH=/home/pi/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

TMUX_SESSION=${PI_TMUX_SESSION:-pi}
CHECK_INTERVAL=${PI_LOKI_FORWARD_INTERVAL:-15}
# Container stdout (PID 1's stdout is what the k8s log collector reads).
CONTAINER_STDOUT=/proc/1/fd/1

# Per-line filter: only forward lines that are pi-telegram structured JSON.
# Strips any partial TUI redraw noise. Kept as a tiny inline awk for low overhead.
FILTER_CMD='grep --line-buffered -E "^\\{\"ts\":.*\"component\":\"pi-telegram\""'

log() { echo "[$(date -u +%FT%TZ)] pi-loki-forwarder: $*" > "$CONTAINER_STDOUT" 2>/dev/null || true; }

is_piped() {
  tmux list-panes -t "$TMUX_SESSION" -F '#{pane_pipe} #{pane_id}' 2>/dev/null \
    | awk '$1==1 {found=1} END {exit found?0:1}'
}

arm_pipe() {
  # pipe-pane -o: only start if not already piping the same command (we guard with is_piped).
  # Each captured pane line is fed to FILTER and appended to container stdout.
  tmux pipe-pane -t "$TMUX_SESSION" -o \
    "$FILTER_CMD >> $CONTAINER_STDOUT" 2>/dev/null
}

log "supervisor starting (session=$TMUX_SESSION interval=${CHECK_INTERVAL}s)"

while true; do
  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    if ! is_piped; then
      if arm_pipe; then
        log "armed pipe-pane on session $TMUX_SESSION"
      else
        log "failed to arm pipe-pane (will retry)"
      fi
    fi
  fi
  sleep "$CHECK_INTERVAL"
done
