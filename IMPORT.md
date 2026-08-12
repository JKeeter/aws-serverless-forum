# Importing a legacy forum

The template can import your old forum's threads as **read-only archive
content**: imported topics render inline alongside new discussion, clearly
badged "archived", attributed to the original authors' display names. No user
accounts are created or migrated — members simply re-register (old password
hashes can't and shouldn't be moved into Cognito).

## 1. Export your old forum to `topics.json`

Produce a single JSON file in this shape (from phpBB/vBulletin/Discourse/etc. —
however you can get the data out):

```json
{
  "topics": [
    {
      "id": "t1",
      "title": "Thread title",
      "category": "General",
      "author": "Name",
      "createdTs": 1234567890,
      "posts": [
        { "author": "Name", "body": "post text", "ts": 1234567890 }
      ]
    }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | unique per topic (string or number) |
| `title` | yes | plain text |
| `category` | no | display name; one forum category is created per distinct value (slugged id). Defaults to "Imported" |
| `author` | no | topic starter's display name; defaults to the first post's author |
| `createdTs` | no | epoch seconds or ISO-8601; defaults to the first post's `ts` |
| `posts[].body` | yes | plain text — stored and rendered as text (never HTML) |
| `posts[].author` | no | display name string |
| `posts[].ts` | no | epoch seconds **or** an ISO-8601 string (`2009-05-01T10:00:00Z`). A post without one is placed just after the previous post, so your array order always survives |

A runnable example lives at [`examples/topics.sample.json`](examples/topics.sample.json).

## 2. Import during deploy

```bash
cd forum
export IMPORT_FILE=/path/to/topics.json
bash scripts/deploy.sh
```

`deploy.sh` validates your file **before** it touches AWS, so a malformed
export fails in seconds rather than after a full stack deploy. It runs
`scripts/build_seed.py` (validates the file, emits
`build/seed.ndjson` in the forum's single-table key layout) and
`scripts/load_seed.py` (batch-writes it to DynamoDB). Without `IMPORT_FILE`,
deploy skips import entirely — a fresh forum starts empty and the first admin
creates categories in the UI.

**Idempotent:** topic/post keys are deterministic, so re-running the import
overwrites the same items — never duplicates. To re-import after fixing your
export, just run deploy again with `IMPORT_FILE` set.

## Preview locally first (no AWS)

```bash
cd forum
python3 scripts/build_seed.py --file /path/to/topics.json --out ./build
node test/devserver.mjs     # picks up build/seed.ndjson automatically
```

Open http://localhost:8100 and browse your imported forum before deploying.

## Bringing over post attachments (optional)

Post bodies are plain text, but any line that is a same-origin `/media/...`
path renders as an inline image (or a download link for PDFs). So to carry old
attachments across:

1. Upload the files to the media bucket under `media/archive/`:
   ```bash
   MEDIA=$(aws cloudformation describe-stacks --stack-name serverless-forum \
     --region us-east-1 --query "Stacks[0].Outputs[?OutputKey=='MediaBucketName'].OutputValue" \
     --output text)
   aws s3 sync ./old-attachments "s3://$MEDIA/media/archive"
   ```
2. In your `topics.json`, reference each one on its own line in the post body:
   ```json
   { "author": "Pat", "body": "Here's the photo from the meetup:\n/media/archive/meetup.jpg" }
   ```

Only `/media/...` paths render — arbitrary external URLs stay as plain text
links, which is what keeps imported content from injecting anything.

## Photo gallery seeding (optional)

If you have legacy photos, put a `photos.json` next to the web app in this
shape and `deploy.sh` will seed the albums:

```json
{ "albums": [ { "album": "Album Name", "count": 2,
    "photos": [ { "t": "/media/archive/thumb1.jpg", "f": "/media/photos/Album Name/full1.jpg" } ] } ] }
```

`t` = thumbnail URL, `f` = full-resolution URL — both must be same-origin
`/media/...` paths (sync the files to the media bucket, e.g.
`aws s3 sync ./photos s3://<media-bucket>/media/photos`). `load_gallery.py` is
idempotent the same way the topic import is. Albums are fully manageable from
the admin UI afterward.
