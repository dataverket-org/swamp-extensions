#!/usr/bin/env python3
"""A proxy in front of a throwaway registry that fails chosen requests.

For hostile.sh: it shows what `identify` does when a registry limits the
rate, refuses a login or breaks while cosign looks for signatures.

    fault-proxy.py <upstream host:port> <port to listen on> <rule file> [<log file>]

The rule file is read on every request and holds one rule per line:
`<regular expression on the request path> <HTTP status>`. The first rule
that matches answers with that status and a registry error body; a request
that matches none is passed to the upstream over plain HTTP. With a log
file, every request is added to it as `<method> <path>`, so a caller can
see which requests a command makes and fail each in turn. Only GET and
HEAD are served, on 127.0.0.1, and only a 127.0.0.1 or localhost upstream
is accepted.
"""
import http.server
import json
import re
import sys
import urllib.error
import urllib.request

CODES = {401: "UNAUTHORIZED", 403: "DENIED", 429: "TOOMANYREQUESTS",
         500: "UNKNOWN", 503: "UNAVAILABLE"}


def main():
    upstream, port, rules = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    log = sys.argv[4] if len(sys.argv) > 4 else None
    if not re.match(r"^(127\.0\.0\.1|localhost):\d+$", upstream):
        sys.exit(f"refusing {upstream}: only a registry on 127.0.0.1 or localhost")

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def fault(self):
            try:
                with open(rules) as f:
                    for line in f:
                        parts = line.split()
                        if len(parts) == 2 and re.search(parts[0], self.path):
                            return int(parts[1])
            except FileNotFoundError:
                pass
            return None

        def answer(self, status, headers, body):
            self.send_response(status)
            for name, value in headers:
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def serve(self):
            if log:
                with open(log, "a") as f:
                    f.write(f"{self.command} {self.path}\n")
            status = self.fault()
            if status is not None:
                body = json.dumps({"errors": [{
                    "code": CODES.get(status, "UNKNOWN"),
                    "message": "injected by fault-proxy.py",
                }]}).encode()
                headers = [("Content-Type", "application/json")]
                if status == 401:
                    headers.append(("WWW-Authenticate", 'Basic realm="fault"'))
                return self.answer(status, headers, body)
            request = urllib.request.Request(
                f"http://{upstream}{self.path}", method=self.command,
                headers={k: v for k, v in self.headers.items()
                         if k.lower() != "host"})
            try:
                response = urllib.request.urlopen(request)
            except urllib.error.HTTPError as err:
                response = err
            body = response.read()
            headers = [(k, v) for k, v in response.headers.items()
                       if k.lower() not in ("transfer-encoding", "connection",
                                            "content-length")]
            self.answer(response.status, headers, body)

        do_GET = do_HEAD = serve

    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


main()
