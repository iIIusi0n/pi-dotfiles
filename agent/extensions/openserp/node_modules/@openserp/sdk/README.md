# @openserp/sdk

[![npm version](https://img.shields.io/npm/v/@openserp/sdk.svg)](https://www.npmjs.com/package/@openserp/sdk)
[![npm downloads](https://img.shields.io/npm/dm/@openserp/sdk.svg)](https://www.npmjs.com/package/@openserp/sdk)
[![license](https://img.shields.io/npm/l/@openserp/sdk.svg)](https://github.com/openserpapi/sdk-js/blob/main/LICENSE.md)

```bash
npm install @openserp/sdk
```

Cloud:

```ts
import { OpenSERP } from "@openserp/sdk";

const client = new OpenSERP({ apiKey: process.env.OPENSERP_API_KEY });
const { results } = await client.search({ engine: "google", text: "openserp" });

console.log(results[0]?.title, results[0]?.url);
```

Self-hosted:

```ts
import { OpenSERP } from "@openserp/sdk";

const client = new OpenSERP({ baseUrl: "http://localhost:7000" });
const { results } = await client.search({ engine: "bing", text: "openserp" });

console.log(results[0]?.title, results[0]?.url);
```

Universal TypeScript / JavaScript SDK for the **OpenSERP** multi-engine SERP API - Google, Bing, Yandex, Baidu, DuckDuckGo, and Ecosia results in a single call. Works against the self-hosted [open source server](https://github.com/karust/openserp) and against [OpenSERP Cloud](https://openserp.org/cloud) with the same code.

Use it for AI grounding, RAG pipelines, LLM tool use, agent tool use, LangChain / LlamaIndex integrations, SEO rank tracking, competitor analysis, and search-powered automations. Open-source alternative to SerpAPI, DataForSEO, ScrapingBee, Bright Data SERP, Oxylabs SERP, and Zenserp.

> Also available for Python: [`openserp`](https://pypi.org/project/openserp/).

> **Alpha - the API may change before `1.0.0`.** Pin a version in production.

## Contents

- [Install](#install)
- [Why OpenSERP](#why-openserp)
- [Quickstart - OSS (self-hosted)](#quickstart---oss-self-hosted)
- [Quickstart - Cloud](#quickstart---cloud)
- [Why two backends?](#why-two-backends)
- [Search](#search)
- [Extract](#extract)
- [Images](#images)
- [Endpoint availability](#endpoint-availability)
- [Telemetry](#telemetry)
- [Error handling](#error-handling)
- [Retry hook](#retry-hook)
- [Use cases](#use-cases)

## Install

```bash
npm install @openserp/sdk
```

```bash
yarn add @openserp/sdk
```

```bash
pnpm add @openserp/sdk
```

```bash
bun add @openserp/sdk
```

ESM and CommonJS builds are both shipped. Requires Node 18+ and a global `fetch` (any modern runtime).

## Why OpenSERP

| Need | OpenSERP fit |
| --- | --- |
| Local development | Run the OSS server and use the same SDK surface as Cloud. |
| AI grounding | Pull fresh SERP snippets and optional extracted page text for prompts, RAG, or agents. |
| SEO checks | Query Google, Bing, Yandex, Baidu, DuckDuckGo, and Ecosia with typed params. |
| Migration path | Start self-hosted, then switch to Cloud by adding `OPENSERP_API_KEY`. |

Compared with hosted-only SERP APIs, OpenSERP keeps the client contract portable. You can test locally without an API key, then use the hosted API when you want managed infrastructure.

## Quickstart - OSS (self-hosted)

Run the open source server locally, no API key required:

```bash
docker run -p 7000:7000 karust/openserp serve
```

```ts
import { OpenSERP } from "@openserp/sdk";

const client = new OpenSERP({
  baseUrl: "http://localhost:7000",
});

const results = await client.search({
  engine: "google",
  text: "openserp",
  limit: 10,
  region: "US",
  lang: "EN",
});

console.log(results.results[0]?.title);
```

## Quickstart - Cloud

Get an API key from the [API keys](https://openserp.org/dashboard/keys) section in the dashboard. When `apiKey` is set, the SDK defaults `baseUrl` to `https://api.openserp.org/v1` and sends `Authorization: Bearer ...` for you.

```ts
import { OpenSERP } from "@openserp/sdk";

const client = new OpenSERP({
  apiKey: process.env.OPENSERP_API_KEY,
  timeoutMs: 30_000,
});

const results = await client.search({
  engine: "google",
  text: "openserp",
});

console.log(client.lastResponse?.credits); // { used, remaining }
```

If both `baseUrl` and `apiKey` are set, `baseUrl` wins and the key is still sent. Use this for an authenticated self-hosted deployment. Add `backend: "oss"` when you also need OSS-only methods such as `stats()` or `health()`.

## Why two backends?

OpenSERP Cloud uses the same public HTTP contract as the OSS server, with a `/v1/` prefix and bearer auth. The same SDK call works on both; you only change `baseUrl` / `apiKey`. Start with OSS locally, then move to Cloud when you want the hosted API. See [openserp.org/docs/oss-vs-cloud](https://openserp.org/docs/oss-vs-cloud) for the full comparison.

## Search

```ts
const single = await client.search({
  engine: "bing",
  text: "golang",
  limit: 10,
  region: "US",
});

const mega = await client.megaSearch({
  text: "golang",
  engines: ["google", "bing", "yandex"],
  mode: "balanced",
  limit: 20,
});

const fast = await client.fastSearch({
  text: "golang",
  engines: ["google", "bing"],
});

const any = await client.anySearch({
  text: "golang",
  engines: ["google", "yandex"],
});
```

`megaSearch` aggregates multiple engines. `mode` is `"balanced"` (default, merged and deduplicated), `"any"` (first successful engine wins), or `"fast"` (uses the fastest healthy engine). `fastSearch` / `anySearch` are sugar for the matching mode.

To enrich top search results with cleaned page content, pass the extraction flags:

```ts
const grounded = await client.search({
  engine: "google",
  text: "openserp docs",
  extract: 3,
  extractMode: "auto",
  minRunes: 500,
});

console.log(grounded.results[0]?.extracted?.content);
```

## Extract

```ts
const page = await client.extract({
  url: "https://openserp.org/docs",
  mode: "auto",
  clean: true,
});

console.log(page.markdown);
```

Use `minRunes` to set the auto-mode escalation floor, `clean: false` for whole-page readable extraction, and `useLlmsTxt: true` to prefer `/llms-full.txt` or `/llms.txt` for site-root URLs. Non-JSON formats are returned as strings:

```ts
const markdown = await client.extract({
  url: "https://openserp.org",
  format: "markdown",
});
```

### Batch extract

`batchExtract` takes up to 20 URLs in one request. A URL that fails becomes an item with an `error` instead of failing the whole call, so one dead link never costs you the other results:

```ts
const batch = await client.batchExtract({
  urls: [
    "https://openserp.org/docs",
    "https://openserp.org/blog",
  ],
  mode: "auto",
});

for (const item of batch.results ?? []) {
  if (item.error) console.warn(item.url, "failed:", item.error);
  else console.log(item.url, item.page_content?.slice(0, 120));
}
```

On the hosted API, billing is per URL and matches calling `extract` that many times - successful extractions bill their mode, failed and empty ones are free.

### Regions

Pass `region` (a two-letter country code) to extract as a visitor from that country - useful for geo-fenced or localized pages. On the hosted API this adds 1 credit per successfully extracted URL:

```ts
const page = await client.extract({
  url: "https://example.com/pricing",
  region: "DE",
});
```

## Images

```ts
const images = await client.image({
  engine: "bing",
  text: "golang logo",
  limit: 20,
});

const megaImages = await client.megaImage({
  text: "golang logo",
  engines: ["bing", "google"],
});
```

## Endpoint availability

OSS-only operational methods throw `OssOnlyError` when the client is configured for Cloud:

```ts
await client.parseGoogle({ html: "<html>...</html>" });
await client.stats();
await client.health();
```

Cloud-only account methods throw `CloudOnlyError` when the client is configured for OSS:

```ts
await client.me();
await client.pricing();
await client.enginesStatus();
await client.enginesCapabilities();
```

The backend is inferred from `baseUrl` and `apiKey`. Pass `backend: "oss"` or `backend: "cloud"` to the constructor to override.

## Telemetry

`client.lastResponse` is updated after each HTTP response:

```ts
console.log(client.lastResponse?.credits); // Cloud - { used, remaining }
console.log(client.lastResponse?.engineUsed); // both - X-Engine-Used
console.log(client.lastResponse?.fallbackEngine); // OSS only
console.log(client.lastResponse?.cache); // OSS only
```

Some self-hosted operational headers are not part of the Cloud response contract, so expect those fields to be `undefined` against `api.openserp.org`. `credits` is Cloud-specific.

## Error handling

```ts
import { CaptchaError, RateLimitError, SERPError } from "@openserp/sdk";

try {
  await client.search({ engine: "google", text: "openserp" });
} catch (err) {
  if (err instanceof RateLimitError) {
    // slow down or queue the request
  } else if (err instanceof CaptchaError) {
    // inspect the upstream search failure and retry later
  } else if (err instanceof SERPError) {
    console.error(err.status, err.code, err.reason, err.requestId);
  }
}
```

## Retry hook

The SDK does not apply a retry policy. Provide a hook when you want one:

```ts
import { OpenSERP, SERPError } from "@openserp/sdk";

const RETRYABLE = new Set([408, 429, 500, 502, 503]);

const client = new OpenSERP({
  apiKey: process.env.OPENSERP_API_KEY,
  retry: async (err, attempt) => {
    if (attempt >= 2 || !(err instanceof SERPError) || !RETRYABLE.has(err.status)) {
      return false;
    }
    const wait = Math.min(2 ** attempt * 250, 8_000) + Math.random() * 250;
    await new Promise((r) => setTimeout(r, wait));
    return true;
  },
});
```

## Use cases

- **AI grounding / RAG** - feed top-N search results into an LLM prompt (OpenAI, Anthropic, Ollama) for up-to-date answers.
- **LLM tool use** - expose `client.search` as a tool to your agent.
- **SEO monitoring** - daily rank tracking across multiple engines and regions, export to Sheets or Notion.
- **Competitor analysis** - weekly diff of top-10 results for a keyword set.
- **Data pipelines** - stream SERPs to ClickHouse, BigQuery, or a DataFrame for NLP on snippets.
