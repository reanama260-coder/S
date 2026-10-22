# Stremio Hentai Hub v2.5.7

Stable v2.5.4-wide base with the Hanime.red catalog and a site-specific stream resolver. The Iwara Community provider has been removed completely. Existing provider catalogs, genre lists, and display rules are retained; Hanime.red cards always use `poster` shape, including in the mixed `All Providers` catalog.

## Providers

- HentaiMama
- Hentaigasm
- HentaiSmile
- HentaiCity
- Hanime.red · Studio HD

## Deploy

1. Put `index.js`, `package.json`, `test.js`, `README.md`, and `render.yaml` directly in the repository root.
2. Install dependencies with `npm install`.
3. Start with `npm start`.
4. Install the public HTTPS URL ending in `/manifest.json` in Stremio.

Hanime.red stream resolution follows the primary page player to its `nhplayer.com` player endpoint, solves its challenge, and uses the endpoint's returned media URL. It does not guess stream URLs or recursively scrape recommended-video iframes. Requests have timeouts, and proof-of-work yields between batches so it does not monopolize the event loop.

Run `npm test` for unit tests. The server uses the existing Axios/Cheerio/crypto stack; no browser process or new package is required.
