# Stremio Hentai Hub

Stremio addon based on the v2.5.5 project supplied in this conversation. This build removes the Iwara and Hanime.red catalogs and adds HStream.moe. HStream implementation is embedded in `index.js`; there is no separate provider `.js` file.

## Providers

- HentaiMama
- Hentaigasm
- HentaiSmile
- HentaiCity
- HStream.moe

HStream's catalog and stream pages require JavaScript rendering, so this build uses `puppeteer-core` with `@sparticuz/chromium`. The browser is launched only when HStream is requested, and is closed after each operation. Other provider requests do not need the browser.

## Deploy

1. Put `index.js`, `package.json`, `test.js`, `README.md`, and `render.yaml` directly in the repository root.
2. Install dependencies with `npm install`.
3. Start with `npm start`.
4. Install the public HTTPS URL ending in `/manifest.json` in Stremio.

## Tests

Run `npm test`.

## Optional environment variables

`PORT`, `USER_AGENT`, `HTTP_TIMEOUT_MS`, `CACHE_CATALOG_SECONDS`, `CACHE_DETAIL_SECONDS`, `CACHE_STREAM_SECONDS`, `EMBED_DEPTH`, `EMBED_PAGE_LIMIT`, `HENTAIMAMA_BASE`, `HENTAIGASM_BASE`, `HENTAISMILE_BASE`, `HENTAICITY_BASE`, .
