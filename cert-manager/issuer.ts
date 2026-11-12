/**
 * `@dataverket/cert-manager/issuer`: cert-manager Issuer and ClusterIssuer
 * objects, read with kubectl. `list` records every issuer of both kinds with
 * its type, its Ready condition and, for ACME, the directory URL, plus one
 * inventory of what it saw; `get` records one. No credential an issuer refers
 * to is read.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import {
  assertDistinctDataNames,
  buildInventory,
  checkName,
  inventoryName,
  kubectlCliCheck,
  KubectlGlobalArgsSchema,
  listNamespace,
  requireNamespace,
} from "../lib/kubectl.ts";
import {
  type MethodContext,
  NameSchema,
  NamespaceSchema,
  RESOURCES,
  StateInventorySchema,
} from "./_helpers.ts";
import { type MethodResult, readList, readOne } from "./_methods.ts";
import {
  ISSUER_KINDS,
  type IssuerData,
  issuerDataName,
  issuerItem,
  type IssuerKind,
  IssuerSchema,
  parseIssuer,
} from "./_records.ts";

export { issuerDataName };

/** Swamp model for cert-manager Issuer and ClusterIssuer objects. */
export const model = {
  type: "@dataverket/cert-manager/issuer",
  version: "2026.11.12.1",
  globalArguments: KubectlGlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.11.12.1",
      description:
        "unit tests in the swamp skill's pattern; the bundled lib/ adds a 64 MiB output limit per command (a larger output is refused as too-large); global arguments unchanged",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
  ],
  checks: {
    "kubectl-cli-available": kubectlCliCheck,
  },
  resources: {
    issuer: {
      description:
        "Issuer or ClusterIssuer state: its type, the Ready condition and the ACME directory URL",
      schema: IssuerSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    inventory: {
      description:
        "What one list run saw: every issuer in scope with its state, and how many are not healthy",
      schema: StateInventorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    /** List ClusterIssuers and the Issuers of one namespace or all. */
    list: {
      description:
        "List cert-manager ClusterIssuer and Issuer objects and record each with its Ready state, plus one inventory of the run when both kinds are listed",
      arguments: z.object({
        namespace: NamespaceSchema.optional().describe(
          "Namespace whose Issuers to list. Defaults to the definition's; empty there means all namespaces. ClusterIssuers are always listed.",
        ),
        kind: z.enum(ISSUER_KINDS).optional().describe(
          "Restrict to one kind. Omit to list both. A list of one kind records the issuers and no inventory.",
        ),
      }),
      execute: async (
        args: { namespace?: string; kind?: IssuerKind },
        context: MethodContext,
      ): Promise<MethodResult> => {
        const ns = listNamespace(args.namespace, context.globalArgs.namespace);
        const kinds = args.kind ? [args.kind] : [...ISSUER_KINDS];
        context.logger.info("Listing {kinds} in {namespace}", {
          kinds: kinds.join(","),
          namespace: ns || "all namespaces",
        });
        const now = new Date();
        const records: IssuerData[] = [];
        for (const kind of kinds) {
          const items = kind === "ClusterIssuer"
            ? await readList(RESOURCES.clusterIssuer, kind, null, context)
            : await readList(RESOURCES.issuer, kind, ns, context);
          records.push(...items.map((item) => parseIssuer(item, kind, now)));
        }
        // ClusterIssuer names are unique; two Issuers in different
        // namespaces can reduce to one data name.
        assertDistinctDataNames(
          "Issuer",
          records.filter((r) => r.kind === "Issuer"),
        );
        const inventory = buildInventory(
          ns,
          records.map(issuerItem),
          now.toISOString(),
        );
        const handles: unknown[] = [];
        for (const record of records) {
          handles.push(
            await context.writeResource(
              "issuer",
              issuerDataName(record),
              record,
            ),
          );
        }
        // A list narrowed to one kind is not what the inventory of that
        // name says it is, and would replace the full one: it writes none.
        if (!args.kind) {
          handles.push(
            await context.writeResource(
              "inventory",
              inventoryName(ns),
              inventory,
            ),
          );
        }
        context.logger.info("Found {count} issuers, {unhealthy} not ready", {
          count: String(inventory.count),
          unhealthy: String(inventory.unhealthyCount),
        });
        return { dataHandles: handles };
      },
    },

    /** Read one Issuer or ClusterIssuer. */
    get: {
      description:
        "Read one cert-manager Issuer or ClusterIssuer and record its Ready state",
      arguments: z.object({
        name: NameSchema.describe("Issuer name"),
        kind: z.enum(ISSUER_KINDS).default("Issuer").describe(
          "Issuer or ClusterIssuer",
        ),
        namespace: NamespaceSchema.optional().describe(
          "Namespace of an Issuer. Defaults to the definition's. Not used for a ClusterIssuer.",
        ),
      }),
      execute: async (
        args: { name: string; kind?: IssuerKind; namespace?: string },
        context: MethodContext,
      ): Promise<MethodResult> => {
        const kind = args.kind ?? "Issuer";
        const name = checkName(args.name, `${kind} name`);
        context.logger.info("Reading {kind} {name}", { kind, name });
        const item = kind === "ClusterIssuer"
          ? await readOne(RESOURCES.clusterIssuer, kind, name, null, context)
          : await readOne(
            RESOURCES.issuer,
            kind,
            name,
            requireNamespace(
              "get",
              args.namespace,
              context.globalArgs.namespace,
            ),
            context,
          );
        const record = parseIssuer(item, kind, new Date());
        const handle = await context.writeResource(
          "issuer",
          issuerDataName(record),
          record,
        );
        context.logger.info("{kind} {name}: ready={ready}", {
          kind,
          name,
          ready: String(record.ready),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
