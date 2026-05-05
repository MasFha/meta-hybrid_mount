# Copyright (C) 2026 YuzakiKokuban <heibanbaize@gmail.com>
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

MODDIR="${0%/*}"
BASE_DIR="/data/adb/hybrid-mount"
RUN_DIR="$BASE_DIR/run"
PID_FILE="$RUN_DIR/daemon.pid"
SOCKET_FILE="$RUN_DIR/daemon.sock"
STATE_FILE="$RUN_DIR/daemon_state.json"

mkdir -p "$BASE_DIR" "$RUN_DIR"

BINARY="$MODDIR/hybrid-mount"

if [ ! -f "$BINARY" ]; then
  echo "ERROR: Binary not found at $BINARY"
  exit 1
fi

cleanup_runtime_files() {
  rm -f "$PID_FILE" "$SOCKET_FILE" "$STATE_FILE"
}

chmod 755 "$BINARY"
cleanup_runtime_files
nohup "$BINARY" daemon launch >/dev/null 2>&1 &
DAEMON_PID=$!

WAIT_COUNT=0
while [ "$WAIT_COUNT" -lt 50 ]; do
  if [ -S "$SOCKET_FILE" ]; then
    if [ -x /data/adb/ksud ]; then
      /data/adb/ksud kernel notify-module-mounted
    fi
    exit 0
  fi
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    wait "$DAEMON_PID"
    exit $?
  fi
  WAIT_COUNT=$((WAIT_COUNT + 1))
  sleep 0.1
done

if kill -0 "$DAEMON_PID" 2>/dev/null; then
  echo "ERROR: daemon did not create socket in time"
  exit 1
fi

wait "$DAEMON_PID"
exit $?
