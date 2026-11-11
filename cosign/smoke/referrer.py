#!/usr/bin/env python3
"""Adds a referrer to an image in a throwaway registry, in one of two ways.

For hostile.sh: it shows that `identify` leaves an artifact of another kind
alone, and that it does not take the label of a bundle for what the bundle
is. The registry must have a referrers API of its own.

    referrer.py add <127.0.0.1:port> <repository> <sha256:hex of the image> <artifact type>
    referrer.py relabel <127.0.0.1:port> <repository> <sha256:hex of a bundle's manifest> <predicate type>

`add` stores a small artifact of the given type that names the image as
its subject. `relabel` stores a copy of a Sigstore bundle's manifest whose
`dev.sigstore.bundle.predicateType` label is the one given: the same bundle
then stands beside the image twice, once under a label that does not say
what its statement says. Both print the digest of the manifest they wrote.
Only a registry on 127.0.0.1 or localhost, over plain HTTP, is accepted.
"""
import hashlib
import json
import re
import sys
import urllib.parse
import urllib.request

OCI = "application/vnd.oci.image.manifest.v1+json"
LABEL = "dev.sigstore.bundle.predicateType"


def main():
    what, registry, repository, digest, value = sys.argv[1:6]
    if not re.match(r"^(127\.0\.0\.1|localhost):\d+$", registry):
        sys.exit(f"refusing {registry}: only a registry on 127.0.0.1 or localhost")
    base = f"http://{registry}/v2/{repository}"

    def call(url, method="GET", data=None, headers=None):
        request = urllib.request.Request(url, data=data, method=method,
                                         headers=headers or {})
        return urllib.request.urlopen(request)

    def blob(data):
        name = "sha256:" + hashlib.sha256(data).hexdigest()
        where = call(f"{base}/blobs/uploads/", "POST").headers["Location"]
        where = urllib.parse.urljoin(f"http://{registry}", where)
        call(where + ("&" if "?" in where else "?") + "digest=" + name, "PUT",
             data, {"Content-Type": "application/octet-stream"})
        return {"digest": name, "size": len(data)}

    def manifest(body):
        data = json.dumps(body).encode()
        name = "sha256:" + hashlib.sha256(data).hexdigest()
        call(f"{base}/manifests/{name}", "PUT", data, {"Content-Type": OCI})
        return name

    if what == "add":
        image = call(f"{base}/manifests/{digest}", headers={"Accept": OCI}).read()
        print(manifest({
            "schemaVersion": 2,
            "mediaType": OCI,
            "artifactType": value,
            "config": {"mediaType": "application/vnd.oci.empty.v1+json",
                       **blob(b"{}")},
            "layers": [{"mediaType": "text/plain",
                        **blob(b"an artifact of another kind\n")}],
            "subject": {"mediaType": OCI, "digest": digest, "size": len(image)},
        }))
    elif what == "relabel":
        body = json.load(call(f"{base}/manifests/{digest}", headers={"Accept": OCI}))
        body.setdefault("annotations", {})[LABEL] = value
        print(manifest(body))
    else:
        sys.exit("the first argument is add or relabel")


main()
