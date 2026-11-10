# @dataverket/cert-manager

[cert-manager](https://cert-manager.io/) for swamp: Certificates,
CertificateRequests, ACME Orders and Challenges and issuers as swamp data, read
with `kubectl`, and a forced renewal that does what `cmctl renew` does.

Five model types, one per kind:

| Type                                          | Methods                         | Records                                                                                                          |
| --------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@dataverket/cert-manager/certificate`        | `list`, `get`, `trace`, `renew` | Ready and Issuing, validity window, seconds until expiry, names, issuer, revision; the issuance chain; a renewal |
| `@dataverket/cert-manager/certificaterequest` | `list`, `get`                   | The Certificate and revision it belongs to, Approved, Denied, Ready, InvalidRequest, failure time                |
| `@dataverket/cert-manager/order`              | `list`, `get`                   | State and reason, names, authorizations in summary, failure time, the owning CertificateRequest                  |
| `@dataverket/cert-manager/challenge`          | `list`, `get`                   | HTTP-01 or DNS-01, DNS name, wildcard, state and reason, presented, processing, solver kind, the owning Order    |
| `@dataverket/cert-manager/issuer`             | `list`, `get`                   | Issuer and ClusterIssuer: type, Ready, the ACME directory URL                                                    |

An object that is not healthy is a record that says so, never a failed method: a
Certificate that is not Ready, a Challenge that hangs, an issuer that cannot
register. A method fails only when the call itself is broken: the object does
not exist, access is refused, the login has expired, cert-manager is not
installed, or `kubectl` cannot be run.

## Prerequisites

- `kubectl` on the PATH swamp runs with, version 1.24 or newer (`renew` uses
  `kubectl patch --subresource`). Run with kubectl 1.37.
- A kubeconfig that may `get` and `list` the kinds you read. `renew` also needs
  `patch` on `certificates/status` in API group `cert-manager.io`; that
  subresource is its own right, `patch` on `certificates` is not enough.
- Developed and tested against cert-manager v1.20.

## Definitions

```sh
swamp model create @dataverket/cert-manager/certificate certs \
  --global-arg context=my-cluster
swamp model create @dataverket/cert-manager/certificate web-certs \
  --global-arg context=my-cluster --global-arg namespace=web
swamp model create @dataverket/cert-manager/challenge challenges \
  --global-arg kubeconfig=/path/to/kubeconfig

swamp model method run certs list
swamp model method run web-certs get --input name=www-example-org-tls
swamp model method run certs trace --input name=www-example-org-tls --input namespace=web
swamp model method run web-certs renew --input name=www-example-org-tls
```

| Global argument | Default             |                                                                                            |
| --------------- | ------------------- | ------------------------------------------------------------------------------------------ |
| `namespace`     | empty               | Empty lists all namespaces; a method on one object then needs its own `namespace` argument |
| `kubeconfig`    | kubectl's default   | Path to a kubeconfig file                                                                  |
| `context`       | the current context | Kubeconfig context name                                                                    |

A definition with a namespace lists that namespace, or another one given as an
argument; to list all namespaces, use a definition without one. Every method on
one object takes `name` and, optionally, `namespace`. Names and namespaces must
be Kubernetes names; anything else is refused before `kubectl` is run. The
definition's own `namespace` is checked when a method uses it, not when the
definition is made.

Every `kubectl` call carries `--request-timeout=30s`, and a `kubectl` that still
runs after 35 seconds is stopped. A cancelled run stops the `kubectl` it is
waiting for.

## Data

| Record                | Data name                                              | Written by           |
| --------------------- | ------------------------------------------------------ | -------------------- |
| One object            | `<namespace>--<name>`                                  | `list`, `get`        |
| One issuer            | `Issuer--<namespace>--<name>`, `ClusterIssuer--<name>` | issuer `list`, `get` |
| What a `list` run saw | `inventory_all`, or `inventory_ns_<namespace>` for one | every `list`         |
| A Certificate's chain | `trace_<namespace>--<name>`                            | `trace`              |
| A forced renewal      | `renewal_<namespace>--<name>`                          | `renew`              |

`trace` and `renew` also write the Certificate's own record, so it is current
after either.

A record of an object that was deleted stays in the data store. The inventory
record is the one that says which objects existed at `observedAt`:

| Field                            | Meaning                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `namespace`                      | The namespace listed; `null` when every namespace was listed                          |
| `count`                          | How many objects the list saw                                                         |
| `healthyCount`, `unhealthyCount` | How many of them are in their good state, and how many are not                        |
| `items[]`                        | One line per object: `namespace`, `name`, `dataName`, `healthy`, `state` and `reason` |
| `items[].dataName`               | The data name of the object's own record                                              |
| `items[].reason`                 | One line that says what is wrong; `null` when healthy                                 |

A Certificate is healthy when it is Ready and not expired; a CertificateRequest
when it is Ready; an Order or Challenge when its state is `valid`; an issuer
when it is Ready. The inventory of the issuer type holds both kinds; a
ClusterIssuer's `namespace` is `null`. Records of requests, orders and
challenges expire after 30 days, since the objects themselves are short-lived.

A list is all or nothing. When the call fails, when the answer is not a list of
that kind, or when two objects of different namespaces would be stored under one
data name (`a--b` in namespace `c` and `b--c` in namespace `a`), the method
fails and writes no record; list one namespace at a time in that last case.

Two objects can only share a data name when a namespace or a name holds `--`.
`list` sees both and refuses the pair. `get`, `trace` and `renew` read one
object and cannot see the other: with such names, the record of one replaces the
record of the other.

The issuer type's `list` with `kind` set records the issuers of that kind and no
inventory: an inventory always holds both kinds, and a narrowed list does not
replace it.

A workflow asserts over the inventory and over one Certificate:

```yaml
- name: all-certificates-ready
  task:
    type: assert
    expr: data.latest("certs", "inventory_all").attributes.unhealthyCount == 0
    message: >-
      ${{ data.latest("certs", "inventory_all").attributes.unhealthyCount }}
      certificates are not ready
- name: www-valid-two-weeks
  task:
    type: assert
    expr: >-
      data.latest("certs", "web--www-example-org-tls").attributes.secondsUntilExpiry
      > 14 * 86400
```

### The Certificate record

| Field                                                                           | Meaning                                                        |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `ready`, `readyReason`, `readyMessage`                                          | The Ready condition                                            |
| `issuing`, `issuingReason`, `issuingMessage`, `issuingSince`                    | The Issuing condition: an issuance is in progress              |
| `notBefore`, `notAfter`, `renewalTime`                                          | From the status; `null` before the first issuance              |
| `secondsUntilExpiry`, `expired`, `renewalDue`                                   | Derived from `notAfter` and `renewalTime` at `readAt`          |
| `dnsNames`, `commonName`, `ipAddresses`, `issuerRef`, `duration`, `renewBefore` | From the spec                                                  |
| `secretName`                                                                    | The name of the Secret only; the Secret is never read          |
| `revision`                                                                      | Rises by one with every issued certificate                     |
| `failedIssuanceAttempts`, `lastFailureTime`                                     | Set by cert-manager while an issuance keeps failing            |
| `nextPrivateKeySecretNamePresent`                                               | A next private key is staged, which happens during an issuance |

## trace: where does an issuance stand

When a certificate does not arrive, the answer is spread over four kinds of
object. `trace` reads them in one run: the Certificate, the issuer it refers to,
the CertificateRequest of the highest revision the Certificate owns, the ACME
Order that request owns, and the Challenges of that Order. The record holds
every level in full, plus:

- `stage`: `ready` when the Certificate is Ready and nothing is in progress,
  else the deepest level that is not done: `challenge`, `order`, `issuer`,
  `certificaterequest` or `certificate`.
- `summary`: one sentence naming the object at that level, its state and its
  reason.

A DNS-01 challenge that cannot be presented reads like this:

```json
{
  "stage": "challenge",
  "summary": "Challenge www-1-1264188995-1969857160 (DNS-01 for *.example.org, solver dns01/webhook) is pending, not presented: the server could not find the requested resource",
  "order": { "name": "www-1-1264188995", "state": "pending" },
  "certificateRequest": {
    "name": "www-1",
    "state": "Pending",
    "certificateRevision": 1
  }
}
```

The issuer is context, not the subject. When it cannot be read, because access
is refused or another API group serves it, `issuer.error` says so, the trace
goes on, and the issuer is not named as the stage. An issuer that does not
exist, or that was read and is not Ready, is. Every other level must be
readable, or the trace fails and stores nothing.

cert-manager deletes Challenges when their Order is done, so `challenges` is
empty for an issued certificate. Authorization challenge types in an Order are
written as the ACME server names them (`dns-01`); a Challenge's `type` is
written as cert-manager does (`DNS-01`).

## renew: force a renewal

`renew` is `cmctl renew` for one Certificate, through `kubectl`. It sets the
`Issuing` condition to `True` with reason `ManuallyTriggered` on the
Certificate's status subresource, which is what
[cmctl does](https://cert-manager.io/docs/reference/cmctl/#renew) and what
cert-manager's own trigger controller does when a certificate is due. The
controllers then make a new private key and a new CertificateRequest of the next
revision.

In order:

1. The Certificate is read. One that does not exist is refused.
2. One that is already issuing is refused, with the time the issuance started.
   `cmctl` does not refuse here; a second trigger changes nothing, and an
   issuance that hangs needs `trace`, not another trigger.
3. The condition is patched, bound to the `resourceVersion` that was read. If
   the Certificate changed in between, the API server refuses the patch and
   nothing is changed; run it again. This refusal is shown against the fake
   `kubectl` of the unit tests only: the read and the patch follow each other
   too closely to place a change between them on a real cluster without a test
   hook. The patch is a merge patch of `status.conditions`, which replaces the
   whole list, so every other condition is written back exactly as it was read.
   The patch body is given to `kubectl` on standard input
   (`--patch-file=/dev/stdin`): it is in no argument list. When the patch fails,
   what `kubectl` said is repeated with every value the patch sent blanked, and
   ends where a JSON body begins, because a server that calls a patch invalid
   repeats it.
4. The answer to the patch must show the condition. A change that was not
   applied is an error. When the answer did not arrive or cannot be read (no
   answer in time, a broken connection, a cancelled run, output that is not the
   Certificate), nobody knows whether the server applied the patch: the error
   says that the renewal may have been triggered and to read the Certificate
   with `get`. No record is written in that case.
5. The Certificate is read every 2 seconds until the Issuing condition is gone
   or `waitSeconds` have passed (default 20, at most 120, 0 does not wait). The
   time the reads take counts as waiting.
6. The `renewal` record stores `revisionBefore`, `revisionAfter`,
   `notAfterBefore`, `notAfterAfter` and the `outcome`.

| `outcome`     | Meaning                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------- |
| `issued`      | The revision rose and the Issuing condition is gone                                         |
| `in-progress` | Still issuing when the poll ended; the renewal goes on in the cluster, read it with `trace` |
| `failed`      | cert-manager set Issuing to False without a new revision; the reason is in `issuingMessage` |
| `not-issued`  | The Issuing condition is gone without a new revision                                        |
| `deleted`     | The Certificate no longer existed at a read after the trigger                               |

Only a trigger that was not applied, or whose answer is unknown, fails the
method. An issuance that is slow or fails after the trigger is a record. If a
read fails during the poll, the poll ends and `pollError` says why; the trigger
was applied. If the Certificate is deleted during the poll, the outcome is
`deleted`, `pollError` says that it does not exist, the other fields are those
of the last read that found it, and only the `renewal` record is written: a
Certificate that is gone gets no record of its own. A run that is cancelled
during the poll fails as cancelled and writes no record; the trigger, once
applied, stays applied.

`renew` is the only method that changes anything, and all it changes is that one
condition.

## What is never stored

No CSR, no certificate or CA body, no ACME token or key, no ACME URL, no solver
configuration, no ACME account detail. No Secret is read. A solver is recorded
by kind (`dns01/webhook`, `dns01/cloudflare`, `http01/ingress`) and, for a
webhook, its `solverName`. What `kubectl` prints on standard output, the objects
themselves, is never copied into an error message; only its error text is, as
one bounded line with anything shaped like a credential blanked.

Messages are not fields, and cert-manager quotes secrets in them. When its own
check of an HTTP-01 challenge gets another answer, the Challenge's reason reads
`... expected "<key authorization>" but got: ...`, and the key authorization
starts with the challenge token. So every text field of every record is blanked
before it is stored or logged:

- A Challenge's `spec.token` and `spec.key`, and every challenge token an
  Order's authorizations list, are blanked by value in that object's record.
- `trace` blanks the tokens and keys of the chain's Order and Challenges in
  every level, in the `summary` and in its log line.
- Where the object does not hold the token (a CertificateRequest, a Certificate,
  an issuer, a list of them), a key authorization is found by its shape: a token
  of 22 or more base64url characters, a dot, and the 43 base64url characters of
  the account key's thumbprint, standing alone. Its token is then blanked too.
- The common redaction of this repository's extensions (bearer tokens, PEM
  blocks, `password=` and the like) is applied to the same fields.

What that does not cover: a challenge token or a DNS-01 value quoted on its own
in a message of an object that does not hold it, outside a `trace`. Neither has
a shape that tells it from a hash or an id. No such message of cert-manager
v1.20 is known. The other way round, a name whose last two labels are 22 or more
and exactly 43 characters long is taken for a key authorization when a message
quotes it. The fields that identify an object (names, namespaces, DNS names) are
never blanked.

## Testing

The live suite in [smoke/](./smoke/README.md) was run on Linux with rootless
Podman and a kind cluster made with kind's Podman provider, against cert-manager
v1.20 and Pebble, the Let's Encrypt test ACME server. `smoke/README.md` says
what it needs and what it covers.

## Development

```sh
deno task check && deno task lint && deno task fmt:check && deno task test
```

The types import the shared kubectl layer of this repository as `../lib/`, so
the commands that package the extension take the repository root:
`swamp extension push manifest.yaml --extensions-dir ..`.

The unit tests run every method against a strict fake of `kubectl` that refuses
any call, argument or order it was not told to expect, and spawn nothing.

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Jan Ivar Beddari.
