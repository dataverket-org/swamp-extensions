#!/usr/bin/env python3
"""Rewrites the `.sig` manifest of one image in a throwaway registry.

For hostile.sh: it shows that `identify` records nothing from a forged
certificate in the tag form. The manifest as it was copied is read from a
file, and its first layer is the real signature. A forged layer is that
layer with its certificate changed in one place: every whole value `<old>`
in the certificate becomes `<new>`, of the same length, which breaks the
certificate's own signature and keeps its identity and issuer. The manifest
is then written to the registry with <forged> forged layers first and
<real> real ones after.

    forge-tag-form.py <127.0.0.1:port> <repository> <sha256:hex> <manifest file> <old> <new> <forged> <real>

Only a registry on 127.0.0.1 or localhost, over plain HTTP, is accepted.
"""
import base64
import json
import re
import sys
import urllib.request

OCI = "application/vnd.oci.image.manifest.v1+json"
CERTIFICATE = "dev.sigstore.cosign/certificate"


def main():
    registry, repository, digest, original, old, new = sys.argv[1:7]
    forged, real = int(sys.argv[7]), int(sys.argv[8])
    if not re.match(r"^(127\.0\.0\.1|localhost):\d+$", registry):
        sys.exit(f"refusing {registry}: only a registry on 127.0.0.1 or localhost")
    old, new = old.encode(), new.encode()
    if len(old) != len(new):
        sys.exit("<old> and <new> must have the same length")
    url = f"http://{registry}/v2/{repository}/manifests/{digest.replace(':', '-')}.sig"
    with open(original) as f:
        manifest = json.load(f)
    layer = manifest["layers"][0]
    pem = layer["annotations"][CERTIFICATE]
    der = base64.b64decode("".join(
        line for line in pem.splitlines() if not line.startswith("-----")))
    # A whole value only: not where a longer value starts with it.
    out, at, count = bytearray(), 0, 0
    while at < len(der):
        if der.startswith(old, at) and der[at + len(old):at + len(old) + 1] != b"/":
            out += new
            at += len(old)
            count += 1
        else:
            out.append(der[at])
            at += 1
    if forged > 0 and count == 0:
        sys.exit("the certificate does not hold <old> as a whole value")
    body = base64.b64encode(bytes(out)).decode()
    fake = json.loads(json.dumps(layer))
    fake["annotations"][CERTIFICATE] = (
        "-----BEGIN CERTIFICATE-----\n" +
        "\n".join(body[i:i + 64] for i in range(0, len(body), 64)) +
        "\n-----END CERTIFICATE-----\n")
    manifest["layers"] = [fake] * forged + [layer] * real
    put = urllib.request.Request(url, data=json.dumps(manifest).encode(),
                                 method="PUT", headers={"Content-Type": OCI})
    urllib.request.urlopen(put)


main()
