#!/bin/sh
# Run one leg: leg.sh <leg-name> <launch command as one sh string>
# Saves the app's JSON, the launcher's exit code, process state and the
# backgroundtaskmanagement / tccd / gatekeeper log lines into evidence/01/.
set -u
here=$(cd "$(dirname "$0")" && pwd)
ev="$here/../../evidence/01"
out=/tmp/localbox-spike-01
leg=$1; cmd=$2
mkdir -p "$ev" "$out"
rm -f "$out/launch.json"
start=$(date '+%Y-%m-%d %H:%M:%S')
{
  echo "leg: $leg"
  echo "start: $start"
  echo "command: $cmd"
  sh -c "$cmd"; echo "launcher_exit: $?"
  i=0
  while [ $i -lt 24 ]; do
    grep -q '"sampled_after_s" : 4' "$out/launch.json" 2>/dev/null && break
    sleep 0.5; i=$((i+1))
  done
  echo "process: $(pgrep -lf 'Spike.app/Contents/MacOS/Spike' || echo none)"
  echo "smappservice_status_cli: $("$HOME/Applications/Spike.app/Contents/MacOS/Spike" --status 2>&1)"
} > "$ev/$leg.run.txt" 2>&1
if [ -f "$out/launch.json" ]; then cp "$out/launch.json" "$ev/$leg.json"; else echo "NO JSON WRITTEN" >> "$ev/$leg.run.txt"; fi
sleep 1
log show --start "$start" --info --predicate 'subsystem == "com.apple.backgroundtaskmanagement"' > "$ev/$leg.btm.log" 2>&1
log show --start "$start" --info --predicate '(process == "tccd" OR process == "syspolicyd" OR process == "CoreServicesUIAgent" OR process == "UserNotificationCenter") AND (eventMessage CONTAINS[c] "spike" OR eventMessage CONTAINS[c] "sh.localbox")' > "$ev/$leg.tcc-gk.log" 2>&1
cat "$ev/$leg.run.txt"
[ -f "$ev/$leg.json" ] && cat "$ev/$leg.json"
echo "btm lines: $(wc -l < "$ev/$leg.btm.log")  tcc/gk lines: $(wc -l < "$ev/$leg.tcc-gk.log")"
