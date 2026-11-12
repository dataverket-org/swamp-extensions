/**
 * `@dataverket/cert-manager/order`: cert-manager Order objects, read with
 * kubectl. `list` records every Order in one namespace or all, plus one
 * inventory of what it saw; `get` records one. Authorizations are summarized; no ACME URL, token or certificate body is stored.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import { kubectlCliCheck, KubectlGlobalArgsSchema } from "../lib/kubectl.ts";
import {
  type MethodContext,
  NameSchema,
  NamespaceSchema,
  RESOURCES,
  StateInventorySchema,
} from "./_helpers.ts";
import {
  getKind,
  type KindDef,
  listKind,
  type MethodResult,
} from "./_methods.ts";
import {
  type OrderData,
  orderItem,
  OrderSchema,
  parseOrder,
} from "./_records.ts";

const KIND: KindDef<OrderData> = {
  spec: "order",
  resource: RESOURCES.order,
  label: "Order",
  parse: parseOrder,
  item: orderItem,
};

/** Swamp model for cert-manager Order objects. */
export const model = {
  type: "@dataverket/cert-manager/order",
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
    order: {
      description:
        "ACME Order state: state and reason, names, the authorizations without URLs or tokens, the failure time and the owning CertificateRequest",
      schema: OrderSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    inventory: {
      description:
        "What one list run saw: every Order in scope with its state, and how many are not healthy",
      schema: StateInventorySchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    /** List every Order in one namespace or all. */
    list: {
      description:
        "List cert-manager Order objects and record each with its state, plus one inventory of the run",
      arguments: z.object({
        namespace: NamespaceSchema.optional().describe(
          "Namespace to list. Defaults to the definition's; empty there means all namespaces.",
        ),
      }),
      execute: (
        args: { namespace?: string },
        context: MethodContext,
      ): Promise<MethodResult> => listKind(KIND, args, context),
    },

    /** Read one Order. */
    get: {
      description: "Read one cert-manager Order and record its state",
      arguments: z.object({
        name: NameSchema.describe("Order name"),
        namespace: NamespaceSchema.optional().describe(
          "Namespace of the Order. Defaults to the definition's.",
        ),
      }),
      execute: (
        args: { name: string; namespace?: string },
        context: MethodContext,
      ): Promise<MethodResult> => getKind(KIND, args, context),
    },
  },
};
