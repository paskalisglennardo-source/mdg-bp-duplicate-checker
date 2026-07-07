from __future__ import annotations

import base64
import json
import os

path = os.environ.get("SERVICE_ACCOUNT_FILE", "service_account.json")
with open(path, "rb") as f:
    raw = f.read()

# Validate JSON so user does not upload a broken secret.
obj = json.loads(raw.decode("utf-8"))
print("Service account client_email:")
print(obj.get("client_email", "<missing>"))
print("\nRecommended Cloudflare Secret Name:")
print("GOOGLE_SERVICE_ACCOUNT_JSON_B64")
print("\nRecommended Cloudflare Secret Value, copy everything below:")
print(base64.b64encode(raw).decode("ascii"))
