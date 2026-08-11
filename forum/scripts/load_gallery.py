#!/usr/bin/env python3
"""Load the static photo gallery (web/photos.json) into the forum's DynamoDB
table so the new API-driven, admin-editable gallery is seeded with the recovered
photos. Uses boto3 with YOUR stored AWS credentials/profile.

Idempotent: album/photo keys are deterministic slugs/indexes, so re-running
overwrites the same items (never duplicates). Safe to run again.

    pip install boto3
    python3 scripts/load_gallery.py --table <ForumTable> --file web/photos.json --region us-east-1

Items written (single-table design, same table as the forum):
  Album META : PK=ALBUM#<albumId> SK=META  (type=album, GSI1PK=ALBUMLIST)
  Photo      : PK=ALBUM#<albumId> SK=PHOTO#<order:012d>#<photoId> (type=photo)

albumId is a stable slug of the album name. createdTs/GSI1SK are assigned so the
file's existing (newest-first) order is preserved when the API queries GSI1 with
ScanIndexForward=false: the first album in the file gets the highest value.
"""
import argparse, json, os, re, sys

# createdTs/GSI1SK base. First album in file => base - 0 (highest), so a
# ScanIndexForward=false query on GSI1 returns albums in file order.
TS_BASE = 2000000000


def slugify(name):
    """lowercase, non-alphanumeric -> '-', collapse repeats, strip ends.
    Deterministic and stable so re-runs overwrite the same items."""
    s = re.sub(r"[^a-z0-9]+", "-", name.lower())
    return s.strip("-")


def build_items(data):
    """Turn the photos.json structure into the list of DynamoDB items."""
    items = []
    albums = data.get("albums", [])
    n_albums = 0
    n_photos = 0
    for idx, alb in enumerate(albums):
        name = alb.get("album", "")
        album_id = slugify(name)
        photos = alb.get("photos", [])
        created_ts = TS_BASE - idx  # first album highest -> newest-first
        cover = photos[0] if photos else {}
        items.append({
            "PK": f"ALBUM#{album_id}",
            "SK": "META",
            "type": "album",
            "albumId": album_id,
            "name": name,
            "count": int(alb.get("count", len(photos))),
            "coverThumb": cover.get("t", ""),
            "coverFull": cover.get("f", ""),
            "createdTs": int(created_ts),
            "GSI1PK": "ALBUMLIST",
            "GSI1SK": int(created_ts),
        })
        n_albums += 1
        for i, ph in enumerate(photos):
            photo_id = f"{album_id}-{i}"
            items.append({
                "PK": f"ALBUM#{album_id}",
                "SK": f"PHOTO#{i:012d}#{photo_id}",
                "type": "photo",
                "photoId": photo_id,
                "thumb": ph.get("t", ""),
                "full": ph.get("f", ""),
                "caption": "",
                "order": int(i),
            })
            n_photos += 1
    return items, n_albums, n_photos


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--table", required=True)
    default_file = os.path.join(os.path.dirname(__file__), "..", "web", "photos.json")
    ap.add_argument("--file", default=default_file)
    ap.add_argument("--region", default="us-east-1")
    ap.add_argument("--profile", default=None, help="AWS profile name (optional)")
    args = ap.parse_args()

    if not os.path.isfile(args.file):
        print(f"No gallery manifest at {args.file}; skipping gallery import.")
        sys.exit(0)

    with open(args.file, encoding="utf-8") as f:
        data = json.load(f)

    items, n_albums, n_photos = build_items(data)
    if not items:
        print("Gallery manifest has no albums; nothing to load.")
        sys.exit(0)

    try:
        import boto3
    except ImportError:
        sys.exit("Missing boto3. Run:  pip install boto3")

    session = boto3.Session(profile_name=args.profile, region_name=args.region) \
        if args.profile else boto3.Session(region_name=args.region)
    table = session.resource("dynamodb").Table(args.table)

    n = 0
    with table.batch_writer() as bw:
        for it in items:
            bw.put_item(Item=it)
            n += 1
            if n % 200 == 0:
                print(f"  ...{n} items")
    print(f"Loaded gallery into {args.table}: "
          f"{n_albums} albums + {n_photos} photos ({n} items).")


if __name__ == "__main__":
    main()
