# @dataverket/http

One HTTP or HTTPS endpoint, asked whether it answers, as swamp data. One model
type, `@dataverket/http/endpoint`, one URL, one method, `health`, read-only.

| Method   | Does                                                     | Records                                                                                                                                                      |
| -------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `health` | GETs the URL, follows redirects, reads the body if asked | `health`: final URL, reachable, status, ok, TLS verified or not, latency, redirects, body text match, JSON field match and the fields that differ, the error |

An endpoint that is down, slow, wrong or serving a chain that does not verify is
a record with `ok: false` and the reason in `error`, never a failed method, so a
workflow asserts over many endpoints and names every one that failed. Only a bad
definition fails the method: a URL that is not http or https, a `caFile` that
cannot be read, or a `bodyJson` that holds something other than JSON values.

## An endpoint

```sh
swamp model create @dataverket/http/endpoint www --global-arg url=https://www.example.org/
swamp model create @dataverket/http/endpoint registry-api --global-arg url=https://registry.example.org/v2/
swamp model create @dataverket/http/endpoint oidc \
  --global-arg url=https://id.example.org/.well-known/openid-configuration \
  --global-arg 'bodyJson:json={"issuer":"https://id.example.org"}'

swamp model method run www health
```

| Argument             | Default                  |                                                                                                                             |
| -------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `url`                |                          | The URL to GET, http or https                                                                                               |
| `expectStatus`       | `200`                    | The status the final answer must have for `ok`                                                                              |
| `followRedirects`    | `true`                   | Follow redirects, at most `maxRedirects`, and judge the final answer; `false` judges the first                              |
| `maxRedirects`       | `5`                      |                                                                                                                             |
| `bodyContains`       |                          | Text the final answer's body must hold for `ok`; empty reads no body                                                        |
| `bodyJson`           | `{}`                     | Fields the final answer's JSON body must hold with exactly these values for `ok`; empty checks nothing                      |
| `bodyJsonShowValues` | `false`                  | Record the expected and the actual value of a field that differs; `false` records the field and the kind of difference only |
| `timeoutMs`          | `10000`                  | How long the whole request may take before the endpoint counts as unreachable                                               |
| `caFile`             |                          | A CA certificate (PEM) the chain must verify against, absolute or relative to the repository root                           |
| `userAgent`          | `swamp @dataverket/http` |                                                                                                                             |

The record:

| Field               | Meaning                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `reachable`         | An answer came back, whatever its status                                                                                                  |
| `status`            | The final answer's status, `null` when none came                                                                                          |
| `ok`                | Reachable, the status is `expectStatus`, the body holds `bodyContains` when one is given, and its JSON holds `bodyJson` when one is given |
| `tls`               | `verified` over HTTPS, `plain` over HTTP, `failed` when the chain did not verify, `null` when nothing answered                            |
| `latencyMs`         | From the first request to the final answer, redirects included                                                                            |
| `redirects`         | How many were followed                                                                                                                    |
| `bodyMatched`       | `true` or `false` when `bodyContains` was given, `null` otherwise                                                                         |
| `jsonMatched`       | `true` or `false` when `bodyJson` was given, `null` otherwise and when nothing answered                                                   |
| `jsonMismatches`    | The fields that differ, at most 20: `path`, `reason`, `expectedType`, `actualType`, and `expected` and `actual` when `bodyJsonShowValues` |
| `jsonMismatchCount` | How many fields differ; more than `jsonMismatches` holds when the list was cut                                                            |
| `error`             | Why `ok` is false, the first of: the status, the body text, the JSON field, or the connection error, the chain, the timeout               |

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

## An exact JSON field: `bodyJson`

`bodyContains` is a substring match, and a substring also matches a longer
value: `https://id.example.org` is found in a document whose issuer is
`https://id.example.org.attacker.example`. `bodyJson` names fields and the
values they must have, exactly:

```yaml
globalArguments:
  url: https://id.example.org/.well-known/openid-configuration
  bodyJson:
    issuer: https://id.example.org
    scopes_supported: [openid, profile, email]
    limits:
      max_age: 3600
```

How it compares:

- **Nested fields are a nested object.** `bodyJson` has the shape of the body it
  describes, and an object is compared as a subset: every field named must be
  there, fields not named are ignored, at every level. Dotted paths were the
  other choice and were not taken: a JSON key may itself hold a dot or a slash,
  so `a.b` would be two things at once, and the nested form is what a definition
  in YAML already is.
- **Every other value is exact and typed.** The string `"1"` is not the number
  `1`, `null` is not `false`, `0` is not `false`, and a field that is `null` is
  not a missing field. Numbers are equal when they are the same number, so `1`,
  `1.0` and `1e0` are one value; integers past 2^53 lose precision as they do in
  any JSON number.
