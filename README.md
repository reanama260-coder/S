# Stremio Hentai Hub v2.5.13

Based on the previous working provider set. Existing provider IDs, manifest catalog IDs, genre options, and poster rules are preserved. Iwara remains removed.

## Changes in 2.5.13

- The combined `Hentai Hub - All Providers` listing removes duplicate titles appearing on multiple providers. Individual provider catalogs are unchanged.
- Hanime.red streams are resolved fresh for every stream request; signed stream responses are not cached.
- Hanime.red player API calls now send the player-page Referer, Origin, and browser-style JSON Accept header.
- Hanime.red HLS master URLs are passed through unchanged instead of being rewritten to child playlists, preserving signature query parameters.
- The package, runtime log, and served manifest versions are synchronized at 2.5.13.
- No new dependencies, headless browser, or extra catalog IDs beyond the existing Hanime.red provider.

## Deploy

1. Put `index.js`, `package.json`, `test.js`, `README.md`, and `render.yaml` in the repository root.
2. Install dependencies with `npm install`.
3. Start with `npm start`.
4. Use the public HTTPS address ending in `/manifest.json` in Stremio.

Run `npm test` after installing dependencies. Playback against the live provider must be verified in the deployed environment; this test container has no outbound DNS/network access.


Hanime.red stream resolver update (v2.5.13): adds the expected player-page Referer and Origin to its URL API request, keeps signed HLS URLs unchanged, and synchronizes all version metadata. No provider or catalog changes.
