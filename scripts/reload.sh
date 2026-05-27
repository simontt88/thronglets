#!/usr/bin/env bash
#
# Thronglets Hot-Reload Orchestrator (v2 — validate-before-cutover)
#
# Spawned detached by the running server on a reload trigger. Strategy:
#   1. Boot a NEW process in STANDBY mode on a temp port (Telegram OFF).
#   2. Health-check the standby. If it never gets healthy, KILL it and leave
#      the OLD server running untouched -> zero downtime, no rollback needed.
#   3. Only after standby is proven healthy: SIGTERM the old server, wait for
#      the real port to free, then POST /promote (binds real port + Telegram).
#   4. Health-check the promoted server. If it fails after the old already
#      stopped, do a last-resort fresh restart (watchdog is the final backstop).
#
# NOTE: deliberately does NOT `git pull` — hot-reload reloads the LOCAL working
# tree. Uses the tsx binary (not `node --import tsx`) to avoid WASM-OOM in
# constrained contexts.
#
# Env (from the calling server): RELOAD_OLD_PID, RELOAD_PORT, RELOAD_CWD,
# RELOAD_LOG, THRONGLETS_HOME, BRIDGE_PORT

set -uo pipefail

OLD_PID="${RELOAD_OLD_PID:?}"
PORT="${RELOAD_PORT:-3850}"
CWD="${RELOAD_CWD:?}"
LOG="${RELOAD_LOG:-/tmp/thronglets-reload.log}"
STANDBY_PORT="$((PORT + 9))"
THRONGLETS_LOG="${THRONGLETS_LOG:-/tmp/thronglets.log}"
TH_HOME="${THRONGLETS_HOME:-$HOME/.thronglets}"
TSX_BIN="$CWD/node_modules/.bin/tsx"

log()        { echo "[$(date -Iseconds)] $*" >> "$LOG"; }
health()     { curl -sf "http://127.0.0.1:${1}/health" >/dev/null 2>&1; }
pid_alive()  { kill -0 "$1" 2>/dev/null; }

kill_tree() {  # SIGTERM then SIGKILL a pid and its direct children
  local p="$1"
  kill -TERM "$p" 2>/dev/null || true
  pkill -TERM -P "$p" 2>/dev/null || true
  sleep 2
  pid_alive "$p" && kill -9 "$p" 2>/dev/null || true
  pkill -9 -P "$p" 2>/dev/null || true
}

start_server() {  # arg1: standby port (empty for normal). echoes new pid.
  cd "$CWD"
  local sb="${1:-}"
  if [ -x "$TSX_BIN" ]; then
    if [ -n "$sb" ]; then
      env BRIDGE_PORT="$PORT" THRONGLETS_HOME="$TH_HOME" RELOAD_STANDBY_PORT="$sb" \
        nohup "$TSX_BIN" src/index.ts >> "$THRONGLETS_LOG" 2>&1 < /dev/null &
    else
      env BRIDGE_PORT="$PORT" THRONGLETS_HOME="$TH_HOME" \
        nohup "$TSX_BIN" src/index.ts >> "$THRONGLETS_LOG" 2>&1 < /dev/null &
    fi
  else
    if [ -n "$sb" ]; then
      env BRIDGE_PORT="$PORT" THRONGLETS_HOME="$TH_HOME" RELOAD_STANDBY_PORT="$sb" \
        nohup node --import tsx src/index.ts >> "$THRONGLETS_LOG" 2>&1 < /dev/null &
    else
      env BRIDGE_PORT="$PORT" THRONGLETS_HOME="$TH_HOME" \
        nohup node --import tsx src/index.ts >> "$THRONGLETS_LOG" 2>&1 < /dev/null &
    fi
  fi
  echo $!
}

log "=== Hot-Reload v2 start === old_pid=$OLD_PID port=$PORT standby_port=$STANDBY_PORT cwd=$CWD"

# Step 1: boot NEW process in standby (Telegram OFF, temp port)
log "starting standby on :$STANDBY_PORT (telegram OFF)..."
NEW_PID=$(start_server "$STANDBY_PORT")
log "standby pid=$NEW_PID"

# Step 2: validate standby boots + serves
WAIT=0; MAX=25; HEALTHY=false
while [ "$WAIT" -lt "$MAX" ]; do
  sleep 1; WAIT=$((WAIT + 1))
  if ! pid_alive "$NEW_PID"; then log "standby died during boot (after ${WAIT}s)"; break; fi
  if health "$STANDBY_PORT"; then HEALTHY=true; log "standby healthy (after ${WAIT}s)"; break; fi
done

if [ "$HEALTHY" != true ]; then
  log "standby FAILED to become healthy — ABORT reload, OLD server left running"
  kill_tree "$NEW_PID"
  log "=== Hot-Reload ABORTED (zero downtime, old retained) ==="
  exit 1
fi

# Step 3: cutover — stop OLD, then promote NEW
log "stopping old server (pid=$OLD_PID)..."
if pid_alive "$OLD_PID"; then
  kill -TERM "$OLD_PID" 2>/dev/null || true
  W=0
  while pid_alive "$OLD_PID" && [ "$W" -lt 4 ]; do sleep 1; W=$((W + 1)); done
  if pid_alive "$OLD_PID"; then log "old still alive after ${W}s — SIGKILL"; kill -9 "$OLD_PID" 2>/dev/null || true; sleep 1; fi
  log "old stopped (waited ${W}s)"
else
  log "old already gone"
fi

# wait for the real port to be released
W=0
while health "$PORT" && [ "$W" -lt 8 ]; do sleep 1; W=$((W + 1)); done

log "promoting standby -> live on :$PORT ..."
PROMOTE_OUT=$(curl -sf -m 25 -X POST "http://127.0.0.1:${STANDBY_PORT}/promote" 2>&1) || true
log "promote response: ${PROMOTE_OUT:-<none>}"

# Step 4: verify promoted server on real port
WAIT=0; OK=false
while [ "$WAIT" -lt 15 ]; do
  sleep 1; WAIT=$((WAIT + 1))
  if ! pid_alive "$NEW_PID"; then log "promoted process died (after ${WAIT}s)"; break; fi
  if health "$PORT"; then OK=true; log "promoted server healthy on :$PORT (after ${WAIT}s)"; break; fi
done

if [ "$OK" = true ]; then
  log "=== Hot-Reload SUCCESS === new_pid=$NEW_PID"
  exit 0
fi

# Last resort: promote failed after old already stopped -> fresh restart
log "promote/verify FAILED — last-resort fresh restart"
kill_tree "$NEW_PID"
sleep 1
FRESH_PID=$(start_server "")
log "fresh pid=$FRESH_PID"
WAIT=0
while [ "$WAIT" -lt 20 ]; do
  sleep 1; WAIT=$((WAIT + 1))
  if health "$PORT"; then log "=== RECOVERED via fresh restart === pid=$FRESH_PID"; exit 0; fi
  pid_alive "$FRESH_PID" || { log "fresh process died"; break; }
done
log "=== Hot-Reload FAILED — watchdog will recover ==="
exit 1
