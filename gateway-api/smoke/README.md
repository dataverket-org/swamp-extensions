# Live suite

What the unit tests cannot say: that a real kubectl, a real API server and a
real Gateway API controller agree with the parser. It runs against a throwaway
kind cluster and spends most of its effort on what is not healthy and on what
must be refused.

The scripts never read the default kubeconfig. They take the cluster as
`SMOKE_KUBECONFIG` (a file) and `SMOKE_CONTEXT` (default `kind-dvgw`), pass both
to every command, and refuse a context that is not a kind cluster.

## Run it

```sh
# 1. a cluster with its own kubeconfig file, and a scratch swamp repository
export WORK=$(mktemp -d) SMOKE_KUBECONFIG=$WORK/kubeconfig REPO=$WORK/repo
export KIND_EXPERIMENTAL_PROVIDER=podman
kind create cluster --name dvgw --kubeconfig "$SMOKE_KUBECONFIG" --wait 90s
mkdir "$REPO" && (cd "$REPO" && swamp repo init --tool none &&
  swamp extension source add "$OLDPWD/..")
./models.sh

# 2. before anything is installed: the Gateway API is absent
./a-no-crds.sh

# 3. an old install that serves v1beta1 only, then away again
./cluster.sh old-crds && ./b-old-version.sh && ./cluster.sh no-crds

# 4. the pinned Gateway API, Envoy Gateway, and the objects to read
./cluster.sh crds && ./cluster.sh controller
./cluster.sh fixtures && ./cluster.sh settle
./cluster.sh rename && ./cluster.sh resection && ./cluster.sh written-status

# 5. the suite
./c-read.sh && ./d-refusals.sh && ./e-workflow.sh && ./f-cancel.sh

# 6. and away
kind delete cluster --name dvgw --kubeconfig "$SMOKE_KUBECONFIG"
```

No step waits longer than a few seconds at a time; `cluster.sh` polls. The
extension imports the shared modules in `../lib/` of this repository;
`swamp extension source add` on the extension directory finds them without
anything more.

The steps of part 4 run once each, in that order, on a new cluster: `fixtures`
applied a second time undoes what `rename` and `resection` did, and
`written-status` changes a route's generation each time it runs.

No run log is kept in the repository, and the scripts write none. Each batch
prints one `PASS` or `FAIL` line per check and its counts on standard output;
`$REPO/.out.json` and `$REPO/.err.txt` hold the output of the last swamp command
only. To keep a log, pipe a batch through `tee`.

## Environment

The suite was run on 2026-11-10 on Linux x86_64 with rootless Podman and kind's
Podman provider, and that is the only environment it is known to work in.

| Needs   | Run with       | For                                             |
| ------- | -------------- | ----------------------------------------------- |
| podman  | 4.9.3 rootless | the kind node, one container                    |
| kind    | 0.33.0         | the cluster (Kubernetes v1.37.0)                |
| kubectl | 1.37.2         | the scripts, and the extension itself           |
| helm    | 4.3.1          | Envoy Gateway's chart                           |
| openssl | 4.1.0          | a throwaway certificate for the HTTPS listeners |
| jq      | 1.8.2          | the assertions                                  |
| swamp   | 20261110       | the model methods and the workflow runs         |

- The cluster is made with
  `KIND_EXPERIMENTAL_PROVIDER=podman kind create cluster --name <name> --kubeconfig <file>`.
  kind calls its Podman provider experimental.
- The kubeconfig is always that explicit file. Every script takes it as
  `SMOKE_KUBECONFIG`, passes it and `SMOKE_CONTEXT` to every command, and
  refuses a context that is not `kind-*`. No script creates or deletes the
  cluster, and none reads or writes the default kubeconfig.
- What rootless means here: little, because the suite never connects to a
  Gateway. kind has no load balancer, so no Gateway gets a LoadBalancer address,
  and a rootless container cannot publish a port below 1024 on the host;
  `fixtures.yaml` gives the class a ClusterIP Service instead, which is the
  address the healthy Gateway reports. No case is unhealthy because of Podman:
  every unhealthy object is made so on purpose, as listed below.
- Size, as measured with `podman stats` every 8 seconds while the suite ran: the
  kind node, which holds the control plane, Envoy Gateway and one Envoy proxy,
  grew to 916 MB of memory. Its CPU figure, which Podman gives as the average
  since the container started, fell from 69 % of one core to 20 %. swamp and
  kubectl run on the host, outside the node, and kept about one more core busy
  while a batch ran. The whole run took about seven minutes, the cluster and the
  installs included; batch `d` is two of them. These figures are from a run of
  the same day that had one Gateway and three routes fewer.
- macOS: run on Linux x86_64; macOS on Apple silicon is expected to work with a
  Podman machine of at least 2 CPUs and 2 GiB, not yet run there.
