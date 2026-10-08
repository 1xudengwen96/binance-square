#!/usr/bin/env bash
# Restart the local panel: the server reads public/index.html once at boot, so
# every UI edit needs a restart before it shows up in the browser.
set -u
cd "$(dirname "$0")/.."
pid=$(netstat -ano | grep ':8787 ' | grep LISTENING | awk '{print $5}' | head -1)
if [ -n "$pid" ]; then
  powershell -NoProfile -Command "Stop-Process -Id $pid -Force" >/dev/null 2>&1
  sleep 2
fi
nohup npx tsx src/server/app.ts > /tmp/squareforge.log 2>&1 &
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/ 2>/dev/null)
  [ "$code" = "200" ] && { echo "panel up: http://127.0.0.1:8787"; exit 0; }
  sleep 1
done
echo "panel did not come up; log tail:"
tail -20 /tmp/squareforge.log
exit 1
