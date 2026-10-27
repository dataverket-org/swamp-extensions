# @dataverket/kind

One named [kind](https://kind.sigs.k8s.io) cluster, created on demand for
end-to-end tests. One model type, `@dataverket/kind/cluster`.

- `ensure` creates the cluster from `configPath` when `kind get clusters` does
  not list it, checks that its API server answers, applies `manifests` with
  `kubectl apply -f`, and records the cluster.
- `get` records whether the cluster exists, without creating it.
- `delete` deletes the cluster, and succeeds when it is already gone.

| Argument        | Default   |                                               |
| --------------- | --------- | --------------------------------------------- |
| `clusterName`   |           | kind cluster name                             |
| `configPath`    |           | kind config, absolute or relative to the repo |
| `manifests`     | `[]`      | applied after the cluster is up, in order     |
| `waitTimeout`   | `120s`    | how long kind waits for the control plane     |
| `kindBinary`    | `kind`    |                                               |
| `kubectlBinary` | `kubectl` |                                               |

The `cluster` record carries `context` (`kind-<clusterName>`) and `apiServer`,
for other models to reference:

```yaml
kubeContext: ${{ data.latest("kind", "cluster").attributes.context }}
```

## Commands

The model runs `kind get clusters`, `kind create cluster`,
`kind delete
cluster`, `kubectl config view`, `kubectl get --raw /readyz` and
`kubectl apply
-f` as subprocesses in the repository root, with arguments as
argv arrays, never through a shell.

## As a workload issuer for Salmon

To exchange this cluster's ServiceAccount tokens at a Salmon from
`@dataverket/salmon`, which runs in a container, name the issuer after the
control-plane container in the kind config, as that package's README shows.

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Linus Johansen.
