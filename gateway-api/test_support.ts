/**
 * Test support for this extension: a fake cluster answered through the
 * shared strict fake kubectl of `../lib/kubectl_fake.ts` (which checks the
 * grammar of every call), a method context that records what a run leaves
 * behind, and the fixtures.
 *
 * @module
 */
import {
  type Answer,
  type FakeKubectl,
  type KubectlCall,
  list,
  SAID,
  withKubectl,
} from "../lib/kubectl_fake.ts";
import type { FakeTime } from "../lib/cli_fake.ts";

const GROUP = "gateway.networking.k8s.io";

/** What the fake cluster holds and how it misbehaves. */
export interface FakeCluster {
  /** Objects by resource (`gateways`, `httproutes`, `gatewayclasses`). */
  objects?: Record<string, Record<string, unknown>[]>;
  /** Resources the API server does not serve (CRD not installed). */
  missingResources?: string[];
  /** Answer every request with this stderr and a failure. */
  failWith?: string;
  /** What a failed request prints on standard output all the same. */
  failStdout?: string;
  /** Print this instead of the answer, with success. */
  stdoutOverride?: string;
  /** Never answer: the runner's time limit ends the call. */
  hang?: boolean;
  /** The binary is not on PATH. */
  noBinary?: boolean;
  /** The kubeconfig every call must carry; none when left out. */
  kubeconfig?: string;
  /** The context every call must carry; none when left out. */
  context?: string;
}

const NAMESPACED = new Set(["gateways", "httproutes"]);
const KNOWN = new Set(["gateways", "httproutes", "gatewayclasses"]);

/** What the fake cluster answers to one call that passed the grammar. */
function answerFrom(cluster: FakeCluster, call: KubectlCall): Answer {
  if (cluster.noBinary) return { notInstalled: true };
  if (call.verb !== "get") {
    throw new Error(`this extension only reads: ${call.command.join(" ")}`);
  }
  if (cluster.hang) return { hang: true };
  if (cluster.failWith !== undefined) {
    return { fail: cluster.failWith, stdout: cluster.failStdout };
  }
  if (cluster.stdoutOverride !== undefined) {
    return { out: cluster.stdoutOverride };
  }
  const resource = call.resource ?? "";
  const [plural, ...groupParts] = resource.split(".");
  if (
    groupParts.join(".") !== GROUP || !KNOWN.has(plural) ||
    (cluster.missingResources ?? []).includes(plural)
  ) {
    return { fail: SAID.missingCrd(plural) };
  }
  const namespaced = NAMESPACED.has(plural);
  const inScope = (cluster.objects?.[plural] ?? []).filter((o) => {
    const meta = (o.metadata ?? {}) as Record<string, unknown>;
    return !namespaced || call.allNamespaces ||
      meta.namespace === call.namespace;
  });
  if (call.name !== undefined) {
    const found = inScope.find((o) =>
      (o.metadata as Record<string, unknown>).name === call.name
    );
    return found
      ? { out: found }
      : { fail: SAID.notFound(resource, call.name) };
  }
  return { out: list(inScope) };
}

/**
 * Run `body` against a fake cluster. Every call goes through the shared
 * fake's grammar first: the cluster flags of this cluster, the request
 * timeout, a known verb and flags, names that are Kubernetes names, a
 * namespaced resource never without `-n` or `-A`, and `-o json`.
 */
export function withCluster<T>(
  cluster: FakeCluster,
  body: (k: FakeKubectl & FakeTime) => Promise<T>,
): Promise<T> {
  return withKubectl({
    kubeconfig: cluster.kubeconfig,
    context: cluster.context,
    clusterScoped: [`gatewayclasses.${GROUP}`],
    handler: (call) => answerFrom(cluster, call),
  }, body);
}

/** A method context that records writes and log lines. */
export function ctx(
  globalArgs: {
    namespace?: string;
    context?: string;
    kubeconfig?: string;
  } = {},
) {
  const abort = new AbortController();
  const written: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const render = (m: string, p?: Record<string, unknown>) =>
    `${m} ${JSON.stringify(p ?? {})}`;
  return {
    written,
    logs,
    warnings,
    /** Cancel the run, as swamp does when the method is stopped. */
    cancel: () => abort.abort(),
    /** Everything a run left behind, as one text to search for leaks. */
    everything: () => JSON.stringify({ written, logs, warnings }),
    context: {
      globalArgs,
      signal: abort.signal,
      logger: {
        info: (m: string, p?: Record<string, unknown>) =>
          logs.push(render(m, p)),
        warning: (m: string, p?: Record<string, unknown>) =>
          warnings.push(render(m, p)),
      },
      writeResource: (
        spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        written.push({ spec, name, data });
        return Promise.resolve({ spec, name });
      },
    },
  };
}

