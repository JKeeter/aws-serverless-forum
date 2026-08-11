#!/usr/bin/env python3
"""Add callback/logout URLs to the Cognito app client WITHOUT clobbering its
other settings.

The SAM template can't reference the CloudFront domain in the client's
CallbackURLs (that would make Client -> Distribution -> HttpApi -> Client a
circular dependency, since the API's JWT authorizer audience IS this client).
So deploy.sh calls this after the stack is up to register the real CloudFront
(and custom-domain) URLs.

`update_user_pool_client` REPLACES the whole client config, so we describe the
existing client first and pass every field back, only merging in the new URLs.

    python3 register_callback.py --pool <id> --client <id> --region us-east-1 \
        --urls https://xxxx.cloudfront.net/ https://forum.example.com/
"""
import argparse
import boto3

# Fields update_user_pool_client accepts that we want to carry over untouched.
CARRY = [
    "ClientName", "RefreshTokenValidity", "AccessTokenValidity", "IdTokenValidity",
    "TokenValidityUnits", "ReadAttributes", "WriteAttributes", "ExplicitAuthFlows",
    "SupportedIdentityProviders", "AllowedOAuthFlows", "AllowedOAuthScopes",
    "AllowedOAuthFlowsUserPoolClient", "PreventUserExistenceErrors",
    "EnableTokenRevocation", "AuthSessionValidity",
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pool", required=True)
    ap.add_argument("--client", required=True)
    ap.add_argument("--region", default="us-east-1")
    ap.add_argument("--urls", nargs="+", required=True)
    a = ap.parse_args()

    c = boto3.client("cognito-idp", region_name=a.region)
    cur = c.describe_user_pool_client(
        UserPoolId=a.pool, ClientId=a.client)["UserPoolClient"]

    def merged(key):
        have = list(cur.get(key, []))
        for u in a.urls:
            if u not in have:
                have.append(u)
        return have

    kwargs = {"UserPoolId": a.pool, "ClientId": a.client,
              "CallbackURLs": merged("CallbackURLs"),
              "LogoutURLs": merged("LogoutURLs")}
    for k in CARRY:
        if k in cur and cur[k] not in (None, [], ""):
            kwargs[k] = cur[k]

    c.update_user_pool_client(**kwargs)
    print("Callback/logout URLs now:", kwargs["CallbackURLs"])


if __name__ == "__main__":
    main()