- **An array is equal as a whole**: same length, same order, and an object
  inside an array must have exactly the same fields. Nothing in an array is
  ignored.
- `{}` for a nested field asks only that the field is an object.

On the command line give the whole object with `bodyJson:json=`, which keeps the
types. The dotted form `--global-arg bodyJson.count=3` stores the text `"3"`,
which is not the number `3`.

A field that differs is named by its JSON Pointer (RFC 6901), `/issuer` or
`/limits/max_age`, with a reason:

| Reason          | Path  | Meaning                                                                      |
| --------------- | ----- | ---------------------------------------------------------------------------- |
| `missing`       | field | The body does not have the field                                             |
| `type`          | field | Another kind of value: `expectedType` and `actualType` say which             |
| `value`         | field | The same kind, another value                                                 |
| `content-type`  | `""`  | The answer is not `application/json` or a `+json` type; the body is not read |
| `too-large`     | `""`  | The body is larger than 1 MiB; reading stops there                           |
| `not-utf8`      | `""`  | The body is not valid UTF-8                                                  |
| `too-deep`      | `""`  | Objects and arrays nested deeper than 64 levels                              |
| `not-json`      | `""`  | The body does not parse as JSON, an empty body included                      |
| `duplicate-key` | `""`  | Some object in the body holds a key twice, so its value is not one value     |
| `not-object`    | `""`  | The body is an array, a text, a number, `true`, `false` or `null`            |

All of these are a record with `ok: false`, `jsonMatched: false` and the reason
in `jsonMismatches` and in `error`, never a failed method. A body that breaks
off before its end, or is slower than `timeoutMs`, is an endpoint that did not
answer: `reachable: false` and `jsonMatched: null`, as for `bodyContains`.

What the record holds of the body is nothing, unless you ask. An endpoint that
is wrong may answer with anything, a session, an error page with a stack trace,
and a record is kept and read by others. By default a mismatch says which field
and what kind of difference. With `bodyJsonShowValues: true` it also holds
`expected` and `actual` as JSON text, each cut at 200 characters, and `error`
quotes them; turn it on for a field you know is public, such as an issuer, and
never when `bodyJson` itself holds a value that is not public:

```json
{
  "path": "/issuer",
  "reason": "value",
  "expectedType": "string",
  "actualType": "string",
  "expected": "\"https://id.example.org\"",
  "actual": "\"https://id.example.org.attacker.example\""
}
```

Two more rules, both on the side of refusing:

- A body that holds a key twice anywhere is `duplicate-key`, whichever value
  comes last, because parsers do not agree on which one counts.
- A field named `__proto__` cannot be asserted: a definition that names one is
  refused, at every depth. `constructor`, `toString` and other names every
  object inherits are fields like any other and `missing` unless the body really
  holds them.

`bodyJson` and `bodyContains` may both be set. The body is read once and both
must hold. With `bodyContains` the whole body is read, as it always was, and a
body past 1 MiB is still `too-large` for `bodyJson`.

## What it does and does not do

- A plain GET with `Accept: */*` and the User-Agent; no credential, no cookie,
  no other header. An endpoint that needs a login is checked at a path that does
  not, such as a health or discovery document.
- The body is read only when `bodyContains` or `bodyJson` is given, so a large
  endpoint costs one request and no download; for `bodyJson` alone at most 1 MiB
  is read, and nothing when the content type is not JSON.
- Redirects are followed by hand, so the count and the final URL are recorded; a
  chain longer than `maxRedirects` is judged at the last redirect, which is not
  `ok` unless `expectStatus` says so.
- TLS is verified against the system store, or against `caFile` alone when
  given, for a private CA. A chain that does not verify is recorded as
  `tls: failed` with the verifier's reason; nothing is ever accepted insecurely.

Two pre-flight checks come with the type: `arguments` (the URL is http or https,
no newline in `caFile` or `userAgent`, `bodyJson` holds JSON values only, at
most 32 levels deep) and `ca-readable` (`caFile`, when set, reads and holds a
certificate PEM). `health` is a read, so they run by hand with
`swamp model validate <name>`.

## Development

```sh
deno test --allow-env --allow-read --allow-net
HTTP_E2E=1 deno test --allow-env --allow-read --allow-net
```

The unit tests run the probe against a local server for every outcome: an
answer, a wrong status, a missing body text, redirects followed, capped and
refused, nothing listening, an answer slower than the timeout, and a chain that
does not verify. `endpoint_json_test.ts` does the same for `bodyJson` against a
server that refuses anything but the plain GET the type promises, and spends
most of its tests on what must not pass. [smoke/](./smoke/) holds the same as
live runs through swamp. With `HTTP_E2E=1` one test checks `HTTP_E2E_URL`
(default `https://example.org/`) over a verified chain and sees
`self-signed.badssl.com` recorded as `tls: failed`.

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Jan Ivar Beddari.
