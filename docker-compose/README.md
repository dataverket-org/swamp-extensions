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

## Commands

`docker compose -f <composeFile> --project-directory <dir> [--profile <p>]...
ps|up|down`,
run in the project directory with arguments as argv arrays, never through a
shell.
