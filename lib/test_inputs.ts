/**
 * Inputs for the unit tests of pure functions: names shaped to be refused,
 * and the sentences kubectl writes to standard error, word for word, for a
 * parser or a classifier to read. Nothing here stands in for a process or a
 * service. No entry point imports it, so it is never part of a published
 * extension.
 *
 * @module
 */

/** Values shaped like a flag, a shell fragment, a path or plain nonsense. */
export const HOSTILE = [
  "-A",
  "--all",
  "--all-namespaces",
  "-o=yaml",
  "--kubeconfig=/etc/passwd",
  "a b",
  "a;rm -rf /",
  "$(id)",
  "`id`",
  "a|b",
  "a&b",
  "a>b",
  "../etc",
  "a/b",
  "Upper",
  "a\nb",
  "a\tb",
  "ø",
  "a_b",
  ".a",
  "a.",
  "-a",
  "a-",
  "",
  " ",
  "a".repeat(254),
];

/** A kubectl list answer. */
export function list(items: unknown[]): Record<string, unknown> {
  return {
    apiVersion: "v1",
    kind: "List",
    metadata: { resourceVersion: "" },
    items,
  };
}

/** A client-go log line, as kubectl prints before its own sentence. */
export const LOG_LINE =
  'E1110 10:48:48.424103 1157133 memcache.go:381] "Couldn\'t get current server API group list" err="Get \\"https://127.0.0.1:1/api?timeout=30s\\": dial tcp 127.0.0.1:1: connect: connection refused"\n';

/** What kubectl writes to standard error, word for word, for each failure. */
export const SAID = {
  notFound: (resource: string, name: string) =>
    `Error from server (NotFound): ${resource} "${name}" not found\n`,
  forbidden: (verb: string, resource: string, namespace = "") => {
    const [plural, ...group] = resource.split(".");
    return `Error from server (Forbidden): ${resource} is forbidden: User "system:serviceaccount:default:reader" cannot ${verb} resource "${plural}" in API group "${
      group.join(".")
    }" ${
      namespace ? `in the namespace "${namespace}"` : "at the cluster scope"
    }\n`;
  },
  unauthorized: "error: You must be logged in to the server (Unauthorized)\n",
  /** An expired or wrong token: five log lines, and no "(Unauthorized)". */
  badToken: LOG_LINE.replace(
    /err=.*/,
    'err="the server has asked for the client to provide credentials"',
  ).repeat(5) +
    "error: You must be logged in to the server (the server has asked for the client to provide credentials)\n",
  missingCrd: (plural: string) =>
    `error: the server doesn't have a resource type "${plural}"\n`,
  noKind: (kind: string, apiVersion: string) =>
    `error: resource mapping not found for name: "x" namespace: "y" from "STDIN": no matches for kind "${kind}" in version "${apiVersion}"\nensure CRDs are installed first\n`,
  conflict: (resource: string, name: string) =>
    `Error from server (Conflict): Operation cannot be fulfilled on ${resource} "${name}": the object has been modified; please apply your changes to the latest version and try again\n`,
  alreadyExists: (resource: string, name: string) =>
    `Error from server (AlreadyExists): error when creating "STDIN": ${resource} "${name}" already exists\n`,
  /** A closed port: five log lines, then the sentence. */
  refused: LOG_LINE.repeat(5) +
    "The connection to the server 127.0.0.1:1 was refused - did you specify the right host or port?\n",
  requestTimeout:
    "Unable to connect to the server: net/http: request canceled (Client.Timeout exceeded while awaiting headers)\n",
};
