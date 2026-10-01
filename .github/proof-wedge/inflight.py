#!/usr/bin/env python3
"""Proof-only: summarize a Swift Testing event stream at a stall.

Prints test cases that started but never ended (the parallelization slots that were held)
plus the final events before progress stopped.
"""
import json
import sys

path = sys.argv[1]
tests = {}
open_cases = {}
events = []
for line in open(path, encoding="utf-8", errors="replace"):
    line = line.strip()
    if not line:
        continue
    try:
        record = json.loads(line)
    except ValueError:
        continue
    payload = record.get("payload") or {}
    if record.get("kind") == "test":
        tests[payload.get("id")] = payload
        continue
    if record.get("kind") != "event":
        continue
    kind = payload.get("kind")
    instant = (payload.get("instant") or {}).get("absolute")
    test_id = payload.get("testID")
    case = payload.get("testCase")
    key = (test_id, json.dumps(case, sort_keys=True) if case is not None else None)
    events.append((instant, kind, test_id, case, payload))
    if kind == "testCaseStarted":
        open_cases[key] = (instant, test_id, case)
    elif kind == "testCaseEnded":
        open_cases.pop(key, None)


def describe(test_id, case):
    test = tests.get(test_id) or {}
    name = test.get("displayName") or test.get("name") or test_id
    loc = test.get("sourceLocation") or {}
    where = f"{loc.get('fileID', loc.get('_filePath', '?'))}:{loc.get('line', '?')}"
    args = ""
    if case and case.get("arguments"):
        args = " args=" + ", ".join(
            f"{a.get('parameterName', '?')}={a.get('value', '?')}" for a in case["arguments"]
        )
    return f"{name} [{where}]{args}"


last = max((e[0] for e in events if e[0] is not None), default=None)
print(f"events={len(events)} last_instant={last}")
print(f"open test cases ({len(open_cases)}):")
for instant, test_id, case in sorted(open_cases.values(), key=lambda v: v[0] or 0):
    age = (last - instant) if (last is not None and instant is not None) else None
    print(f"  started={instant} age_before_last_event={age} :: {describe(test_id, case)}")
print("last 60 events:")
for instant, kind, test_id, case, payload in events[-60:]:
    extra = ""
    if kind == "issueRecorded":
        issue = payload.get("issue") or {}
        extra = " :: " + json.dumps(issue)[:300]
    print(f"  {instant} {kind} :: {describe(test_id, case) if test_id else ''}{extra}")
