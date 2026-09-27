# arxiv

`arxiv_search` and `arxiv_paper` tools backed by the public arXiv API
(<https://info.arxiv.org/help/api/user-manual.html>). No API key required.

- `arxiv_search` — query with arXiv query syntax (`ti:`, `au:`, `abs:`, `cat:`,
  `all:`, `AND`/`OR`/`ANDNOT`, quoted phrases).
- `arxiv_paper` — fetch one paper's metadata and abstract by arXiv id.

Only imports `@earendil-works/pi-coding-agent` and `typebox`, both supplied by
the Pi host, so nothing needs to be installed here.
