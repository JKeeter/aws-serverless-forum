#!/usr/bin/env bash
# One-command deploy for the serverless forum.
# Runs on YOUR machine with YOUR AWS credentials (aws sts get-caller-identity
# should already work). Prereqs: awscli v2, aws-sam-cli, python3+boto3, node.
set -euo pipefail

STACK="${STACK:-serverless-forum}"
REGION="${REGION:-us-east-1}"          # us-east-1 required (CloudFront ACM certs live there)
IMPORT_FILE="${IMPORT_FILE:-}"          # optional: topics.json export of your old forum (see IMPORT.md)
DOMAIN="${DOMAIN:-}"                    # optional custom domain, e.g. forum.example.com
ALT_DOMAIN="${ALT_DOMAIN:-}"            # optional second alias, e.g. www.example.com (must be on the cert)
ACM_ARN="${ACM_ARN:-}"                 # ACM cert ARN in us-east-1 (needed only with DOMAIN)
# Cognito's hosted-login domain prefix must stay STABLE across redeploys (changing
# it forces a domain rename that Cognito rejects mid-update). Reuse the existing
# stack's prefix if the stack is already deployed; only randomize on first create.
COGNITO_PREFIX="${COGNITO_PREFIX:-}"
if [ -z "$COGNITO_PREFIX" ]; then
  _EXIST=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='CognitoDomain'].OutputValue" --output text 2>/dev/null || true)
  if [ -n "$_EXIST" ] && [ "$_EXIST" != "None" ]; then
    COGNITO_PREFIX="${_EXIST%%.*}"        # strip .auth.<region>.amazoncognito.com
  else
    # Prefix must be globally unique across ALL AWS accounts and is limited to
    # lowercase alphanumerics + hyphen, so normalize the stack name and use a
    # wide random suffix instead of $RANDOM's 15 bits.
    _SAFE=$(printf '%s' "$STACK" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/^-*//;s/-*$//' | cut -c1-30)
    COGNITO_PREFIX="${_SAFE:-forum}-$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')"
  fi
fi
# Optional social login. Fill these in (export before running) once you've
# registered the Google Cloud OAuth client / Meta app; leave empty to run on
# email+password only. No code changes needed either way.
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}"
GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-}"
FACEBOOK_APP_ID="${FACEBOOK_APP_ID:-}"
FACEBOOK_APP_SECRET="${FACEBOOK_APP_SECRET:-}"

here="$(cd "$(dirname "$0")/.." && pwd)"; cd "$here"

# ---- fail fast: validate the env contract BEFORE spending 10+ min on a deploy
if [ -n "$DOMAIN" ] && [ -z "$ACM_ARN" ]; then
  echo "ERROR: DOMAIN=$DOMAIN was set but ACM_ARN is empty." >&2
  echo "       The stack would deploy WITHOUT your domain (CloudFront needs the" >&2
  echo "       us-east-1 certificate), and your DNS would 403. See DEPLOY.md." >&2
  exit 1
fi
if [ -n "$ACM_ARN" ] && [ -z "$DOMAIN" ]; then
  echo "ERROR: ACM_ARN was set but DOMAIN is empty — nothing to attach it to." >&2; exit 1
fi
if [ -n "$ALT_DOMAIN" ] && [ -z "$DOMAIN" ]; then
  echo "ERROR: ALT_DOMAIN was set but DOMAIN is empty." >&2; exit 1
fi
if [ -n "$IMPORT_FILE" ]; then
  [ -f "$IMPORT_FILE" ] || { echo "ERROR: IMPORT_FILE not found: $IMPORT_FILE" >&2; exit 1; }
  # Parse/validate the export now rather than after the stack is built.
  echo "==> Validating $IMPORT_FILE"
  python3 scripts/build_seed.py --file "$IMPORT_FILE" --out ./build
fi
echo "==> Account: $(aws sts get-caller-identity --query Account --output text) region=$REGION"

