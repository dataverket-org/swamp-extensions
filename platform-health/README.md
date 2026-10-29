# @dataverket/platform-health

One [swamp](https://github.com/swamp-club/swamp) workflow,
`@dataverket/platform-health`, that checks the forges, S3 gateways and HTTP
endpoints a repository names and fails when one of them is down. It reads and asserts,
nothing more, and takes a few seconds, so it is made to be run often: by hand
as the morning check, on a schedule, or as the first step of a larger workflow.

## What a run does

| Job        | Does                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| `forges`   | `health` on every `@dataverket/forgejo` model named: server version and `/api/healthz`, as its `status`   |
| `gateways` | `health` on every `@dataverket/versitygw/gateway` model named: an unsigned GET of the health path, as its `health` |
| `endpoints` | `health` on every `@dataverket/http/endpoint` model named: a plain GET, redirects followed, as its `health`     |
| `verify`   | One assertion per model: a forge must answer healthy, a gateway must be reachable without error, an endpoint must be ok, and either within `maxLatencyMs` when set |

What it will not do:

- **Write to any service.** All three health methods are GETs. A forge is
  asked with the model's token, a gateway is asked unsigned on its S3 port, an
  endpoint with no credential at all; the admin API is never touched.
- **Carry a URL, a token or a CA file.** The models are yours and are named by
  name. What they hold stays in your definitions, and the workflow's inputs,
  which swamp records in cleartext in the run history, are only names and one
  number.
- **Create a model.** Unlike workflows that bring their own, this one runs
  against models that already exist. A name that does not exist fails the run
  at that step.

## Inputs

| Input           | Required | Default | Meaning                                                                        |
| --------------- | -------- | ------- | ------------------------------------------------------------------------------ |
| `forgeModels`   | no       | `[]`    | Names of `@dataverket/forgejo` models to check                                 |
| `gatewayModels` | no       | `[]`    | Names of `@dataverket/versitygw/gateway` models to check                       |
| `endpointModels`| no       | `[]`    | Names of `@dataverket/http/endpoint` models to check                           |
| `maxLatencyMs`  | no       | `0`     | Fail a gateway or endpoint slower than this many milliseconds; `0` checks reachability only |

The three lists default to empty so that a repository with only some of them
can use it; a run with all three empty checks nothing and succeeds.

## Use

```sh
swamp extension pull @dataverket/platform-health

swamp workflow run @dataverket/platform-health \
  --input 'forgeModels:json=["forgejo"]' \
  --input 'gatewayModels:json=["site-s3"]' \
  --input 'endpointModels:json=["www","registry-api"]'
```

Keep your own names in your repository, as a small workflow that calls this
one, so the check runs by one name and the script or schedule that runs it
never carries the list:

```yaml
jobs:
  - name: check
    steps:
      - name: platform
        task:
          type: workflow
          workflowIdOrName: "@dataverket/platform-health"
          inputs:
            forgeModels: [forgejo, codeberg]
            gatewayModels: [site-s3, backup-s3]
            endpointModels: [www, forum, registry-api]
            maxLatencyMs: 2000
```

Under `swamp serve` the same values can go in a trigger override instead:
`swamp workflow trigger set @dataverket/platform-health --schedule "*/15 * * * *"
--input 'forgeModels:json=["forgejo"]' ...`.

## What gets recorded

Nothing new. Each forge's `status` record and each gateway's and endpoint's
`health` record are the same ones the models' own `health` methods write, now
with a new version per run, so their history is the uptime log:

```sh
swamp data query 'modelName == "forgejo" && name == "status"' --json
swamp data query 'modelName == "site-s3" && name == "health"' --json
swamp data query 'modelName == "www" && name == "health"' --json
```

A failed assertion names the model and, for a gateway or an endpoint, the URL,
HTTP status, latency, TLS outcome and error it saw.

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Jan Ivar Beddari.
