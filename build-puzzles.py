#!/usr/bin/env python3
"""
build-puzzles.py — generate puzzles.json for Chess Pi from the official
Lichess Puzzle Database (CC0 licensed, https://database.lichess.org/#puzzles).

WHY THIS IS A SEPARATE SCRIPT YOU RUN LOCALLY, NOT SOMETHING BUNDLED INTO
THE APP: the official database is a single ~250MB+ compressed CSV covering
several million puzzles. Downloading, filtering, and shipping that at
runtime would be enormous overkill for a chess app — instead, you run this
script ONCE (or occasionally, to refresh) on your own machine, and it
produces a small, pre-filtered puzzles.json that the app loads instantly.

USAGE
-----
    pip install requests zstandard
    python3 tools/build-puzzles.py --count 500 --min-rating 800 --max-rating 2200

This will:
  1. Download lichess_db_puzzle.csv.zst (if not already cached locally)
  2. Stream-decompress and filter it by your criteria
  3. Write puzzles.json in the exact schema script.js expects

OPTIONS
-------
    --count N          Total number of puzzles to include (default: 500)
    --min-rating N      Minimum puzzle rating to include (default: 600)
    --max-rating N      Maximum puzzle rating to include (default: 2400)
    --themes a,b,c      Only include puzzles tagged with at least one of
                        these Lichess themes (default: any theme). See
                        https://github.com/lichess-org/lila/blob/master/translation/source/puzzleTheme.xml
                        for the full list (e.g. fork, pin, mateIn2, ...)
    --free-fraction F  Fraction of the output marked "free": true, spread
                        evenly across the rating range so free/premium
                        both cover easy→hard (default: 0.3)
    --out PATH          Output file (default: ../puzzles.json, i.e. the
                        project root next to index.html)
    --cache PATH        Where to keep the downloaded .csv.zst so re-runs
                        with different filters don't re-download 250MB+
                        every time (default: ./lichess_db_puzzle.csv.zst)

This script only reads the official Lichess export and writes a JSON file
— it makes no other network calls and requires no API keys.
"""
import argparse
import csv
import io
import json
import os
import random
import sys
import urllib.request

DB_URL = "https://database.lichess.org/lichess_db_puzzle.csv.zst"


def download_if_needed(cache_path):
    if os.path.exists(cache_path):
        print(f"Using cached database at {cache_path}")
        return
    print(f"Downloading {DB_URL} ...")
    print("(This is a few hundred MB — grab a coffee. Only needed once; "
          "re-runs reuse the cached file unless you delete it.)")

    def _progress(block_num, block_size, total_size):
        if total_size <= 0:
            return
        done = block_num * block_size
        pct = min(100, done * 100 // total_size)
        sys.stdout.write(f"\r  {pct}% ({done // (1024*1024)} MB / {total_size // (1024*1024)} MB)")
        sys.stdout.flush()

    urllib.request.urlretrieve(DB_URL, cache_path, reporthook=_progress)
    print("\nDownload complete.")


def stream_csv_rows(cache_path):
    try:
        import zstandard as zstd
    except ImportError:
        print("Missing dependency: pip install zstandard", file=sys.stderr)
        sys.exit(1)

    dctx = zstd.ZstdDecompressor()
    with open(cache_path, "rb") as fh:
        with dctx.stream_reader(fh) as reader:
            text_stream = io.TextIOWrapper(reader, encoding="utf-8", newline="")
            reader_csv = csv.reader(text_stream)
            header = next(reader_csv)
            for row in reader_csv:
                yield dict(zip(header, row))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--count", type=int, default=500)
    parser.add_argument("--min-rating", type=int, default=600)
    parser.add_argument("--max-rating", type=int, default=2400)
    parser.add_argument("--themes", type=str, default="")
    parser.add_argument("--free-fraction", type=float, default=0.3)
    parser.add_argument("--out", type=str, default=None)
    parser.add_argument("--cache", type=str, default="lichess_db_puzzle.csv.zst")
    args = parser.parse_args()

    wanted_themes = set(t.strip() for t in args.themes.split(",") if t.strip())
    out_path = args.out or os.path.join(os.path.dirname(__file__), "..", "puzzles.json")

    download_if_needed(args.cache)

    print("Scanning and filtering puzzles (this streams the file, so it "
          "won't load the whole thing into memory)...")

    matched = []
    seen = 0
    for row in stream_csv_rows(args.cache):
        seen += 1
        if seen % 500000 == 0:
            print(f"  ...scanned {seen:,} rows, matched {len(matched):,} so far")

        try:
            rating = int(row["Rating"])
        except (KeyError, ValueError):
            continue
        if rating < args.min_rating or rating > args.max_rating:
            continue

        themes = row.get("Themes", "").split()
        if wanted_themes and not (wanted_themes & set(themes)):
            continue

        matched.append({
            "id": row["PuzzleId"],
            "fen": row["FEN"],
            "moves": row["Moves"].split(),
            "rating": rating,
            "themes": themes,
        })

        # Early-exit once we have a generous multiple of what we need, so
        # we don't have to stream all several million rows every time.
        if len(matched) >= args.count * 20:
            break

    print(f"Matched {len(matched):,} puzzles out of {seen:,} scanned.")
    if not matched:
        print("No puzzles matched your filters — widen --min-rating/--max-rating/--themes.", file=sys.stderr)
        sys.exit(1)

    random.shuffle(matched)
    selected = matched[: args.count]
    selected.sort(key=lambda p: p["rating"])

    # Spread "free" across the whole difficulty range rather than only the
    # easiest puzzles, so free users still get a taste of the hard ones.
    free_count = int(len(selected) * args.free_fraction)
    free_indices = set(
        round(i * len(selected) / free_count) for i in range(free_count)
    ) if free_count else set()
    for i, puzzle in enumerate(selected):
        puzzle["free"] = i in free_indices

    out_path = os.path.abspath(out_path)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(selected, fh, ensure_ascii=False, indent=2)

    print(f"Wrote {len(selected):,} puzzles to {out_path}")
    print(f"  free: {sum(1 for p in selected if p['free']):,}  "
          f"premium: {sum(1 for p in selected if not p['free']):,}")
    print("Deploy this file alongside index.html/script.js and you're done.")


if __name__ == "__main__":
    main()
