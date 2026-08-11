#!/usr/bin/env python3
"""
build_seed.py -- Convert an exported legacy forum (topics.json) into a DynamoDB
seed file (out/seed.ndjson) that load_seed.py can import.

Input schema (see IMPORT.md):

    {
      "topics": [
        {
          "id": "t1",                # unique topic id (string or number)
          "title": "Thread title",
          "category": "General",     # display name; slugged into the category id
          "author": "Name",          # optional; defaults to first post's author
          "createdTs": 1234567890,   # optional epoch seconds; defaults to first post ts
          "posts": [
            { "author": "Name", "body": "text", "ts": 1234567890 }
          ]
        }
      ]
    }

Every imported topic is marked archived:true (read-only) and attributed to the
original author display names — no user accounts are created or linked.

Usage:
    python3 scripts/build_seed.py --file topics.json --out ./build

No AWS calls here -- this only produces files. load_seed.py writes the seed to
DynamoDB (deploy.sh runs both when IMPORT_FILE is set).
"""

import argparse
import json
import os
import re
import sys


def slug(s, fallback="imported"):
    s = re.sub(r"[^A-Za-z0-9._-]", "-", (s or "").strip().lower()).strip("-")
    s = re.sub(r"-{2,}", "-", s)
    return s[:60] or fallback


def die(msg):
    sys.exit(f"build_seed: {msg}")


def build_seed(topics, out_path):
    items = []
    seq = 0

    # Discover categories from the topics themselves.
    cats = {}  # slug -> display name
    for t in topics:
        name = (t.get("category") or "Imported").strip() or "Imported"
        cats.setdefault(slug(name), name)

    for i, (cid, name) in enumerate(sorted(cats.items())):
        o = (i + 1) * 10
        items.append({"PK": f"CAT#{cid}", "SK": "META", "type": "category",
                      "catId": cid, "name": name, "order": o,
                      "desc": "Imported from the previous forum",
                      "GSI1PK": "CATLIST", "GSI1SK": o})

    for t in topics:
        tid = str(t["id"])
        tcat = slug((t.get("category") or "Imported").strip() or "Imported")
        post_epochs = []
        post_items = []
        for k, p in enumerate(t["posts"]):
            seq += 1
            ep = int(p.get("ts") or 1_000_000_000 + seq)
            post_epochs.append(ep)
            pid = f"{tid}-{k + 1}"
            post_items.append({
                "PK": f"TOPIC#{tid}", "SK": f"POST#{ep:012d}#{pid}",
                "type": "post", "postId": pid, "topicId": tid,
                "author": str(p.get("author") or ""), "authorSub": "",
                "body": str(p["body"]), "createdTs": ep,
                "archived": True})
        created = int(t.get("createdTs") or min(post_epochs))
        last = max(post_epochs)
        first_author = str(t.get("author") or t["posts"][0].get("author") or "")
        # Topic metadata carries BOTH GSI keys so the API can list it two ways:
        #   GSI1 (FORUM/lastTs)  -> global recent-activity feed
        #   GSI2 (CAT#/lastTs)   -> topics within this category
        items.append({"PK": f"TOPIC#{tid}", "SK": "META", "type": "topic",
                      "topicId": tid, "title": str(t["title"]), "author": first_author,
                      "catId": tcat, "archived": True,
                      "replyCount": max(0, len(t["posts"]) - 1),
                      "createdTs": created, "lastTs": last,
                      "GSI1PK": "FORUM", "GSI1SK": last,
                      "GSI2PK": f"CAT#{tcat}", "GSI2SK": last})
        items.extend(post_items)

    with open(out_path, "w", encoding="utf-8") as f:
        for it in items:
            f.write(json.dumps(it, ensure_ascii=False) + "\n")
    return len(items)


def validate(data):
    if not isinstance(data, dict) or not isinstance(data.get("topics"), list):
        die('input must be an object with a "topics" array (see IMPORT.md)')
    seen = set()
    for t in data["topics"]:
        tid = t.get("id")
        if tid is None or str(tid) == "":
            die("every topic needs an id")
        if str(tid) in seen:
            die(f"duplicate topic id: {tid}")
        seen.add(str(tid))
        if not t.get("title"):
            die(f"topic {tid}: missing title")
        posts = t.get("posts")
        if not isinstance(posts, list) or not posts:
            die(f"topic {tid}: posts must be a non-empty list")
        for k, p in enumerate(posts):
            if not isinstance(p, dict) or not p.get("body"):
                die(f"topic {tid}: post {k + 1} is missing body")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True, help="topics.json (see IMPORT.md)")
    ap.add_argument("--out", default="./build")
    args = ap.parse_args()

    if not os.path.exists(args.file):
        die(f"missing input file {args.file}")
    try:
        data = json.load(open(args.file, encoding="utf-8"))
    except json.JSONDecodeError as e:
        die(f"{args.file} is not valid JSON: {e}")
    validate(data)
    topics = [t for t in data["topics"] if t.get("posts")]

    os.makedirs(args.out, exist_ok=True)
    out_path = os.path.join(args.out, "seed.ndjson")
    n_items = build_seed(topics, out_path)
    total_posts = sum(len(t["posts"]) for t in topics)
    print(f"Topics: {len(topics)}   Posts: {total_posts}")
    print(f"Seed items: {n_items}  -> {out_path}")


if __name__ == "__main__":
    main()
