#!/usr/bin/env python3
"""Load seed.ndjson (from build_site.py) into the forum's DynamoDB table.
Uses boto3 with YOUR stored AWS credentials/profile. Idempotent: re-running
overwrites the same items (same keys), so it's safe to run again.

    pip install boto3
    python3 scripts/load_seed.py --table <ForumTable> --file build/seed.ndjson --region us-east-1
"""
import argparse, json, sys
try:
    import boto3
except ImportError:
    sys.exit("Missing boto3. Run:  pip install boto3")

ap = argparse.ArgumentParser()
ap.add_argument("--table", required=True)
ap.add_argument("--file", default="build/seed.ndjson")
ap.add_argument("--region", default="us-east-1")
ap.add_argument("--profile", default=None, help="AWS profile name (optional)")
args = ap.parse_args()

session = boto3.Session(profile_name=args.profile, region_name=args.region) \
    if args.profile else boto3.Session(region_name=args.region)
table = session.resource("dynamodb").Table(args.table)

items = [json.loads(l) for l in open(args.file, encoding="utf-8") if l.strip()]
n = 0
with table.batch_writer() as bw:
    for it in items:
        bw.put_item(Item=it)
        n += 1
        if n % 200 == 0:
            print(f"  ...{n} items")
print(f"Loaded {n} items into {args.table}.")
