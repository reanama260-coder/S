# Stremio Hentai Hub

Stremio addon with five active sources: HentaiMama, Hentaigasm, HentaiSmile, HStream, and Iwara Community. HentaiCity is removed. Hanime and Hentai.TV remain omitted.

## Changes in v2.5.5

- Removed HentaiCity from the active provider registry and manifest.
- Added HStream. Its player is resolved server-side; the addon lists only media sources actually exposed by the player. Some videos offer 720p, 1080p, 1440p (2K), or 2160p (4K); the available options vary by video.
- Added Iwara Community for user-uploaded animation. Its catalog uses Iwara's `ecchi` rating where the API provides it, and stream choices are taken from the source variants returned by Iwara. Quality labels are not fabricated.
- Both new providers return direct media streams to Stremio. There is no “open in browser” stream fallback.
- Existing provider genre lists and the shared catalog genre list are unchanged. HStream and Iwara do not show a provider-specific genre selector because the addon does not map the existing genre list to their real tags. The existing HentaiMama poster behavior in genre catalogs remains unchanged.
- Existing HentaiMama, Hentaigasm, and HentaiSmile resolution logic is retained.

## Deploy

1. Replace the addon's files with the files from this ZIP.
2. Push the changes and let the host reinstall dependencies and redeploy.
3. Install the deployment's public HTTPS URL ending in `/manifest.json` in Stremio.
4. Check deployment logs if a catalog or stream returns empty.

Chromium dependencies are now included for server-side extraction and Iwara's API fallback. Playback still happens in Stremio from API/player media URLs; the addon's browser is used only by the server to discover those URLs.

## Tests

Run after dependencies install:

```sh
npm test
npm start
```

Tests cover the provider manifest, quality-label handling, Iwara URL/variant parsing, catalog pagination, route normalization, HentaiMama player parsing, and HentaiSmile player-ID matching, stream labeling, and title matching. Live playback was not testable from the offline build environment; actual resolution availability depends on each provider's source response.

## Environment variables

`PORT`, `USER_AGENT`, `HTTP_TIMEOUT_MS`, `CACHE_CATALOG_SECONDS`, `CACHE_DETAIL_SECONDS`, `CACHE_STREAM_SECONDS`, `EMBED_DEPTH`, `EMBED_PAGE_LIMIT`, `HENTAIMAMA_BASE`, `HENTAIGASM_BASE`, `HENTAISMILE_BASE`, `HSTREAM_BASE`, `IWARA_API_BASE`, and optional `CHROME_PATH`.
