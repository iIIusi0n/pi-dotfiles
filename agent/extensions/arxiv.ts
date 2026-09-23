/**
 * arXiv tools - search and fetch papers via the arXiv public API
 * Docs: https://info.arxiv.org/help/api/user-manual.html
 *
 *   arxiv_search - query the arXiv API (supports arXiv query syntax)
 *   arxiv_paper  - fetch one paper by arXiv id (id_list)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const API_URL = "https://export.arxiv.org/api/query";

const SORTS = ["relevance", "lastUpdatedDate", "submittedDate"] as const;
type Sort = (typeof SORTS)[number];

interface ArxivEntry {
	id: string; // arXiv id (no version suffix in abs URL form: 2401.12345)
	absUrl: string;
	title: string;
	authors: string[];
	summary: string;
	published: string;
	updated: string;
	primaryCategory: string;
	categories: string[];
}

function decode(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
}

function clean(s: string): string {
	// Atom wraps title/summary in newlines + indentation
	return decode(s).replace(/\s*\n\s*/g, " ").trim();
}

function extractTag(xml: string, tag: string): string | undefined {
	const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
	return m ? m[1] : undefined;
}

function extractAllTags(xml: string, tag: string): string[] {
	const out: string[] = [];
	const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml))) out.push(m[1]);
	return out;
}

function extractAttr(xml: string, tag: string, attr: string): string[] {
	const out: string[] = [];
	const re = new RegExp(`<${tag}\\s+${attr}="([^"]*)"`, "g");
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml))) out.push(decode(m[1]));
	return out;
}

function parseEntry(xml: string): ArxivEntry {
	const idUrl = extractTag(xml, "id") ?? "";
	const m = idUrl.match(/arxiv\.org\/abs\/(.+)$/);
	const id = m ? m[1] : idUrl;
	const absUrl = id.includes("/") ? `https://arxiv.org/abs/${id.split("/").join("/")}` : `https://arxiv.org/abs/${id}`;
	const authorBlocks = xml.split("<author>").filter((b) => b.includes("<name>"));
	const authors = authorBlocks
		.map((b) => extractTag(b, "name"))
		.filter((n): n is string => n !== undefined)
		.map(clean);
	return {
		id,
		absUrl,
		title: clean(extractTag(xml, "title") ?? "(untitled)"),
		authors,
		summary: clean(extractTag(xml, "summary") ?? ""),
		published: extractTag(xml, "published") ?? "",
		updated: extractTag(xml, "updated") ?? "",
		primaryCategory: extractAttr(xml, "arxiv:primary_category", "term")[0] ?? "",
		categories: extractAttr(xml, "category", "term"),
	};
}

function parseFeed(body: string): { total: number; entries: ArxivEntry[]; error?: string } {
	const status = body.match(/<opensearch:status[^>]*>(\d+)<\/opensearch:status>/);
	if (status && status[1] !== "200") {
		return { total: 0, entries: [], error: `arXiv API error ${status[1]}: ${clean(extractTag(body, "title") ?? "unknown error")}` };
	}
	const totalMatch = body.match(/<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/);
	const total = totalMatch ? Number(totalMatch[1]) : 0;
	const entries: ArxivEntry[] = [];
	const re = /<entry>([\s\S]*?)<\/entry>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(body))) entries.push(parseEntry(m[1]));
	return { total, entries };
}

async function queryArxiv(params: URLSearchParams, signal?: AbortSignal): Promise<{ total: number; entries: ArxivEntry[]; error?: string }> {
	const url = `${API_URL}?${params.toString()}`;
	const res = await fetch(url, { signal, headers: { Accept: "application/atom+xml" } });
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		return { total: 0, entries: [], error: `HTTP ${res.status} ${res.statusText}${text ? `: ${clean(text).slice(0, 300)}` : ""}` };
	}
	return parseFeed(await res.text());
}

function truncateAbstract(s: string, max = 800): string {
	if (s.length <= max) return s;
	return s.slice(0, max).replace(/\s+\S*$/, "") + "… (truncated)";
}

