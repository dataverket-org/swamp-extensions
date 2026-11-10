/**
 * `@dataverket/cert-manager/certificaterequest`: cert-manager CertificateRequest objects, read with
 * kubectl. `list` records every CertificateRequest in one namespace or all, plus one
 * inventory of what it saw; `get` records one. The CSR and the issued certificate bodies are never stored.
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
  type CertificateRequestData,
  certificateRequestItem,
  CertificateRequestSchema,
  parseCertificateRequest,
} from "./_records.ts";

const KIND: KindDef<CertificateRequestData> = {
  spec: "certificateRequest",
  resource: RESOURCES.certificateRequest,
  label: "CertificateRequest",
  parse: parseCertificateRequest,
  item: certificateRequestItem,
};

/** Swamp model for cert-manager CertificateRequest objects. */
export const model = {
  type: "@dataverket/cert-manager/certificaterequest",
  version: "2026.11.10.1",
  globalArguments: KubectlGlobalArgsSchema,
  checks: {
    "kubectl-cli-available": kubectlCliCheck,
  },
  resources: {
    certificateRequest: {
      description:
        "CertificateRequest state: the Certificate and revision it belongs to, the Approved, Denied, Ready and InvalidRequest conditions, the issuer and the failure time",
      schema: CertificateRequestSchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
    inventory: {
      description:
        "What one list run saw: every CertificateRequest in scope with its state, and how many are not healthy",
      schema: StateInventorySchema,
      lifetime: "30d" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    /** List every CertificateRequest in one namespace or all. */
    list: {
      description:
        "List cert-manager CertificateRequest objects and record each with its state, plus one inventory of the run",
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

    /** Read one CertificateRequest. */
    get: {
      description:
        "Read one cert-manager CertificateRequest and record its state",
      arguments: z.object({
        name: NameSchema.describe("CertificateRequest name"),
        namespace: NamespaceSchema.optional().describe(
          "Namespace of the CertificateRequest. Defaults to the definition's.",
        ),
      }),
      execute: (
        args: { name: string; namespace?: string },
        context: MethodContext,
      ): Promise<MethodResult> => getKind(KIND, args, context),
    },
  },
};