# 1) Build + deploy the stack
echo "==> sam build"
sam build
echo "==> sam deploy"
PARAMS="CognitoDomainPrefix=$COGNITO_PREFIX"
[ -n "$DOMAIN" ]  && PARAMS="$PARAMS DomainName=$DOMAIN"
[ -n "$ACM_ARN" ] && PARAMS="$PARAMS AcmCertificateArn=$ACM_ARN"
[ -n "$ALT_DOMAIN" ] && PARAMS="$PARAMS AltDomainName=$ALT_DOMAIN"
[ -n "$GOOGLE_CLIENT_ID" ]     && PARAMS="$PARAMS GoogleClientId=$GOOGLE_CLIENT_ID GoogleClientSecret=$GOOGLE_CLIENT_SECRET"
[ -n "$FACEBOOK_APP_ID" ]      && PARAMS="$PARAMS FacebookClientId=$FACEBOOK_APP_ID FacebookClientSecret=$FACEBOOK_APP_SECRET"
sam deploy --stack-name "$STACK" --region "$REGION" \
  --capabilities CAPABILITY_IAM --resolve-s3 \
  --no-confirm-changeset --no-fail-on-empty-changeset \
  --parameter-overrides $PARAMS

# 2) Read stack outputs
out(){ aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
WEB=$(out WebBucketName); MEDIA=$(out MediaBucketName); TABLE=$(out TableName)
DIST=$(out DistributionId); SITE=$(out SiteURL); CFDOMAIN=$(out CloudFrontDomain)
COG_DOMAIN=$(out CognitoDomain); CLIENT=$(out UserPoolClientId); POOL=$(out UserPoolId)
echo "==> web=$WEB media=$MEDIA table=$TABLE dist=$DIST"

# 2b) Register the CloudFront (+ custom-domain) URL as a valid Cognito callback.
#     The template can't do this without a circular dependency; this preserves all
#     other client settings.
CB_URLS="https://$CFDOMAIN/"
[ -n "$DOMAIN" ] && CB_URLS="$CB_URLS https://$DOMAIN/"
[ -n "$ALT_DOMAIN" ] && CB_URLS="$CB_URLS https://$ALT_DOMAIN/"
echo "==> Registering login callback URLs: $CB_URLS"
python3 scripts/register_callback.py --pool "$POOL" --client "$CLIENT" \
  --region "$REGION" --urls $CB_URLS

# 3) Write the front-end runtime config with real IDs (+ only the social
#    providers actually configured). Branding lives in site.config.js and is
#    never touched by deploys.
SOCIAL="[]"
[ -n "$GOOGLE_CLIENT_ID" ] && SOCIAL='["Google"]'
[ -n "$FACEBOOK_APP_ID" ]  && SOCIAL='["Facebook"]'
[ -n "$GOOGLE_CLIENT_ID" ] && [ -n "$FACEBOOK_APP_ID" ] && SOCIAL='["Google","Facebook"]'
cat > web/config.js <<EOF
window.FORUM_CONFIG = {
  apiBase: "/api",
  cognitoDomain: "$COG_DOMAIN",
  clientId: "$CLIENT",
  redirectUri: window.location.origin + "/",
  socialProviders: $SOCIAL,
};
EOF

# 4) Upload the front end
echo "==> Uploading web app"
aws s3 sync web "s3://$WEB" --delete \
  --cache-control "no-cache" --exclude "*.png" --exclude "*.jpg"
# Re-push the assets with a long cache header. `cp --recursive`, not `sync`:
# non-png/jpg assets (e.g. logo.svg) were already uploaded above with no-cache,
# and a sync would see them as current and skip, never applying this header.
aws s3 cp web/assets "s3://$WEB/assets" --recursive \
  --cache-control "public,max-age=86400"

# 5) Optional: import a legacy forum export (see IMPORT.md)
if [ -n "$IMPORT_FILE" ]; then
  # seed.ndjson was already built and validated during the pre-flight above
  echo "==> Loading forum seed into DynamoDB"
  python3 scripts/load_seed.py --table "$TABLE" --file build/seed.ndjson --region "$REGION"
fi

# 5b) Optional: seed the photo gallery (albums + photos) from a manifest
if [ -f web/photos.json ]; then
  echo "==> Loading photo gallery into DynamoDB"
  python3 scripts/load_gallery.py --table "$TABLE" --file web/photos.json --region "$REGION"
fi

# 6) Invalidate CloudFront cache
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" >/dev/null || true

echo ""
echo "======================================================================"
echo " Deployed.  Your forum: $SITE"
echo " Cognito login domain:  https://$COG_DOMAIN"
echo ""
echo " Next:"
echo "  • Register yourself, then make your account an admin:"
echo "      aws cognito-idp admin-add-user-to-group --user-pool-id $POOL \\"
echo "        --username <your-email> --group-name admins --region $REGION"
echo "  • As admin, create categories in the UI and edit the About/Contact pages."
echo "  • Custom domain: point your DNS at the CloudFront domain once ACM is"
echo "    validated (see DEPLOY.md)."
echo "======================================================================"