- Docker (kind's default provider, without the environment variable) probably
  works, and is not tested.

## Versions

Pinned in `cluster.sh` and nowhere else: Gateway API v1.5.1 (standard channel,
from the upstream release), Envoy Gateway v1.8.2 (its OCI Helm chart, with the
chart's own CRDs only), and Gateway API v0.8.1 for the old install. Last run on
2026-11-10; the section above has the versions of the tools.

A Gateway needs an address to become Programmed, and kind has no load balancer.
`fixtures.yaml` gives the GatewayClass an EnvoyProxy with a ClusterIP Service,
which is an address, and merges every Gateway of the class into one proxy, so
the whole suite runs one Envoy pod.

## What each batch is for

| Batch | What it holds the extension to                                                                                                                                                                                                                                                            |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a`   | A cluster without the CRDs: every method of every type names the missing resource                                                                                                                                                                                                         |
| `b`   | Only v1beta1 served: read, version recorded, a warning logged; an object nobody manages is null and not healthy                                                                                                                                                                           |
| `c`   | The healthy Gateway and route in full; every unhealthy case with the controller's reason; the reports a controller keeps after a rename and after an edit of the route's parent; the written status cases; the pre-flight check through `swamp model validate`; the least RBAC that works |
| `d`   | Missing and empty names, names and namespaces shaped as flags or shell, objects not there, no rights, a bad token, a wrong context, no kubeconfig, a closed port, an address where nothing answers                                                                                        |
| `e`   | The README's workflow assertions pass on the healthy pair and fail, naming the reason, on a bad listener and a bad route                                                                                                                                                                  |
| `f`   | An interrupted `swamp model method run` ends as cancelled, its waiting kubectl is stopped, and no record is left                                                                                                                                                                          |

Counts of the last run: `a` 6, `b` 6, `c` 46, `d` 95, `e` 3, `f` 4; 160 checks,
none failed.

The cases of `fixtures.yaml` that Envoy Gateway itself reports on:

| Object                        | What the controller reports                                                                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway `bad-cert`            | listener ResolvedRefs False, `InvalidCertificateRef`; Gateway still Programmed True                                                                                  |
| Gateway `conflict`            | both listeners Conflicted True                                                                                                                                       |
| Gateway `unmanaged`           | nothing; the API server's `Pending` placeholders                                                                                                                     |
| HTTPRoute `missing-backend`   | ResolvedRefs False, `BackendNotFound`                                                                                                                                |
| HTTPRoute `ghost-parent`      | nothing: the parent does not exist                                                                                                                                   |
| HTTPRoute `wrong-host`        | Accepted False, `NoMatchingListenerHostname`                                                                                                                         |
| HTTPRoute `not-allowed`       | Accepted False, `NotAllowedByListeners`                                                                                                                              |
| HTTPRoute `renamed`           | after `cluster.sh rename`: Accepted True for the two listeners it names, and a report left for the old name, Accepted False `NoMatchingParent` at the old generation |
| HTTPRoute `section-added`     | after `cluster.sh resection`: Accepted True for the listener the route now names, and the report for the whole Gateway kept at the old generation                    |
| HTTPRoute `section-removed`   | after `cluster.sh resection`: Accepted True for the whole Gateway, and the report for the listener kept at the old generation                                        |
| GatewayClass `bad-parameters` | Accepted False, `InvalidParameters`                                                                                                                                  |
| GatewayClass `nobody`         | Accepted Unknown                                                                                                                                                     |

These three are made by the controller. For `renamed`, a listener of Gateway
`renamed` gets a new name while the route is attached to it, and the route then
follows; Envoy Gateway v1.8.2 keeps its refusal for the old name, which the
record files as `not-requested`. For the other two the route's own parent
reference is edited, one gets a listener name and one loses it; Envoy Gateway
keeps its report in the old form beside the new one, which the record files as
`superseded`. All three routes read healthy with one leftover report.

Envoy Gateway does not keep the status entry of a listener that was renamed:
`leftoverListenerReports` is 0 on Gateway `renamed`, and a count above 0 is
covered by unit tests only.

Five cases are status that Envoy Gateway does not produce. The step
`written-status` of `cluster.sh` writes them itself with
`kubectl patch --subresource=status`, on routes of the Gateway nobody manages
and on a class nobody manages, so no controller touches them. The API server
checks their shape; no controller made them, and that is all these cases show
beyond the unit tests:

| Object                             | The status written                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| HTTPRoute `other-form`             | the route names the Gateway without a listener; two reports, one per listener, one Accepted True and one False: healthy |
| HTTPRoute `all-refuse`             | the same, and both listeners refuse: not healthy, each refusal a finding                                                |
| HTTPRoute `partially-invalid`      | the route names a listener; the report leaves it out, and has PartiallyInvalid True                                     |
| HTTPRoute `two-controllers`        | two controllers on one parent, one at the route's generation and one at an older one                                    |
| GatewayClass `unsupported-version` | Accepted True, SupportedVersion False                                                                                   |

The second controller could not be put on a route Envoy Gateway manages: it
replaced the other controller's entry with a second copy of its own. Reports per
listener from a real controller, a stale report from a real controller that was
replaced, and a real SupportedVersion False are covered by unit tests and these
written cases only.

Envoy Gateway also writes a condition of its own on every route here,
`BackendsAvailable` False with `EndpointsNotFound`, because the `echo` Service
has no pods. It is kept in `conditions` and not judged.

Batches `c` and `d` end by searching everything swamp stored, and the last run's
output, for kubeconfig credentials, private keys and the tokens `models.sh`
made. `.work/` holds those tokens and the throwaway TLS key and is not
committed.
