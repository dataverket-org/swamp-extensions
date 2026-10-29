# @dataverket/http

One HTTP or HTTPS endpoint, asked whether it answers, as swamp data. One model
type, `@dataverket/http/endpoint`, one URL, one method, `health`, read-only.

| Method   | Does                                                     | Records                                                                                                    |
| -------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `health` | GETs the URL, follows redirects, reads the body if asked | `health`: final URL, reachable, status, ok, TLS verified or not, latency, redirects, body match, the error |

An endpoint that is down, slow, wrong or serving a chain that does not verify is
a record with `ok: false` and the reason in `error`, never a failed method, so a
workflow asserts over many endpoints and names every one that failed. Only a bad
definition fails the method: a URL that is not http or https, or a `caFile` that
cannot be read.

## An endpoint

```sh
swamp model create @dataverket/http/endpoint www --global-arg url=https://www.example.org/
swamp model create @dataverket/http/endpoint registry-api --global-arg url=https://registry.example.org/v2/
swamp model create @dataverket/http/endpoint oidc \
  --global-arg url=https://id.example.org/.well-known/openid-configuration \
  --global-arg bodyContains=authorization_endpoint

swamp model method run www health
```

| Argument          | Default                  |                                                                                                   |
| ----------------- | ------------------------ | ------------------------------------------------------------------------------------------------- |
| `url`             |                          | The URL to GET, http or https                                                                     |
| `expectStatus`    | `200`                    | The status the final answer must have for `ok`                                                    |
| `followRedirects` | `true`                   | Follow redirects, at most `maxRedirects`, and judge the final answer; `false` judges the first    |
| `maxRedirects`    | `5`                      |                                                                                                   |
| `bodyContains`    |                          | Text the final answer's body must hold for `ok`; empty reads no body                              |
| `timeoutMs`       | `10000`                  | How long the whole request may take before the endpoint counts as unreachable                     |
| `caFile`          |                          | A CA certificate (PEM) the chain must verify against, absolute or relative to the repository root |
| `userAgent`       | `swamp @dataverket/http` |                                                                                                   |

The record:

| Field         | Meaning                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `reachable`   | An answer came back, whatever its status                                                                       |
| `status`      | The final answer's status, `null` when none came                                                               |
| `ok`          | Reachable, the status is `expectStatus`, and the body holds `bodyContains` when one is given                   |
| `tls`         | `verified` over HTTPS, `plain` over HTTP, `failed` when the chain did not verify, `null` when nothing answered |
| `latencyMs`   | From the first request to the final answer, redirects included                                                 |
| `redirects`   | How many were followed                                                                                         |
| `bodyMatched` | `true` or `false` when `bodyContains` was given, `null` otherwise                                              |
| `error`       | Why `ok` is false: the status, the body, the connection error, the chain, or the timeout                       |

A workflow asserts over the records; `@dataverket/platform-health` does, with
its `endpointModels` input, and names every endpoint that failed with its URL,
status, latency and error:

```yaml
- name: www-ok
  task:
    type: assert
    expr: >-
      data.latest("www", "health").attributes.ok == true
      && data.latest("www", "health").attributes.latencyMs <= 2000
    message: >-
      www failed: ${{ data.latest("www", "health").attributes.error }}
```

## What it does and does not do

- A plain GET with `Accept: */*` and the User-Agent; no credential, no cookie,
  no other header. An endpoint that needs a login is checked at a path that does
  not, such as a health or discovery document.
- The body is read only when `bodyContains` is given, so a large endpoint costs
  one request and no download.
- Redirects are followed by hand, so the count and the final URL are recorded; a
  chain longer than `maxRedirects` is judged at the last redirect, which is not
  `ok` unless `expectStatus` says so.
- TLS is verified against the system store, or against `caFile` alone when
  given, for a private CA. A chain that does not verify is recorded as
  `tls: failed` with the verifier's reason; nothing is ever accepted insecurely.

Two pre-flight checks come with the type: `arguments` (the URL is http or https,
no newline in `caFile` or `userAgent`) and `ca-readable` (`caFile`, when set,
reads and holds a certificate PEM). `health` is a read, so they run by hand with
`swamp model validate <name>`.

## Development

```sh
deno test --allow-env --allow-read --allow-net
HTTP_E2E=1 deno test --allow-env --allow-read --allow-net
```

The unit tests run the probe against a local server for every outcome: an
answer, a wrong status, a missing body text, redirects followed, capped and
refused, nothing listening, an answer slower than the timeout, and a chain that
does not verify. With `HTTP_E2E=1` one test checks `HTTP_E2E_URL` (default
`https://example.org/`) over a verified chain and sees `self-signed.badssl.com`
recorded as `tls: failed`.

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Jan Ivar Beddari.
