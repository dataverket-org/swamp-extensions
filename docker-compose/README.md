# @dataverket/docker-compose

Two methods added to
[`@smith/docker-compose`](https://swamp-club.com/extensions/@smith/docker-compose),
for setups that start and remove a compose stack from a workflow.

- `ensure --input services=[...]` starts the given services with
  `docker compose up -d --wait`, only when one of them is not running, or not
  healthy where the service has a healthcheck. Call it every time; it does
  nothing when the stack is already up.
- `teardown` runs `docker compose down --remove-orphans`, with `--volumes`
  unless `volumes: false`, and fails when docker compose does.

Both record the `state` resource the upstream type defines. They exist because
the upstream methods also write a resource named `latest`, which current swamp
reserves, so those methods fail after doing their work.

## Definition

The methods read the upstream type's arguments: the compose file, the profiles
to activate, and the project directory, which is the repository root unless set.

```yaml
# models/@smith/docker-compose/stack.yaml
type: "@smith/docker-compose"
name: stack
globalArguments:
  composeFile: e2e/compose.yaml
  profiles: [e2e]
```

Pull `@smith/docker-compose` and this extension, then run the methods against
the definition:

```sh
swamp extension pull @dataverket/docker-compose
swamp behavior run stack ensure --input 'services:json=["postgres","ldap"]'
swamp behavior run stack teardown                    # removes the volumes too
swamp behavior run stack teardown --input volumes:json=false
```

## In a workflow

`ensure` is safe as the first step of every run: a stack left up by the last run
is checked and kept, a missing or unhealthy service is started and waited for,
and `up --wait` fails the step when a service never gets healthy.

```yaml
steps:
  - name: stack
    task:
      type: behavior
      behavior: stack
      methodName: ensure
      inputs:
        services: [postgres, ldap]
  - name: test
    dependsOn: [{ step: stack, condition: { type: succeeded } }]
    task:
      type: behavior
      behavior: validator
      methodName: test
```

The `state` record lists every container of the project with its status and
health, as the upstream `ps` method writes it:

```yaml
healthy: ${{ data.latest("stack", "state").attributes.services[0].health }}
```

## Commands

`docker compose -f <composeFile> --project-directory <dir> [--profile <p>]...
ps|up|down`,
run in the project directory with arguments as argv arrays, never through a
shell. `ps --format json` is parsed as one object per line, or as one array
where an older Compose prints that.

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Linus Johansen.
