# Deploy guide

A serverless forum on **S3 + CloudFront + HTTP API + Lambda + DynamoDB +
Cognito**. No server to patch; ~$0–2/month at small-community scale. You
deploy it to **your** AWS account; everything below runs on your machine with
your stored credentials.

## Prerequisites (one-time)

- An AWS account; `aws sts get-caller-identity` already works with your creds.
- **AWS CLI v2**, **AWS SAM CLI**, **Python 3 + boto3** (`pip install boto3`),
  **Node 20+** (for the optional tests/dev server).
- Deploy in **us-east-1** — CloudFront's TLS certificate (ACM) must live there.

## Fastest path (CloudFront domain first, custom domain later)

```bash
cd forum
bash scripts/deploy.sh
```

That builds and deploys the stack, uploads the web app, and prints your live
CloudFront URL. The forum starts empty — categories are created in the admin
UI. To also import an old forum's threads, set `IMPORT_FILE` first (see
[IMPORT.md](../IMPORT.md)).

### Environment variables (all optional)

| Variable | Default | Purpose |
|---|---|---|
| `STACK` | `serverless-forum` | CloudFormation stack name (also prefixes resource names) |
| `REGION` | `us-east-1` | Keep us-east-1 unless you skip the custom domain |
| `IMPORT_FILE` | *(unset)* | Path to a `topics.json` legacy export to import |
| `DOMAIN` | *(unset)* | Custom domain, e.g. `forum.example.com` |
| `ACM_ARN` | *(unset)* | ACM certificate ARN in us-east-1 (required with `DOMAIN`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | *(unset)* | Enable Google login |
| `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` | *(unset)* | Enable Facebook login |
| `COGNITO_PREFIX` | auto | Hosted-login domain prefix; auto-generated once, then reused |

### Make yourself an admin

Register on the site first (so your Cognito user exists), then:

```bash
aws cognito-idp admin-add-user-to-group \
  --user-pool-id <UserPoolId-from-deploy-output> \
  --username <your-email> --group-name admins --region us-east-1
```

Log out/in; you can now create categories, post announcements, manage albums,
edit the About/Contact pages, and moderate posts.

## Enabling Google / Facebook login (optional)

Email+password works out of the box. To add social login you register an app
with each provider, then redeploy with the credentials — no code changes.

1. **Google**: Google Cloud Console → APIs & Services → Credentials → create an
   **OAuth client ID** (type: Web). Authorized redirect URI:
   `https://<CognitoDomain>/oauth2/idpresponse` (CognitoDomain is in the deploy
   output). Copy the client ID + secret.
2. **Facebook**: developers.facebook.com → create an app → Facebook Login.
   Valid OAuth redirect URI: the same `.../oauth2/idpresponse`. Copy the app
   ID + secret.
3. Redeploy with the creds exported:
   ```bash
   export GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...
   export FACEBOOK_APP_ID=...  FACEBOOK_APP_SECRET=...
   bash scripts/deploy.sh
   ```
   Only the buttons you configured appear on the login card.

## Adding a custom domain

1. **Request an ACM certificate in us-east-1** for your domain (and `www.` if
   wanted) and complete DNS validation at your registrar.
2. Redeploy with the domain + cert:
   ```bash
   export DOMAIN="forum.example.com"
   export ACM_ARN="arn:aws:acm:us-east-1:<account>:certificate/xxxx"
   bash scripts/deploy.sh
   ```
3. At your DNS host, point the domain at the CloudFront domain (ALIAS/ANAME,
   or a CNAME on a subdomain). CloudFront's domain is in the deploy output.

Cognito's login callbacks are registered for both the CloudFront URL and your
custom domain, so logins work before and after the DNS switch.

## Matching the login page to your theme (optional)

```bash
bash scripts/apply_login_branding.sh
```

Derives colors/logo from your active theme (see
[CUSTOMIZE.md](../CUSTOMIZE.md)). Re-run after a fresh stack create or a theme
change. Not managed by CloudFormation; uses macOS `sips`.

## Re-running / updating

`scripts/deploy.sh` is safe to run again — code changes redeploy, and the seed
import is idempotent (same keys overwrite, never duplicate).

## Verifying locally (optional, no AWS needed)

```bash
npm install                     # test deps only
npx playwright install chromium # once, for the browser test + dev server
node test/itest.mjs             # 93 API checks vs a local DynamoDB (dynalite)
node test/web_smoke.mjs         # 32 browser checks: structure, XSS-safety, themes, layouts
node test/devserver.mjs         # full click-through at http://localhost:8100
                                # (real handler on local DynamoDB, sample categories;
                                #  a dev-token login snippet is printed at startup)
```
