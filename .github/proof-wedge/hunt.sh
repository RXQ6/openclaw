#!/usr/bin/env bash
# Proof-only: loop the saturated full default suite and capture diagnostics when it wedges.
set +e
set -u
cpu="$(sysctl -n hw.logicalcpu)"
width=8
logdir="$RUNNER_TEMP/wedge"
mkdir -p "$logdir"
here="$(cd "$(dirname "$0")" && pwd)"
deadline=$(( $(date +%s) + HUNT_MINUTES * 60 ))
stall_seconds="${STALL_SECONDS:-300}"
echo "cpu=$cpu width=$width hunt_minutes=$HUNT_MINUTES stall_seconds=$stall_seconds shard=$SHARD"
echo "| run | exit | seconds | wedged | test cases ended | result |" >> "$GITHUB_STEP_SUMMARY"
echo "|---|---|---|---|---|---|" >> "$GITHUB_STEP_SUMMARY"

load=()
for _ in $(seq 1 "$cpu"); do sudo -n nice -n -20 yes > /dev/null & load+=("$!"); done
for _ in $(seq 1 $(( cpu * 3 ))); do yes > /dev/null & load+=("$!"); done
sleep 5

capture() {
  local i="$1" ev="$2" helper="$3" tag="$4"
  local prefix="$logdir/run-$i-$tag"
  echo "[hunt] capturing $tag diagnostics for run $i helper=$helper"
  [ -n "$ev" ] && cp "$ev" "$prefix-events.jsonl" && python3 "$here/inflight.py" "$ev" > "$prefix-inflight.txt" 2>&1
  ps -axo pid,ppid,stat,pcpu,etime,command | grep -v " yes$" > "$prefix-ps.txt"
  if [ -n "$helper" ]; then
    sudo -n sample "$helper" 5 -mayDie -file "$prefix-sample.txt" > "$prefix-sample.stdout" 2>&1
    sudo -n /usr/bin/swift-inspect dump-concurrency "$helper" > "$prefix-concurrency.txt" 2>&1
    sudo -n lldb --batch -p "$helper" -o "thread backtrace all" -o "process detach" > "$prefix-lldb.txt" 2>&1
  fi
}

i=0
while [ $(( $(date +%s) + 10 * 60 )) -lt "$deadline" ]; do
  i=$(( i + 1 ))
  log="$logdir/run-$i.log"
  start=$(date +%s)
  before="$(ls -d /tmp/oc-test-* 2>/dev/null | sort)"
  node scripts/test-macos-native.mts default --package-path apps/macos --build-system native \
    --enable-code-coverage --disable-index-store -Xswiftc -gline-tables-only --skip-build \
    --experimental-maximum-parallelization-width "$width" \
    --skip "AppStateIsolationTests|ProfileChatPreferencesTests|QuickChatCatalogPresentationTests" \
    > "$log" 2>&1 &
  runner=$!
  ev=""
  last_count=-1
  last_change=$(date +%s)
  wedged=0
  probed=0
  while kill -0 "$runner" 2>/dev/null; do
    sleep 15
    if [ -z "$ev" ]; then
      dir="$(comm -13 <(echo "$before") <(ls -d /tmp/oc-test-* 2>/dev/null | sort) | tail -1)"
      [ -n "$dir" ] && [ -f "$dir/swift-testing-events.jsonl" ] && ev="$dir/swift-testing-events.jsonl"
    fi
    count=0
    [ -n "$ev" ] && count=$(grep -c testCaseEnded "$ev" 2>/dev/null)
    now=$(date +%s)
    if [ "$count" != "$last_count" ]; then
      last_count="$count"
      last_change="$now"
    fi
    helper="$(pgrep -n -f swiftpm-testing-helper)"
    # One early attach probe per shard proves whether diagnostics can attach at all.
    if [ "$i" = 1 ] && [ "$probed" = 0 ] && [ "$count" -gt 50 ] && [ -n "$helper" ]; then
      probed=1
      sudo -n sample "$helper" 1 -mayDie -file "$logdir/probe-sample.txt" > "$logdir/probe-sample.stdout" 2>&1
      sudo -n /usr/bin/swift-inspect dump-concurrency "$helper" > "$logdir/probe-concurrency.txt" 2>&1
      echo "[hunt] probe sample rc: $(wc -c < "$logdir/probe-sample.txt" 2>/dev/null) bytes"
    fi
    if [ "$count" -gt 0 ] && [ $(( now - last_change )) -ge "$stall_seconds" ]; then
      wedged=1
      capture "$i" "$ev" "$helper" stall
      # A second capture shows whether anything still moves (leaked continuations, timers).
      sleep 60
      capture "$i" "$ev" "$helper" stall2
      cp "$log" "$logdir/run-$i-at-stall.log"
      [ -n "$helper" ] && sudo -n kill -9 "$helper"
      for _ in $(seq 1 24); do kill -0 "$runner" 2>/dev/null || break; sleep 5; done
      kill -9 "$runner" 2>/dev/null
      sudo -n pkill -9 -f swiftpm-testing-helper 2>/dev/null
      sudo -n pkill -9 -f "swift-test" 2>/dev/null
      break
    fi
    if [ "$now" -ge "$deadline" ]; then
      echo "[hunt] deadline reached during run $i; stopping it"
      kill "$runner" 2>/dev/null
      sudo -n pkill -9 -f swiftpm-testing-helper 2>/dev/null
      break
    fi
  done
  wait "$runner" 2>/dev/null
  rc=$?
  seconds=$(( $(date +%s) - start ))
  result="$(grep -E "Test run with .* (passed|failed)" "$log" | tail -1 | cut -c1-120)"
  leaks="$(grep -c "CONTINUATION MISUSE" "$log")"
  echo "[hunt] run=$i rc=$rc seconds=$seconds wedged=$wedged ended=$last_count leaks=$leaks $result"
  echo "| $i | $rc | $seconds | $wedged | $last_count | ${result:-none} (leaks=$leaks) |" >> "$GITHUB_STEP_SUMMARY"
  echo "run=$i rc=$rc seconds=$seconds wedged=$wedged ended=$last_count leaks=$leaks $result" >> "$logdir/summary.txt"
  # Keep full logs only for interesting runs; trim passing ones to save artifact space.
  if [ "$wedged" = 0 ] && [ "$rc" = 0 ]; then
    grep -E "recorded an issue|Time limit|CONTINUATION MISUSE|Test run with" "$log" > "$log.brief"
    rm -f "$log"
  fi
  # Artifacts are readable only after the job ends; publish the first wedge promptly.
  if [ "$wedged" = 1 ]; then
    echo "[hunt] wedge captured in run $i; stopping this shard"
    break
  fi
done

sudo -n pkill -x yes 2>/dev/null
kill "${load[@]}" 2>/dev/null
wait 2>/dev/null
cat "$logdir/summary.txt"
exit 0
