#!/usr/bin/env python3
"""Headroom savings report — shows token compression stats for a given time window."""
import argparse
import sys

VENV_SITE = "/Users/shivamsmanageddevice/.headroom-venv/lib/python3.14/site-packages"


def parse_since(since: str) -> int:
    """Parse a --since value like '24h', '7d', '30m' into retention_days (ceiling)."""
    import math
    since = since.strip().lower()
    if since.endswith("h"):
        hours = float(since[:-1])
        return max(1, math.ceil(hours / 24))
    if since.endswith("d"):
        return max(1, int(float(since[:-1])))
    if since.endswith("m"):
        minutes = float(since[:-1])
        return max(1, math.ceil(minutes / 1440))
    return 1


def main() -> None:
    parser = argparse.ArgumentParser(description="Headroom token savings report")
    parser.add_argument("--since", default="24h", help="Time window, e.g. 24h, 7d, 30m")
    args = parser.parse_args()

    sys.path.insert(0, VENV_SITE)
    try:
        from headroom.savings_ledger import aggregate_savings
    except ImportError as e:
        print(f"Error: headroom-ai not found in venv — {e}", file=sys.stderr)
        sys.exit(1)

    retention_days = parse_since(args.since)
    report = aggregate_savings(retention_days=retention_days)
    lifetime = report.lifetime
    windows = report.windows

    total_before = lifetime.get("tokens_before", 0)
    total_after = lifetime.get("tokens_after", 0)
    total_saved = lifetime.get("tokens_saved", total_before - total_after)
    events = lifetime.get("events", 0)
    pct = round((total_saved / max(total_before, 1)) * 100, 1)

    print(f"\n{'─'*50}")
    print(f"  Headroom Savings Report  (since --{args.since}, up to {retention_days}d lookback)")
    print(f"{'─'*50}")
    print(f"  Events recorded : {events}")
    print(f"  Original tokens : {total_before:,}")
    print(f"  Compressed tokens: {total_after:,}")
    print(f"  Tokens saved    : {total_saved:,}  ({pct}%)")

    # Window breakdowns
    for window_name, wdata in windows.items():
        w_before = wdata.get("tokens_before", 0)
        w_after = wdata.get("tokens_after", 0)
        w_saved = wdata.get("tokens_saved", w_before - w_after)
        w_pct = round((w_saved / max(w_before, 1)) * 100, 1)
        w_events = wdata.get("events", 0)
        print(f"\n  [{window_name}]")
        print(f"    Events: {w_events}  |  {w_before:,} → {w_after:,} tokens  ({w_pct}% saved)")

    if report.by_model:
        print(f"\n  Top model: {report.top_model}")

    print(f"{'─'*50}\n")


if __name__ == "__main__":
    main()
