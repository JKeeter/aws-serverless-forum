# Serverless Forum

A complete, white-label **community forum website you deploy to your own AWS
account** — with no server to patch and a bill of roughly **$0–2/month** at
small-community scale (25–100 members). Static front end + managed AWS
services + one small Lambda. Reading is public; posting requires a free
member account.

## Features

- **Forum**: categories, topics, replies; edit/delete your own posts; admin
  moderation (delete any post, create categories)
- **Auth**: Cognito email+password with in-page login/registration/password
  reset; optional Google and Facebook sign-in (config-only, no code changes)
- **Announcements** posted by admins, shown on the home page
- **Photo albums**: admin-managed gallery with lightbox
- **Member directory** and public member profiles (members-only visibility)
- **Editable pages** (About / Contact / home intro) and a links list — edited
  from the admin UI, stored in the database
- **Uploads**: members attach images/PDFs via presigned S3 URLs (the Lambda
  never touches the bytes; type-allowlisted)
- **Legacy import**: bring your old forum's threads in as read-only archive
  content — see [IMPORT.md](IMPORT.md)
- **White-label**: name, logo, nav, footer in one config file; 2 layouts
  (classic sidebar / modern top-nav) × 4 color themes — see
  [CUSTOMIZE.md](CUSTOMIZE.md)

## Architecture

```
                          your-domain.com
                                 │
                         ┌───────▼────────┐
                         │   CloudFront    │  (TLS via ACM, caching)
                         └───┬────────┬────┘
              default /*     │        │   /api/*
        ┌──────────────────┐ │        │ ┌───────────────────────────┐
        │  S3: web bucket   │◄┘        └►│  API Gateway (HTTP API)   │
        │  static SPA       │           │   JWT authorizer (Cognito) │
        └──────────────────┘           └───────────┬───────────────┘
                                                    │  Lambda (Node.js 20)
             /media/*  ┌───────────────┐  ┌──────────┴───────────┐
        ────────────►  │ S3: media     │  │ categories / topics  │
                       │ (attachments) │  │ posts / profiles /   │
                       └───────────────┘  │ albums / pages       │
                                          └──────────┬───────────┘
                                              ┌──────▼───────┐
                                              │  DynamoDB     │  single table
                                              │  (on-demand)  │
                                              └──────────────┘
        Auth: Amazon Cognito User Pool (email+password, email verification, JWTs)
```

No server, no database engine to patch. User posts are stored as text and
rendered as text (never HTML), so the stored-XSS/defacement class of attack
that ruins forums can't execute. DynamoDB point-in-time recovery is on.
Full design rationale: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Cost (25–100 members, light traffic)

| Service | Typical monthly |
|---|---|
| S3 (web + media, a few GB) | < $0.25 |
| CloudFront (first 1 TB egress free) | ~$0 |
| API Gateway HTTP API ($1/million req) | < $0.50 |
| Lambda (1M req + 400k GB-s free) | ~$0 |
| DynamoDB on-demand + PITR | < $0.50 |
| Cognito (free tier: thousands of MAUs) | ~$0 |
| **Total** | **~$0–2/month** (plus your domain) |

## Quickstart

Prereqs: an AWS account with working CLI credentials, AWS CLI v2, AWS SAM CLI,
Python 3 + `boto3`, Node 20+.

```bash
git clone <your-copy-of-this-template> my-forum && cd my-forum/forum
npm install && node test/itest.mjs   # optional: verify locally — no AWS needed
bash scripts/deploy.sh               # deploys everything to us-east-1
```

The deploy prints your live CloudFront URL. Then register on the site and make
yourself an admin:

```bash
aws cognito-idp admin-add-user-to-group \
  --user-pool-id <UserPoolId-from-deploy-output> \
  --username <your-email> --group-name admins --region us-east-1
```

Next steps:
- **Brand it** — edit `forum/web/site.config.js` (name, logo, nav, theme,
  layout) and re-run deploy: [CUSTOMIZE.md](CUSTOMIZE.md)
- **Custom domain + social login** — [forum/DEPLOY.md](forum/DEPLOY.md)
- **Import your old forum** — [IMPORT.md](IMPORT.md)

## Local development & tests

```bash
cd forum
npm install
npx playwright install chromium   # once, for the browser tests + dev server
node test/itest.mjs               # 93 API checks against a local DynamoDB (dynalite)
node test/web_smoke.mjs           # 32 browser checks: structure, XSS-safety, themes, layouts
node test/devserver.mjs           # full local forum at http://localhost:8100 (fake login printed at startup)
```

No Docker, no AWS credentials needed for any of the above.

## License

[MIT](LICENSE)
