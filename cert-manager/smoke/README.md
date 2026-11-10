# Smoke and negative suite

What the unit tests cannot say: that the arguments, the patch and the parsing
are the ones a real `kubectl`, a real cert-manager, a real ACME server and a
real swamp repository agree to. It runs against a throwaway cluster and spends
most of its effort on what should _not_ happen.

`setup.sh` installs cert-manager and
[Pebble](https://github.com/letsencrypt/pebble), the Let's Encrypt test ACME
server, with its challenge test server as the only DNS. That gives real Orders
and Challenges without a public name:

| Certificate             | Issuer                                             | Ends as                                                                                                |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pki/root-ca`           | self-signed ClusterIssuer                          | Ready                                                                                                  |
| `pki/leaf`              | CA Issuer                                          | Ready; the one the suite renews                                                                        |
| `pki/no-issuer`         | an Issuer that does not exist                      | Issuing forever, the request Pending                                                                   |
| `acme-test/web`         | Pebble, HTTP-01                                    | Ready: a real order, validated by Pebble over HTTP                                                     |
| `acme-test/hanging`     | Pebble, DNS-01 by a missing solver                 | Issuing forever: the order pending, two challenges that hang                                           |
| `acme-test/unreachable` | an ACME directory nothing serves                   | Issuing forever: the issuer never Ready, no order                                                      |
| `acme-test/wrong`       | Pebble, HTTP-01, its name served by another server | Issuing forever: the challenge pending, its reason quoting the key authorization cert-manager expected |

## Environment

The suite was run on 2026-11-10 on Linux x86_64 with:

| Tool      | Version         | Used for                                               |
| --------- | --------------- | ------------------------------------------------------ |
| `podman`  | 4.9.3, rootless | The container kind runs its node in                    |
| `kind`    | 0.33.0          | The throwaway cluster                                  |
| `kubectl` | 1.37            | Run by the extension and by the scripts                |
| `swamp`   | 20261110        | Runs the methods from a repository of its own          |
| `jq`      | 1.8             | Reads the output of each run                           |
| `curl`    | 8.23            | Fetches Pebble's test CA certificate from GitHub, once |

cert-manager v1.20.5, Pebble v2.10.1 and
`registry.k8s.io/e2e-test-images/agnhost:2.53` (the server that answers with
something else) are pulled from their registries, so the cluster needs outbound
access.

The cluster is made with kind's Podman provider, which kind itself calls
experimental, and with a kubeconfig file of its own:

```sh
KIND_EXPERIMENTAL_PROVIDER=podman kind create cluster --name cm-smoke --kubeconfig ./kubeconfig --wait 90s
```

Every script takes that kubeconfig as input: `setup.sh` and `models.sh` as their
argument, the batches as `KUBECONFIG_FILE`. None reads the default kubeconfig,
and each one stops before it does anything when the current context of the file
is not a `kind-*` context. No script makes or deletes the cluster.

What rootless Podman means for this suite: nothing. It needs no LoadBalancer
address, no host port and no port below 1024. Pebble, the challenge test server
and the HTTP-01 solver talk to each other over Service addresses inside the
cluster, and the scripts reach the cluster only through the API server port kind
publishes on localhost. The four Certificates that never become Ready are
unhealthy by design (a missing issuer, a DNS-01 solver that is not installed, an
ACME directory nothing serves, an HTTP-01 name another server answers for), not
because of the environment.

The whole suite, from `models.sh` to batch G, took 337 seconds; making the
cluster took about 40 seconds more. Measured with `podman stats` on the one kind
node, a sample every 6 seconds over that whole run: 0.18 CPU cores on average,
0.64 at the most (while `setup.sh` installs), and 520 to 793 MB of memory. The
methods and `kubectl` run on the host beside that.

Run on Linux x86_64. macOS on Apple silicon is expected to work with a Podman
machine of at least 2 CPUs and 4 GiB of memory; it was not yet run there. Docker
instead of Podman probably works, by leaving out `KIND_EXPERIMENTAL_PROVIDER`,
and is not tested.

## Run it

It needs the tools above. Never point it at a cluster you care about: `setup.sh`
installs cert-manager and changes its flags, which is why the scripts refuse
anything but a kind context. The Service range of the cluster must hold
`10.96.100.0/24`, which kind's default does.

The extension imports the shared kubectl layer as `../lib/`, so it is loaded
from a checkout of the whole repository: `swamp extension source add` takes the
extension's directory, and `lib/` must be beside it.

```sh
# 1. a cluster of its own, with a kubeconfig of its own
KIND_EXPERIMENTAL_PROVIDER=podman kind create cluster --name cm-smoke --kubeconfig ./kubeconfig --wait 90s
export KUBECONFIG_FILE=$PWD/kubeconfig

# 2. a swamp repository loading this extension from source, and the definitions
export REPO=$(mktemp -d)
(cd "$REPO" && swamp repo init --tool none --no-vault && swamp extension source add "$OLDPWD/..")
./models.sh "$KUBECONFIG_FILE"

# 3. batch A wants a cluster that has no cert-manager yet
./neg-a.sh

# 4. cert-manager, Pebble, issuers, certificates, ServiceAccount kubeconfigs
./setup.sh "$KUBECONFIG_FILE"

# 5. the suite
for b in b c d e f g; do ./neg-$b.sh; done

# 6. and away
KIND_EXPERIMENTAL_PROVIDER=podman kind delete cluster --name cm-smoke --kubeconfig ./kubeconfig
rm -rf "$REPO" .work kubeconfig
```

`setup.sh` writes its working files, the ServiceAccount kubeconfigs among them,
to `.work/` beside it, or to `$WORK` when set; `models.sh` and the batches read
the same variable. `CERT_MANAGER_VERSION` and `PEBBLE_VERSION` pick the
releases; run the suite on the cert-manager you deploy.

The scripts keep no log. Each batch prints one `PASS` or `FAIL` line per case
and a count; the output and error text of the last method run are in
`$REPO/.out.json` and `$REPO/.err.txt`, and go away with the repository. No log
of the run described here is kept in this repository.

## What each batch is for

| Batch | What it refuses to let pass                                                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a`   | A cluster without cert-manager answered with anything but "cert-manager is not installed"                                                                                       |
| `b`   | A kind read wrong, an unhealthy object thrown instead of recorded, an inventory that does not match its records, a missing object not named                                     |
| `c`   | A trace that stops at the wrong level: ready, challenge, issuer not ready, issuer missing; a quoted key authorization left in a trace                                           |
| `d`   | A renewal that does not raise the revision or rewrites another condition; a renewal of what is issuing, missing or misnamed                                                     |
| `e`   | Names and namespaces shaped as flags, shell and paths; a kubeconfig or context that is not there                                                                                |
| `f`   | A key that may only read renewing anything; a half trace stored; an unread issuer blamed                                                                                        |
| `g`   | A challenge token or key, a CSR, a PEM body or an account token anywhere in the repository; in particular the key authorization that the reason of the `wrong` Challenge quotes |

Every run is also checked for secrets: before each batch the harness collects
the challenge tokens and keys, the CSRs and the ServiceAccount tokens the
cluster holds into a file it never prints, and no run's output or error may
carry a line of it.

## What the suite does not show

These are shown against the fake `kubectl` of the unit tests only:

- The refusal of a patch whose `resourceVersion` is stale. The method reads and
  patches in one go, and no real sequence places a change between the two
  without a hook in the code.
- A Certificate deleted during the poll of `renew`, a cancelled run, a `kubectl`
  that hangs, and a patch whose answer never arrives.
- A server that repeats the patch body in its error.
- Two objects that would share one data name.

## How the ACME part works

Pebble validates for real. The challenge test server answers every DNS question
with the address of the `http01-solvers` Service, which sends port 80 to
whichever HTTP-01 solver pod cert-manager has started, so both cert-manager's
own check and Pebble's validation of `web.example.test` reach the solver. No
ingress controller is needed.

The DNS-01 issuer names a webhook solver that is not installed, and the test DNS
server answers no SOA question, so cert-manager can never present the challenge:
the order stays `pending` and the challenge stays `pending`, `presented: false`,
with the reason in its status. cert-manager works on one challenge for a name at
a time, so the second challenge of the same order has no status at all; the
suite reads both.

The Certificate `wrong` uses an issuer of its own, `pebble-http01-unheard`,
whose solver pods the `http01-solvers` Service does not select. `setup.sh` gives
its name, `wrong.example.test`, the address of the `wrong-answer` Service, which
answers every path with 200 and its own host name. cert-manager checks a
challenge itself before it tells the ACME server; that check gets the host name
instead of the key, and the Challenge's reason then reads
`... expected "<key authorization>" but got: ...`. Pebble is never asked. The
record is also set for the name with each search suffix of the cluster
(`.cert-manager.svc.cluster.local` and shorter), because the test DNS server
answers every name and cert-manager's resolver stops at the first answer.
