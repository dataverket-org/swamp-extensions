/**
 * What the tests of this extension share: a HelmRelease as kubectl prints it
 * and a method context that records writes and log lines. The strict fakes
 * of `flux` and `kubectl` are the shared ones, `../lib/kubectl_fake.ts`.
 *
 * @module
 */

/** The full resource names the types read. */
export const HR = "helmreleases.helm.toolkit.fluxcd.io";
export const KS = "kustomizations.kustomize.toolkit.fluxcd.io";

/** A HelmRelease as kubectl prints it, trimmed to what the parser reads. */
export const hrItem = {
  apiVersion: "helm.toolkit.fluxcd.io/v2",
  kind: "HelmRelease",
  metadata: { name: "kps", namespace: "monitoring" },
  spec: {
    chart: {
      spec: {
        chart: "kube-prometheus-stack",
        version: "65.x",
        sourceRef: { kind: "HelmRepository", name: "prom", namespace: "flux" },
      },
    },
  },
  status: {
    conditions: [{ type: "Ready", status: "True", reason: "Ok", message: "" }],
    history: [{
      chartVersion: "65.1.0",
      appVersion: "v0.77",
      status: "deployed",
    }],
    lastAttemptedRevision: "65.1.0",
    observedGeneration: 3,
  },
};

/** A Kustomization as kubectl prints it, trimmed to what the parser reads. */
export function ksItem(name: string, namespace: string) {
  return {
    apiVersion: "kustomize.toolkit.fluxcd.io/v1",
    kind: "Kustomization",
    metadata: { name, namespace },
    spec: {
      path: "./clusters/prod",
      prune: true,
      sourceRef: { kind: "GitRepository", name: "flux-system" },
    },
    status: { conditions: [{ type: "Ready", status: "True", reason: "Ok" }] },
  };
}

/** A method context that records writes and log lines. */
export function ctx(
  globalArgs: { namespace: string; context?: string; kubeconfig?: string },
  signal?: AbortSignal,
) {
  const written: Array<{ spec: string; name: string; data: unknown }> = [];
  const logs: string[] = [];
  return {
    written,
    logs,
    context: {
      globalArgs,
      signal,
      logger: { info: (m: string) => logs.push(m) },
      writeResource: (spec: string, name: string, data: unknown) => {
        written.push({ spec, name, data });
        return Promise.resolve({ name });
      },
    },
  };
}