/** A condition as a controller writes it. */
export function cond(
  type: string,
  status: string,
  reason: string,
  message = "",
  observedGeneration = 1,
) {
  return {
    type,
    status,
    reason,
    message,
    observedGeneration,
    lastTransitionTime: "2026-11-10T08:00:00Z",
  };
}

/** A healthy Gateway with one HTTPS listener and one attached route. */
export function healthyGateway(): Record<string, unknown> {
  return {
    apiVersion: `${GROUP}/v1`,
    kind: "Gateway",
    metadata: {
      name: "edge",
      namespace: "infra",
      generation: 1,
      annotations: {
        "kubectl.kubernetes.io/last-applied-configuration":
          '{"password":"ANNOTATION-SECRET-VALUE"}',
      },
    },
    spec: {
      gatewayClassName: "example",
      addresses: [{ type: "IPAddress", value: "192.0.2.10" }],
      listeners: [{
        name: "https",
        hostname: "*.example.org",
        port: 443,
        protocol: "HTTPS",
        tls: {
          mode: "Terminate",
          certificateRefs: [{ group: "", kind: "Secret", name: "wildcard" }],
        },
        allowedRoutes: {
          namespaces: {
            from: "Selector",
            selector: { matchLabels: { "routes": "allowed" } },
          },
        },
      }],
    },
    status: {
      addresses: [{ type: "IPAddress", value: "192.0.2.10" }],
      conditions: [
        cond("Accepted", "True", "Accepted"),
        cond("Programmed", "True", "Programmed"),
      ],
      listeners: [{
        name: "https",
        attachedRoutes: 1,
        supportedKinds: [
          { group: GROUP, kind: "HTTPRoute" },
          { group: GROUP, kind: "GRPCRoute" },
        ],
        conditions: [
          cond("Programmed", "True", "Programmed"),
          cond("Accepted", "True", "Accepted"),
          cond("ResolvedRefs", "True", "ResolvedRefs"),
        ],
      }],
    },
  };
}

/** A healthy HTTPRoute attached to the healthy Gateway. */
export function healthyRoute(): Record<string, unknown> {
  return {
    apiVersion: `${GROUP}/v1`,
    kind: "HTTPRoute",
    metadata: { name: "app", namespace: "apps", generation: 2 },
    spec: {
      hostnames: ["app.example.org"],
      parentRefs: [{
        group: GROUP,
        kind: "Gateway",
        name: "edge",
        namespace: "infra",
        sectionName: "https",
      }],
      rules: [{
        matches: [{
          path: { type: "PathPrefix", value: "/api" },
          method: "GET",
          headers: [{ name: "x-a", value: "1" }],
        }],
        filters: [{ type: "RequestHeaderModifier" }],
        backendRefs: [{
          group: "",
          kind: "Service",
          name: "app",
          port: 8080,
          weight: 1,
        }],
      }],
    },
    status: {
      parents: [{
        controllerName: "example.org/gateway-controller",
        parentRef: {
          group: GROUP,
          kind: "Gateway",
          name: "edge",
          namespace: "infra",
          sectionName: "https",
        },
        conditions: [
          cond("Accepted", "True", "Accepted", "", 2),
          cond("ResolvedRefs", "True", "ResolvedRefs", "", 2),
        ],
      }],
    },
  };
}

/** An accepted GatewayClass. */
export function acceptedClass(): Record<string, unknown> {
  return {
    apiVersion: `${GROUP}/v1`,
    kind: "GatewayClass",
    metadata: { name: "example", generation: 1 },
    spec: {
      controllerName: "example.org/gateway-controller",
      parametersRef: {
        group: "example.org",
        kind: "Config",
        name: "default",
        namespace: "infra",
      },
    },
    status: {
      conditions: [cond("Accepted", "True", "Accepted")],
      supportedFeatures: [{ name: "Gateway" }, { name: "HTTPRoute" }],
    },
  };
}
