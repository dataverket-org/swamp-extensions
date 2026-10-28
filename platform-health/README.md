# @dataverket/platform-health

One [swamp](https://github.com/swamp-club/swamp) workflow,
`@dataverket/platform-health`, that checks the forges and S3 gateways a
repository names and fails when one of them is down. It reads and asserts,
nothing more, and takes a few seconds, so it is made to be run often: by hand
as the morning check, on a schedule, or as the first step of a larger workflow.

## What a run does

| Job        | Does                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| `forges`   | `health` on every `@dataverket/forgejo` model named: server version and `/api/healthz`, as its `status`   |
| `gateways` | `health` on every `@dataverket/versitygw/gateway` model named: an unsigned GET of the health path, as its `health` |
| `verify`   | One assertion per model: a forge must answer healthy, a gateway must be reachable without error, and within `maxLatencyMs` when set |

What it will not do:

- **Write to any service.** Both health methods are GETs. A forge is asked with
  the model's token, a gateway is asked unsigned on its S3 port; the admin API
  is never touched.
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
| `maxLatencyMs`  | no       | `0`     | Fail a gateway slower than this many milliseconds; `0` checks reachability only |

Both lists default to empty so that a repository with only forges, or only
gateways, can use it; a run with both empty checks nothing and succeeds.

## Use

```sh
swamp extension pull @dataverket/platform-health

swamp workflow run @dataverket/platform-health \
  --input 'forgeModels:json=["forgejo"]' \
  --input 'gatewayModels:json=["site-s3"]'
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
            maxLatencyMs: 2000
```

Under `swamp serve` the same values can go in a trigger override instead:
`swamp workflow trigger set @dataverket/platform-health --schedule "*/15 * * * *"
--input 'forgeModels:json=["forgejo"]' ...`.

## What gets recorded

Nothing new. Each forge's `status` record and each gateway's `health` record
are the same ones the models' own `health` methods write, now with a new
version per run, so their history is the uptime log:

```sh
swamp data query 'modelName == "forgejo" && name == "status"' --json
swamp data query 'modelName == "site-s3" && name == "health"' --json
```

A failed assertion names the model and, for a gateway, the URL, HTTP status,
latency and error it saw.

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Jan Ivar Beddari.