function formatList(queryLabel: string, total: number, start: number, entries: ArxivEntry[], fullAbstracts = false): string {
	if (entries.length === 0) return `No results for ${queryLabel}.`;
	const lines: string[] = [`Found ${total} total on arXiv (showing ${entries.length} from offset ${start}):`, ""];
	entries.forEach((e, i) => {
		const authors = e.authors.length > 3 ? `${e.authors.slice(0, 3).join(", ")} et al.` : e.authors.join(", ");
		lines.push(`${start + i + 1}. [${e.id}] ${e.title}`);
		lines.push(`   ${e.published.slice(0, 10)} | ${e.primaryCategory}${e.categories.length > 1 ? ` (also: ${e.categories.slice(1).join(", ")})` : ""} | ${authors || "unknown authors"}`);
		lines.push(`   ${e.absUrl}`);
		if (e.summary) lines.push(`   Abstract: ${fullAbstracts ? e.summary : truncateAbstract(e.summary)}`);
		lines.push("");
	});
	return lines.join("\n");
}

async function run(
	_toolCallId: string,
	params: Record<string, unknown>,
	signal?: AbortSignal,
) {
	const p = params as {
		query?: string;
		id?: string;
		start?: number;
		max_results?: number;
		sort?: string;
		order?: string;
	};

	if (p.query) {
		const sp = new URLSearchParams({ search_query: p.query, start: String(p.start ?? 0), max_results: String(Math.min(p.max_results ?? 10, 100)) });
		if (p.sort && (SORTS as readonly string[]).includes(p.sort)) {
			sp.set("sortBy", p.sort);
			sp.set("sortOrder", p.order === "ascending" ? "ascending" : "descending");
		}
		const { total, entries, error } = await queryArxiv(sp, signal);
		if (error) throw new Error(error);
		return { content: [{ type: "text", text: formatList(`"${p.query}"`, total, p.start ?? 0, entries) }] };
	}

	if (p.id) {
		const sp = new URLSearchParams({ id_list: p.id, max_results: "1" });
		const { entries, error } = await queryArxiv(sp, signal);
		if (error) throw new Error(error);
		if (entries.length === 0) throw new Error(`Paper ${p.id} not found on arXiv.`);
		const e = entries[0];
		const lines = [
			`[${e.id}] ${e.title}`,
			`Authors: ${e.authors.join(", ") || "unknown"}`,
			`Published: ${e.published} | Updated: ${e.updated}`,
			`Categories: ${e.categories.join(", ")}`,
			`URL: ${e.absUrl} | PDF: ${e.absUrl.replace("/abs/", "/pdf/")}`,
			"",
			`Abstract: ${e.summary}`,
		];
		return { content: [{ type: "text", text: lines.join("\n") }] };
	}

	throw new Error("Provide either `query` (search) or `id` (single paper).");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "arxiv_search",
		label: "arXiv Search",
		description:
			'Search arXiv papers via the official arXiv API. `query` uses arXiv query syntax: field prefixes like ti: (title), au: (author), abs: (abstract), cat: (category, e.g. cs.LG), all: (all fields), combinable with AND/OR/ANDNOT and quoted phrases. Example: `all:"chain of thought" AND cat:cs.CL ANDNOT abs:survey`. Returns arXiv id, title, authors, date, categories, URL, and abstract per paper. Prefer `arxiv_paper` to fetch full details of one known paper.',
		parameters: Type.Object({
			query: Type.String({ description: 'arXiv search query, e.g. `ti:"test-time training" AND cat:cs.LG`' }),
			start: Type.Optional(Type.Number({ description: "Result offset for pagination (default 0)", minimum: 0 })),
			max_results: Type.Optional(Type.Number({ description: "Max results, 1-100 (default 10)", minimum: 1, maximum: 100 })),
			sort: Type.Optional(Type.Union([Type.Literal("relevance"), Type.Literal("lastUpdatedDate"), Type.Literal("submittedDate")], { description: "Sort criterion (default relevance). Date sorts require `order`." })),
			order: Type.Optional(Type.Union([Type.Literal("ascending"), Type.Literal("descending")], { description: "Sort order for date sorting (default descending, i.e. newest first)" })),
		}),
		async execute(toolCallId, params, signal) {
			const r = await run(toolCallId, params as Record<string, unknown>, signal);
			return { content: r.content, details: undefined };
		},
	});

	pi.registerTool({
		name: "arxiv_paper",
		label: "arXiv Paper",
		description:
			"Fetch one arXiv paper's metadata and abstract by its arXiv id (e.g. `2401.12345` or `cs/0303093`; optional version suffix like `2401.12345v2`). Returns title, all authors, dates, categories, URLs, full abstract.",
		parameters: Type.Object({
			id: Type.String({ description: "arXiv paper id, e.g. 2401.12345" }),
		}),
		async execute(toolCallId, params, signal) {
			const r = await run(toolCallId, params as Record<string, unknown>, signal);
			return { content: r.content, details: undefined };
		},
	});
}
