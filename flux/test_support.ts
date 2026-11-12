/**
 * What the tests of this extension share: a HelmRelease as kubectl prints it,
 * as input to the parsers.
 *
 * @module
 */

/** The full resource names the types read. */
export const HR = "helmreleases.helm.toolkit.fluxcd.io";

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
