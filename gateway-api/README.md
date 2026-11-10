# @dataverket/gateway-api

The Kubernetes [Gateway API](https://gateway-api.sigs.k8s.io/) read as swamp
data, through `kubectl`. Three model types, each with `list` and `get`, all
read-only: nothing on the cluster is created, changed or deleted.

| Type                                   | Reads        | A record holds                                                                                       |
| -------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| `@dataverket/gateway-api/gateway`      | Gateway      | class, addresses, Gateway conditions, every listener with its conditions, a summary                  |
| `@dataverket/gateway-api/httproute`    | HTTPRoute    | hostnames, parents, rules with matches and backends, what each controller said per parent, a summary |
| `@dataverket/gateway-api/gatewayclass` | GatewayClass | controller, parameters reference, supported features, its conditions, a summary                      |

A Gateway that is not programmed, a listener whose certificate does not resolve,
a route no parent accepts: each is a record that says so, with the controller's
own reason and message, never a failed method. A workflow asserts on the record.
Only a call that could not be made fails the method: no such object, no rights,
no cluster, no Gateway API.

It reads only the standard `gateway.networking.k8s.io` fields, so it is written
for any implementation that follows the API. It has been run against one: Envoy
Gateway v1.8.2 with Gateway API v1.5.1. Conditions an implementation adds of its
own are kept in `conditions` and not judged.

## Models

```sh
swamp model create @dataverket/gateway-api/gateway gateways \
  --global-arg context=my-cluster
swamp model create @dataverket/gateway-api/httproute routes \
  --global-arg context=my-cluster --global-arg namespace=shop
swamp model create @dataverket/gateway-api/gatewayclass classes \
  --global-arg context=my-cluster

swamp model method run gateways list
swamp model method run gateways get --input name=edge --input namespace=infra
swamp model method run routes list
swamp model method run routes get --input name=cart
swamp model method run classes list
```

| Global argument | Default                          |                                                                           |
| --------------- | -------------------------------- | ------------------------------------------------------------------------- |
| `namespace`     | empty                            | The namespace `list` reads and `get` defaults to; empty lists all of them |
| `kubeconfig`    | `KUBECONFIG` or `~/.kube/config` | Path to a kubeconfig file                                                 |
| `context`       | the current context              | Kubeconfig context                                                        |

`list` takes an optional `namespace` to read instead of the definition's; `get`
takes `name` and, for the two namespaced types, an optional `namespace`. A
`namespace` argument that is left out or empty means the definition's, so a
definition with a namespace always reads that one unless another is named. A
GatewayClass has no namespace and the argument is ignored there.

Every kubectl call asks the API server with a request timeout of 30 seconds, and
a kubectl that still runs after 35 seconds is stopped. Every call is given the
cancellation signal swamp passes to a method (`context.signal`), so a cancelled
run stops its kubectl: in the live suite an interrupted `swamp model method run`
ended as `cancelled` and its waiting kubectl was gone within 200 ms.

## Data names

| Record                    | Data name                                                        |
| ------------------------- | ---------------------------------------------------------------- |
| A Gateway or an HTTPRoute | `<namespace>--<name>`, as in `infra--edge`                       |
| A GatewayClass            | `<name>`                                                         |
| The inventory of a list   | `inventory_all`, or `inventory_ns_<namespace>` for one namespace |

A `list` writes one record per object and one inventory: `count`,
`healthyCount`, `unhealthyCount` and `allHealthy`, the `apiVersions` served,
every object in `items` (`namespace`, `name`, `dataName`, `healthy`, and
`reason`: one line when it is not healthy, null when it is), and the unhealthy
ones again in `unhealthy` with all their reasons as lines such as
`listener https: ResolvedRefs=False (InvalidCertificateRef)`. A record of an
object that was deleted from the cluster stays in the data; the inventory of the
latest list is what says which objects exist now.

A Kubernetes name cannot hold an underscore, so no object can take the name of
an inventory. Two objects can only share a data name when a namespace or a name
itself holds `--`: `b--c` in namespace `a` and `c` in namespace `a--b` are both
`a--b--c`. A `list` that sees such a pair refuses the whole list before it
writes anything, and says to list one namespace at a time. That refusal covers
one list only: if the two namespaces are then listed one after the other into
the same model, or read with `get`, the second record replaces the first. Use
one model per namespace for namespaces named like that.

## What healthy means

Every record has a `summary` with plain booleans, so an assertion needs no text
matching. A condition is `true`, `false`, or `null` when the controller did not
report it or reported `Unknown`.

Gateway:

| Field                      | Meaning                                                                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accepted`, `programmed`   | The Gateway's own conditions                                                                                                                                                       |
| `hasAddress`               | The controller bound at least one address                                                                                                                                          |
| `listenerCount`            | Listeners in the spec                                                                                                                                                              |
| `attachedRoutes`           | Routes attached, summed over the listeners                                                                                                                                         |
| `allListenersAccepted`     | Every listener has Accepted `True`                                                                                                                                                 |
| `allListenersProgrammed`   | Every listener has Programmed `True`                                                                                                                                               |
| `allListenersRefsResolved` | Every listener has ResolvedRefs `True`                                                                                                                                             |
| `anyListenerConflicted`    | A listener has Conflicted `True`                                                                                                                                                   |
| `leftoverListenerReports`  | Status entries for listeners the spec does not have (any more); counted, not judged                                                                                                |
| `statusCurrent`            | `false` when a condition was observed at an older generation than the object has now                                                                                               |
| `healthy`                  | Accepted and Programmed are `True`, the status is current, there is at least one listener, and every listener is accepted, programmed, with resolved references and not conflicted |
| `unhealthy`                | One entry per finding: `listener` (null for the Gateway), `condition`, `status`, `reason`, `message`                                                                               |

`hasAddress`, `listenerCount`, `attachedRoutes` and `leftoverListenerReports`
are facts and are not judged. Whether a Gateway without an address works is the
controller's call, and it makes that call in Programmed (the API's own reason
for it is `AddressNotAssigned`), so a Gateway that is accepted and programmed
with no address is recorded as healthy with `hasAddress: false`.

A Gateway can be Programmed `True` as a whole while one of its listeners is not,
which is why the listeners are judged one by one. Each listener in `listeners`
carries `name`, `hostname`, `port`, `protocol`, `tls` (mode and certificate
references by group, kind, name and namespace; never a certificate or a key),
`allowedRoutes`, `attachedRoutes`, `supportedKinds`, its four conditions as
`accepted`, `programmed`, `refsResolved` and `conflicted`, and the full
`conditions`.

HTTPRoute:

| Field                    | Meaning                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `parentCount`            | Parents the route asks for                                                                                                     |
| `reportedParentCount`    | Of those, how many at least one controller reported on                                                                         |
| `allParentsAccepted`     | Every parent asked for is reported, and every judged report has Accepted `True`                                                |
| `allRefsResolved`        | Every parent asked for is reported, and every judged report has ResolvedRefs `True`                                            |
| `partiallyInvalid`       | A judged report has PartiallyInvalid `True`: the controller dropped some of the rules                                          |
| `leftoverParentReports`  | Reports that are not about a parent the route names, or that a newer report of the same controller superseded; not judged      |
| `refusedListenerReports` | Reports of listeners that refused a route its parent, named without a listener, accepted on another listener; not findings     |
| `backendCount`           | Backend references over all rules                                                                                              |
| `statusCurrent`          | `false` when a judged report was observed at an older generation than the route has now                                        |
| `healthy`                | Accepted and resolved in every judged report, nothing partially invalid, every judged report current                           |
| `unhealthy`              | One entry per finding: `parent` (`namespace/name/listener:port`), `controllerName`, `condition`, `status`, `reason`, `message` |

`status.parents` holds one report per parent and controller, and each entry of
`parents` in the record is one of them, with `requested`, `judged`,
`notJudgedBecause`, `accepted`, `refsResolved`, `partiallyInvalid`, `current`
and the full `conditions`.

A report is about a parent the route asks for (`requested`) when it names the
same object (group, kind, namespace and name) and its listener and port do not
contradict the route's: each of the two is the same on both sides or left out on
one. So a parent the route names without a listener covers a report on any
listener of that Gateway, and a report that left the listener or the port out
still belongs to the parent that names them. A requested report is judged on its
own, whichever controller wrote it and in whatever form, and one report with
Accepted `False` is a finding even beside another that says `True`. Three kinds
of report are kept in `parents` and not judged; `notJudgedBecause` says which:

- `not-requested`: a report on another object, or on a listener or port the
  route does not name while it names another. Envoy Gateway v1.8.2 leaves one
  when a listener is renamed and the route follows: its refusal for the old
  listener name stays, at the old generation.
- `superseded`: a report for an older generation of the route, when the same
  controller has a report for the present generation on the same parent. This is
  what a controller keeps when the route's own parent reference is edited, for
  example when a listener name is added to it; Envoy Gateway v1.8.2 does.
- `another-listener-accepted`: the API's rule for a parent named without a
  listener, that the route is attached when at least one listener accepts it.
  When the route names the parent without a listener and a controller reports
  per listener, one of that controller's listener reports with Accepted `True`
  is enough; its listener reports that did not accept are counted in
  `refusedListenerReports` and are not findings.

The first two are counted in `leftoverParentReports`. The last rule is kept
narrow. It does not reach a report that names no listener, which is the
controller's verdict on the whole parent; a parent the route names with its
listener; reports for an older generation; or another controller, each of which
must accept on its own. ResolvedRefs has no such rule in the API (it says
whether the references of the route resolve), so every judged report must have
it `True`, the accepting listener's included.

Every finding names the parent, in the form the controller reported it, and the
controller. A parent that does not exist gets no report from anyone, so the
route is recorded with the reason `NotReported` for that parent and no
controller. A report for an older generation of the route that nothing
supersedes is a `StaleStatus` finding of its own, for that parent and that
controller: the controller has not reported on the route as it is now. One read
cannot tell why, and a controller that was replaced and never removed its report
leaves the route with that finding until the report is removed from
`status.parents`. The inventory's reason lines name the controller too, as in
`parent infra/edge/https (example.org/controller): Accepted=False (NotAllowedByListeners)`.

GatewayClass: `accepted`, `acceptedReason`, `acceptedMessage`,
`supportedVersion`, `statusCurrent`, `healthy`, and `unhealthy` with one entry
per finding (`condition`, `status`, `reason`, `message`). A class is healthy
when Accepted is `True`, the status is current, and SupportedVersion is not
`False`: a controller may accept a class on Gateway API CRDs of a version it
does not support and say so only there. A SupportedVersion that is missing or
`Unknown` is not a finding. A Gateway of a class that nobody accepted gets no
status, so the class is the first thing to read when a Gateway reports nothing.

## In a workflow

```yaml
jobs:
  - name: edge
    steps:
      - name: gateways
        task: { type: model_method, modelIdOrName: gateways, methodName: list }
      - name: routes
        task: { type: model_method, modelIdOrName: routes, methodName: list }
      - name: edge-programmed
        dependsOn: [{ step: gateways, condition: { type: succeeded } }]
        task:
          type: assert
          expr: >-
            data.latest("gateways", "infra--edge").attributes.summary.programmed == true
            && data.latest("gateways", "infra--edge").attributes.summary.allListenersProgrammed
          message: >-
            Gateway edge is not serving:
            ${{ data.latest("gateways", "infra--edge").attributes.summary.unhealthy }}
      - name: every-route-attached
        dependsOn: [{ step: routes, condition: { type: succeeded } }]
        task:
          type: assert
          expr: data.latest("routes", "inventory_ns_shop").attributes.allHealthy
          message: >-
            Routes not attached:
            ${{ data.latest("routes", "inventory_ns_shop").attributes.unhealthy }}
```

## What fails a method

| Failure                          | Kind            | The error says                                                                |
| -------------------------------- | --------------- | ----------------------------------------------------------------------------- |
| The Gateway API is not installed | `missing-crd`   | `the cluster does not serve gateways.gateway.networking.k8s.io`, per resource |
| `get` of an object not there     | `not-found`     | kubectl's sentence, which ends in `not found`                                 |
| No rights                        | `forbidden`     | `refused by RBAC`, and which verbs on which resource are needed               |
| Credentials expired or wrong     | `unauthorized`  | `the cluster did not accept the credentials of this context`                  |
| No connection                    | `unreachable`   | `the cluster could not be reached`, with kubectl's one sentence               |
| No answer in time                | `timeout`       | `no answer in time`, or `no answer within 35 seconds; kubectl was stopped`    |
| The run was cancelled            | `cancelled`     | `was cancelled`                                                               |
| No kubectl                       | `not-installed` | `kubectl is not on PATH`                                                      |
| Output that is not JSON          | `not-json`      | `did not print JSON`, with the size of the output and never its text          |
| An answer that is something else | `other`         | what came instead: not a list, another kind, another object                   |
| A name that is not a name        | (no kubectl)    | `not a Kubernetes object name`, before kubectl is run                         |

The kind is the `kind` field of the error, for code that builds on these types.
A message about a kubectl call starts with the command, as in
`kubectl get httproutes.gateway.networking.k8s.io -A failed:`, without the
kubeconfig path. Three messages do not: a missing binary
(`kubectl is not on PATH`), an answer that is not the object asked for
(`kubectl did not return Gateway infra/edge`), and a refused name or namespace,
for which no command exists yet. kubectl's own text is cut to one line, its
client log lines are dropped, and anything shaped like a token, a password or a
key is blanked before it reaches an error; the same is done to the message of a
condition before it is stored, because controllers copy error text from
elsewhere into it.

Names and namespaces are checked against what Kubernetes accepts before anything
is run, so a value shaped like a flag or a shell fragment never reaches kubectl.
Nothing fails half-way: a method that fails writes no record.

A cluster that serves these kinds at another version than `v1` (an old install
with only `v1beta1`) is read all the same; the record's `apiVersion` and the
inventory's `apiVersions` say which, and the run logs a warning.

## Prerequisites

`kubectl` on PATH, and an identity that may `get` and `list` the three
resources. This is all it needs:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: gateway-api-reader }
rules:
  - apiGroups: [gateway.networking.k8s.io]
    resources: [gateways, httproutes, gatewayclasses]
    verbs: [get, list]
```

No Secret is read: a listener's certificate is recorded as the reference the
Gateway holds, and whether it resolves is what the controller reports. No
credential is an argument; the kubeconfig is named by path and read by kubectl
alone.

One check, `kubectl-cli-available` (label `live`), proves the binary runs. swamp
runs checks before methods that change something and not before reads, so it
does not run before `list` or `get`; a missing kubectl shows there as the
`not-installed` failure. Run the check yourself with
`swamp model validate <name>`.

## Not covered

GRPCRoute, TLSRoute, TCPRoute, UDPRoute, ReferenceGrant, BackendTLSPolicy and
the policies an implementation adds of its own are not read in this version. A
listener's `attachedRoutes` counts routes of every kind, and `supportedKinds`
names them, so a TCPRoute on a listener is visible there as a number. Nothing is
written to the cluster by any method, and none is planned.

## Testing

`deno task test` runs the unit tests against a fake kubectl that is as strict as
the real one about what it is asked. The live suite in `smoke/` was run with
rootless Podman and kind (the Podman provider): a kind cluster, the upstream
Gateway API CRDs and Envoy Gateway, one object for every unhealthy case above,
the refusals and a cancelled run. A few shapes of status that Envoy Gateway does
not produce are written by the suite itself through the status subresource, and
are named as such there. `smoke/README.md` in the source repository says what it
needs and how to run it.

## License

AGPL-3.0-only. See [LICENSE.md](LICENSE.md).
