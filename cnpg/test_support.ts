/** The global arguments of a test's definition. */
interface TestGlobalArgs {
  namespace: string;
  context?: string;
  kubeconfig?: string;
}

/** A method context that records writes and log lines. */
export function ctx(globalArgs: TestGlobalArgs, signal?: AbortSignal) {
  const written: Array<{ spec: string; name: string; data: unknown }> = [];
  const logs: string[] = [];
  const log = (m: string, props?: Record<string, string>) => {
    logs.push(
      m.replace(/\{(\w+)\}/g, (_, k: string) => props?.[k] ?? `{${k}}`),
    );
  };
  return {
    written,
    logs,
    context: {
      globalArgs,
      signal,
      logger: { info: log, warning: log },
      // deno-lint-ignore no-explicit-any
      writeResource: (spec: string, name: string, data: any) => {
        written.push({ spec, name, data });
        return Promise.resolve({ spec, name });
      },
    },
  };
}

/** Marker values a fixture plants where a credential reference would be. */
export const PLANTED = {
  secretName: "PLANTED-secret-name",
  secretKey: "PLANTED-secret-key",
  password: "PLANTED-passw0rd",
  token: "PLANTEDtoken0123456789",
  commandOutput: "PLANTED-command-output",
};
