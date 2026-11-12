/**
 * Test support for this extension: conditions and objects as a controller
 * writes them, for the parsers to read.
 *
 * @module
 */
const GROUP = "gateway.networking.k8s.io";

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
