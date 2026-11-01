#!/usr/bin/env bash
# Connect the phone to this Jetson over USB:
#   phone's http://localhost:$PORT  ->  Jetson's port $PORT
# then open the face in Chrome. Keeps running and redoes the forward whenever
# the phone is unplugged and plugged back in.
#
#   PORT=8000 ./start_usb.sh     (OPEN=0 to skip opening the browser)
set -u
PORT="${PORT:-8000}"
OPEN="${OPEN:-1}"
URL="http://localhost:${PORT}/"

if ! command -v adb >/dev/null 2>&1; then
  echo "adb not found. Install it with:  sudo apt install adb"
  exit 1
fi

while true; do
  echo "Waiting for the phone on USB... (if nothing happens, accept the 'Allow USB debugging' prompt on the phone)"
  adb wait-for-device
  if adb reverse "tcp:${PORT}" "tcp:${PORT}"; then
    echo "Forwarding phone localhost:${PORT} -> Jetson:${PORT}"
    if [ "$OPEN" = "1" ]; then
      adb shell am start -a android.intent.action.VIEW -d "$URL" \
          -n com.android.chrome/com.google.android.apps.chrome.Main >/dev/null 2>&1 \
        || adb shell am start -a android.intent.action.VIEW -d "$URL" >/dev/null 2>&1
    fi
  else
    echo "adb reverse failed; retrying in 3 s"
    sleep 3
    continue
  fi
  while [ "$(adb get-state 2>/dev/null)" = "device" ]; do sleep 2; done
  echo "Phone disconnected."
done
