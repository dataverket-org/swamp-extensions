#!/usr/bin/env python3
"""A stand-in for Salmon's issuer, for the batches that need no Salmon image.

It serves discovery and a token endpoint under /<mode>/issuer and answers an
exchange as the mode says, so the check can be held to what it must never do
with a token: repeat it. The last subject token it was sent is written to
<work>/subject-token (mode 600), for the harness to search for; it is never
printed.

  standin.py <port> <work directory>

  ok      200, an unsigned JWT with a subject and one role
  echo    400 invalid_grant, the description repeats the subject token
  html    500, a page that repeats the subject token
  other   200 without access_token, the subject token under id_token
  opaque  200, an access_token that is not a JWT
  page    discovery answers with an HTML page
  ftp     discovery names a token endpoint that is not http
"""
import base64
import json
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1])
WORK = sys.argv[2]


def b64(obj):
    raw = json.dumps(obj).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, status, body, kind="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        mode = self.path.split("/")[1]
        if self.path != f"/{mode}/issuer/.well-known/openid-configuration":
            self.send(404, {"error": "not_found"})
        elif mode == "page":
            self.send(200, b"<html><body>Please log in</body></html>",
                      "text/html")
        elif mode == "ftp":
            self.send(200, {"token_endpoint": "ftp://127.0.0.1/token"})
        else:
            base = f"http://127.0.0.1:{PORT}/{mode}/issuer"
            self.send(200, {"issuer": base, "token_endpoint": f"{base}/token"})

    def do_POST(self):
        mode = self.path.split("/")[1]
        length = int(self.headers.get("Content-Length", "0"))
        form = urllib.parse.parse_qs(self.rfile.read(length).decode())
        token = form.get("subject_token", [""])[0]
        path = os.path.join(WORK, "subject-token")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(token + "\n")
        if mode == "ok":
            claims = {"sub": "trust/smoke", "roles": ["users/Registry-Push"]}
            jwt = f"{b64({'alg': 'none'})}.{b64(claims)}.c21va2U"
            self.send(200, {
                "access_token": jwt,
                "token_type": "Bearer",
                "issued_token_type":
                    "urn:ietf:params:oauth:token-type:access_token",
                "expires_in": 60,
                "scope": "openid",
            })
        elif mode == "echo":
            self.send(400, {
                "error": "invalid_grant",
                "error_description": f"subject_token {token} is not trusted",
            })
        elif mode == "html":
            page = f"<h1>500</h1><p>could not verify {token}</p>".encode()
            self.send(500, page, "text/html")
        elif mode == "other":
            self.send(200, {"id_token": token, "token_type": "Bearer"})
        elif mode == "opaque":
            self.send(200, {"access_token": "opaque-" + "x" * 40})
        else:
            self.send(404, {"error": "not_found"})


HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
