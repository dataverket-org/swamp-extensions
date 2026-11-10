/**
 * `@dataverket/cert-manager/challenge`: cert-manager Challenge objects, read with
 * kubectl. `list` records every Challenge in one namespace or all, plus one
 * inventory of what it saw; `get` records one. The challenge token and key are never stored, and the solver is recorded by kind only.
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
  type ChallengeData,
  challengeItem,
  ChallengeSchema,
  parseChallenge,
} from "./_records.ts";

const KIND: KindDef<ChallengeData> = {
  spec: "challenge",
  resource: RESOURCES.challenge,
  label: "Challenge",
  parse: parseChallenge,
  item: challengeItem,
};

/** Swamp model for cert-manager Challenge objects. */
export const model = {
  type: "@dataverket/cert-manager/challenge",
  version: "2026.11.10.1",
  globalArguments: KubectlGlobalArgsSchema,
  checks: {
    "kubectl-cli-available": kubectlCliCheck,
  },
  resources: {
    challenge: {
      description:
        "ACME Challenge state: type, DNS name, state and reason, presented and processing, the solver kind and the owning Order",
      schema: ChallengeSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    inventory: {
      description:
        "What one list run saw: every Challenge in scope with its state, and how many are not healthy",
      schema: StateInventorySchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    /** List every Challenge in one namespace or all. */
    list: {
      description:
        "List cert-manager Challenge objects and record each with its state, plus one inventory of the run",
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

    /** Read one Challenge. */
    get: {
      description: "Read one cert-manager Challenge and record its state",
      arguments: z.object({
        name: NameSchema.describe("Challenge name"),
        namespace: NamespaceSchema.optional().describe(
          "Namespace of the Challenge. Defaults to the definition's.",
        ),
      }),
      execute: (
        args: { name: string; namespace?: string },
        context: MethodContext,
      ): Promise<MethodResult> => getKind(KIND, args, context),
    },
  },
};
