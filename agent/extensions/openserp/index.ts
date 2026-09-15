import { OpenSERP, SERPError, TimeoutError } from "@openserp/sdk";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errorClass(err: unknown): string | undefined {
  if (!(err instanceof SERPError)) return undefined;
  if (err.code) return err.code;
  if (typeof err.response === "string") {
    try {
      const body = JSON.parse(err.response) as { error?: unknown };
      if (typeof body.error === "string") return body.error;
    } catch {
      // non-JSON error body
    }
  }
  return undefined;
}

function isTransient(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  if (err instanceof SERPError) {
    if (err.status === 429 || err.status >= 500) return true;
    return [
      "search_timeout",
      "request_timeout",
      "circuit_open",
      "service_unavailable",
    ].includes(errorClass(err) ?? "");
  }
  return err instanceof TypeError;
}

const client = new OpenSERP({
  baseUrl: process.env.OPENSERP_URL ?? "http://127.0.0.1:7000",
  timeoutMs: 20_000,
  retry: async (err, attempt) => {
    if (attempt >= 2 || !isTransient(err)) return false;
    await sleep(500 * 2 ** attempt);
    return true;
  },
});

export const webSearchSchema = Type.Object({
  query: Type.String({ description: "The search query to run" }),
  engines: Type.Optional(
    Type.String({
      description:
        "Comma-separated engines to use (default: duckduckgo,google,bing,ecosia). Use a single engine for faster results.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of search results to return (1-100, default 10)" }),
  ),
});

const ENGINES = "duckduckgo,google,bing,ecosia,yandex,baidu";

function describeError(err: unknown): string {
  if (err instanceof SERPError) {
    const code = errorClass(err) ?? (err.status ? `http_${err.status}` : "error");
    return `Search failed: ${code} — ${err.message}`;
  }
  if (err instanceof Error) return `Search failed: ${err.message}`;
  return `Search failed: ${String(err)}`;
}

function parseEngines(engines?: string): string[] | undefined {
  if (!engines) return undefined;
  return engines.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web via the local OpenSERP service. Returns results as markdown with titles, URLs, and snippets. " +
      `Available engines: ${ENGINES}.`,
    parameters: webSearchSchema,
    async execute(_toolCallId, params, signal) {
      const engines = parseEngines(params.engines);
      if (engines?.some((e) => !ENGINES.split(",").includes(e))) {
        return {
          content: [{ type: "text", text: `Unknown engine in "${params.engines}". Available: ${ENGINES}` }],
          details: {},
          isError: true,
        };
      }
      try {
        const search = client.anySearch({
          text: params.query.trim(),
          engines,
          limit: params.limit ?? 10,
          format: "markdown",
        });
        if (signal?.aborted) return { content: [{ type: "text", text: "Search aborted." }], details: {} };
        const result = await Promise.race([
          search,
          new Promise<never>((_, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          }),
        ]);
        return { content: [{ type: "text", text: result }], details: {} };
      } catch (err) {
        if (err instanceof Error && err.message === "aborted") {
          return { content: [{ type: "text", text: "Search aborted." }], details: {} };
        }
        return { content: [{ type: "text", text: describeError(err) }], details: {}, isError: true };
      }
    },
  });
}
