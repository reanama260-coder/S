'use strict';

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const TYPE = 'other';
const UA = process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
const CATALOG_TTL = Number(process.env.CACHE_CATALOG_SECONDS || 600) * 1000;
const DETAIL_TTL = Number(process.env.CACHE_DETAIL_SECONDS || 1800) * 1000;
const STREAM_TTL = Number(process.env.CACHE_STREAM_SECONDS || 180) * 1000;
const FRESH_STREAM_TTL = Number(process.env.CACHE_STREAM_SECONDS || 25) * 1000;
const PAGE_SIZE = 20;
const PAGE_LIMIT = 100;
const MINOR_TERMS = /\b(loli(?:con)?|shota(?:con)?|underage|child porn|young girl|young boy)\b/i;
const GENRES = ['3D','Ahegao','Anal','BDSM','Big Breasts','Blowjob','Bondage','Comedy','Cosplay','Creampie','Dark Skin','Demon','Doujin','Exhibition','Fantasy','Femdom','Fetish','Footjob','Futanari','Gangbang','Glasses','Group','Harem','Horror','Incest','Maid','Masturbation','Milf','Monster','Motion Anime','Netorare','Nurse','Office Lady','Romance','School','Sci-Fi','Succubus','Swimsuit','Tentacle','Threesome','Uncensored','Vanilla','Virgin','X-Ray','Yuri'];
const PROVIDER_GENRES = {
  hentaigasm: GENRES,
  hentaimama: ['Ahegao','Anal','Brainwashed','Creampie','Dark Skin','DeepThroat','Domination','Femdom','Harem','Horny Slut','Humiliation','Internal Cumshot','Large Breasts','Mind Break','Pregnant','Rape','Squirting','X-Ray','3D','Uncensored'],
  hentaismile: ['3D','Ahegao','Anal','Anime','Anime Sex','BDSM','Big Breasts','Big Tits','Blowjob','Cosplay','Doujin','Harem','Incest','Milf','Monster','Naruto','Sakura','Hinata','Tsunade','Stepmom','Hentai Adventure','Hentai Comedy','Hentai Parody','Hentai Video','Uncensored','Yuri'],
  tokyotosho: ['720p','1080p','1440p','2160p','4K','OVA','Uncensored'],
  hentaiocean: [],
};

const http = axios.create({
  timeout: Number(process.env.HTTP_TIMEOUT_MS || 15000),
  maxRedirects: 5,
  headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  validateStatus: status => status >= 200 && status < 400,
});

const cache = new Map();
const inFlight = new Map();
async function cached(key, ttl, fn) {
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) return entry.value;
  if (inFlight.has(key)) return inFlight.get(key);
  const task = (async () => {
    const value = await fn();
    const emptyArray = Array.isArray(value) && value.length === 0;
    if (!emptyArray && value != null) cache.set(key, { value, expires: Date.now() + ttl });
    if (cache.size > 1500) {
      for (const [k, v] of cache) if (v.expires <= Date.now()) cache.delete(k);
      while (cache.size > 1500) cache.delete(cache.keys().next().value);
    }
    return value;
  })();
  inFlight.set(key, task);
  try { return await task; }
  finally { inFlight.delete(key); }
}

const clean = v => String(v || '').replace(/\s+/g, ' ').trim();
const stripHtml = v => clean(String(v || '').replace(/<[^>]*>/g, ' '));
const slugify = v => clean(v).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const encodeKey = v => Buffer.from(String(v), 'utf8').toString('base64url');
const decodeKey = v => Buffer.from(String(v), 'base64url').toString('utf8');

function canonicalHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}
function sameProviderHost(url, base) {
  try {
    const a = new URL(url);
    const b = new URL(base);
    return canonicalHost(a.hostname) === canonicalHost(b.hostname);
  } catch { return false; }
}
function absUrl(value, base) {
  try {
    if (!value) return '';
    const u = new URL(String(value).replace(/&amp;/g, '&'), base);
    return ['http:', 'https:'].includes(u.protocol) ? u.href : '';
  } catch { return ''; }
}
function canonicalContentUrl(providerId, value, base) {
  const resolved = absUrl(value, base);
  if (!resolved) return '';
  try {
    const u = new URL(resolved);
    u.hash = '';
    // Normalize www/non-www aliases into a single catalog ID per provider.
    if (base && providerId !== 'hentaigasm') {
      try { const b = new URL(base); if (canonicalHost(u.hostname) === canonicalHost(b.hostname)) u.hostname = b.hostname; } catch {}
    }
    if (providerId === 'hentaimama') u.search = '';
    u.pathname = u.pathname.replace(/\/{2,}/g, '/');
    if (!/\.[a-z0-9]{2,5}$/i.test(u.pathname) && u.pathname !== '/') u.pathname = `${u.pathname.replace(/\/+$/, '')}/`;
    return u.href;
  } catch { return resolved; }
}
function normalizedTextKey(value) {
  return clean(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function titleFromUrl(value, providerId) {
  try {
    const u = new URL(value);
    let parts = u.pathname.split('/').filter(Boolean);
    if (providerId === 'hentaismile' && parts[0] === 'videos') parts = parts.slice(2);
    let slug = parts[parts.length - 1] || '';
    slug = slug.replace(/\.(?:html?|php)$/i, '');
    if (providerId === 'hentaimama') slug = slug.replace(/-episode-?\d+.*$/i, '');
    slug = decodeURIComponent(slug).replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
    return slug ? slug.replace(/\b\w/g, c => c.toUpperCase()) : '';
  } catch { return ''; }
}
function cleanVideoTitle(value) {
  return clean(value)
    .replace(/^(?:HD\s*)?\d{1,2}:\d{2}(?::\d{2})?\s*/i, '')
    .replace(/\b\d+(?:[.,]\d+)?\s*[kKmM]?\s*views?\b/gi, '')
    .replace(/\b\d{1,3}%(?=\s|$)/g, '')
    .replace(/^[\s|·•–—-]+|[\s|·•–—-]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function hentaiSmileTitleMatchesSlug(value, slugTitle) {
  const titleTokens = v => normalizedTextKey(cleanVideoTitle(v)).split(' ').filter(t => t.length >= 3 && !/^(?:hentai|video|anime|porn|xxx|uncensored|cartoon|adult|hd|the|and|for|with|from|that|this)$/.test(t));
  const candidateTokens = [...new Set(titleTokens(value))];
  const slugTokens = [...new Set(titleTokens(slugTitle))];
  if (!candidateTokens.length || !slugTokens.length) return false;
  const shared = candidateTokens.filter(t => slugTokens.includes(t)).length;
  return shared / candidateTokens.length >= 0.55 && shared / slugTokens.length >= 0.45;
}
function titleFromEpisodeUrl(value) {
  try {
    const u = new URL(value);
    let slug = u.pathname.split('/').filter(Boolean).pop() || '';
    slug = slug.replace(/\.(?:html?|php)$/i, '');
    try { slug = decodeURIComponent(slug); } catch {}
    return clean(slug.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ')).replace(/\b\w/g, c => c.toUpperCase());
  } catch { return ''; }
}

function blocked(item) {
  return MINOR_TERMS.test([item.name, item.description, ...(item.genres || [])].join(' '));
}
function isNoise(url) {
  return /\.(?:jpe?g|png|gif|webp|svg|css|js|ico|woff2?)(?:[?#]|$)|wp-json|wp-content|gravatar|schema\.org/i.test(url || '');
}
async function getHtml(url, referer) {
  return cached(`html:${url}|ref:${referer || ''}`, CATALOG_TTL, async () => {
    const response = await http.get(url, { headers: referer ? { Referer: referer } : {}, responseType: 'text' });
    return String(response.data || '');
  });
}
async function getHtmlFresh(url, referer, extraHeaders = {}, timeoutOverride) {
  const headers = { ...extraHeaders };
  if (referer) headers.Referer = referer;
  const timeout = Number(timeoutOverride || 0);
  const response = await http.get(url, {
    headers,
    responseType: 'text',
    ...(timeout > 0 ? { timeout } : {}),
  });
  return String(response.data || '');
}

function metaText($, selectors) {
  for (const selector of selectors) {
    const n = $(selector).first();
    const value = clean(n.attr('content') || n.text());
    if (value) return value;
  }
  return '';
}
function cardPoster($, $card, $a, base) {
  const candidates = [];
  const $img = ($card.find('img').first().length ? $card.find('img').first() : $a.find('img').first());
  if ($img.length) {
    for (const key of ['data-src', 'data-lazy-src', 'data-original', 'data-original-src', 'data-lazy', 'data-image', 'data-cfsrc', 'data-thumb', 'data-poster', 'poster', 'src']) {
      const value = $img.attr(key);
      if (value) candidates.push(value);
    }
    for (const key of ['data-srcset', 'data-lazy-srcset', 'srcset']) {
      const value = $img.attr(key);
      if (value) candidates.push(...value.split(',').map(part => clean(part).split(/\s+/)[0]).filter(Boolean));
    }
  }
  const $source = $card.find('source[srcset], source[src], video[poster]').first();
  for (const key of ['data-src', 'src', 'poster']) {
    const value = $source.attr(key);
    if (value) candidates.push(value);
  }
  if ($source.attr('srcset')) candidates.push(...$source.attr('srcset').split(',').map(part => clean(part).split(/\s+/)[0]).filter(Boolean));
  const $styled = $card.find('[style*="background-image"], [style*="background:"]').first();
  const style = $styled.attr('style') || $card.attr('style') || $a.attr('style') || '';
  const match = style.match(/background(?:-image)?\s*:\s*[^;]*?url\(["']?([^"')]+)["']?\)/i);
  if (match) candidates.push(match[1]);
  for (const candidate of candidates) {
    const resolved = absUrl(candidate, base);
    if (resolved) return resolved;
  }
  return '';
}
function parseStructuredCards($, base) {
  const out = [];
  const seen = new Set();
  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try { data = JSON.parse($(el).contents().text() || $(el).text()); } catch { return; }
    const walk = value => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(walk); return; }
      const type = Array.isArray(value['@type']) ? value['@type'].join(' ') : String(value['@type'] || '');
      if (/VideoObject|Movie|TVEpisode|CreativeWork/i.test(type)) {
        const rawUrl = value.url || value['@id'] || value.embedUrl;
        const key = absUrl(typeof rawUrl === 'object' ? (rawUrl.url || rawUrl['@id']) : rawUrl, base);
        const imageValue = Array.isArray(value.image) ? value.image[0] : (value.image || value.thumbnailUrl || value.thumbnail || value.poster);
        const poster = absUrl(typeof imageValue === 'object' ? (imageValue.url || imageValue.contentUrl || imageValue['@id']) : imageValue, base);
        const name = clean(value.name || value.headline);
        const item = { key, name, poster, genres: Array.isArray(value.genre) ? value.genre.map(clean) : value.genre ? [clean(value.genre)] : [], description: clean(value.description) };
        if (key && name && poster && !seen.has(key) && !blocked(item) && !isNoise(key)) {
          try {
            if (sameProviderHost(key, base)) {
              seen.add(key); out.push(item);
            }
          } catch {}
        }
      }
      for (const [key, child] of Object.entries(value)) if (key !== '@context') walk(child);
    };
    walk(data);
  });
  return out;
}

function parseCards(html, base) {
  const $ = cheerio.load(html);
  const out = parseStructuredCards($, base);
  const seen = new Set(out.map(item => item.key));
  const selectors = ['article a[href]', '.video-item a[href]', '.video-card a[href]', '[class*="video-card"] a[href]', '[class*="video-item"] a[href]', '.movie-item a[href]', '[class*="movie-item"] a[href]', '.video a[href]', '.item a[href]', '.thumb a[href]', '.thumb-block a[href]', '.post a[href]', '.result-item a[href]', '.animposx a[href]', '.bs a[href]', '.entry a[href]', '.grid-item a[href]', '.movie a[href]', 'li a[href]', 'a[href]'];
  for (const selector of selectors) {
    $(selector).each((_, el) => {
      const $a = $(el);
      const href = absUrl($a.attr('href'), base);
      if (!href || seen.has(href) || isNoise(href)) return;
      let parsed;
      try { parsed = new URL(href); } catch { return; }
      if (!sameProviderHost(href, base)) return;
      if (/\/(?:page|genre|genres|category|tag|author|search|login|register|contact|about)(?:\/|$)/i.test(parsed.pathname)) return;
      const $closest = $a.closest('article,.video-item,.video-card,[class*=\"video-card\"],[class*=\"video-item\"],.movie-item,[class*=\"movie-item\"],.video,.item,.thumb,.thumb-block,.post,.result-item,.animposx,.bs,.entry,.grid-item,.movie,li');
      const $card = $closest.length ? $closest : $a;
      const poster = cardPoster($, $card, $a, base);
      if (!poster) return;
      const name = clean($card.find('.title,.tt,.entry-title,.video-title,.name,h2,h3,h4').first().text()) || clean($a.attr('title')) || clean($a.find('img').first().attr('alt')) || clean($a.text());
      if (!name || name.length < 2 || /^(watch|play|view|more|next|previous)$/i.test(name)) return;
      const genres = $card.find('.genre a,.genres a,.sgeneros a,a[rel="tag"],.tags a,a[href*="/genre/"],a[href*="/tag/"]').map((__, tag) => clean($(tag).text())).get().filter(Boolean).slice(0, 16);
      const description = clean($card.find('.description,.excerpt,.summary').first().text());
      const item = { key: href, name, poster, genres, description };
      if (blocked(item)) return;
      seen.add(href);
      out.push(item);
    });
    if (out.length >= PAGE_LIMIT) break;
  }
  return out;
}
function pagePath(base, path, page) {
  const root = base.replace(/\/$/, '');
  const p = path || '/';
  if (page <= 1) return `${root}${p.startsWith('/') ? p : `/${p}`}`;
  const route = `${root}${p.startsWith('/') ? p : `/${p}`}`;
  if (/\.html?$/i.test(route)) return route.replace(/\.html?$/i, '') + `-${page}.html`;
  return `${route}${p.endsWith('/') ? '' : '/'}page/${page}/`;
}
function genreSlug(config, genre) {
  const raw = clean(genre).toLowerCase();
  const aliases = {
    hentaimama: {
      'big breasts': 'large-breasts', 'dark skin': 'dark-skin', 'monster': 'monsters', 'deep throat': 'deepthroat', 'internal cumshot': 'internal-cumshot',
      'netorare': 'ntr', 'office lady': 'office-ladies', 'school': 'school-girls',
      'tentacle': 'tentacles', 'threesome': 'three-some', 'virgin': 'virgins',
      'succubus': 'succubus', 'maid': 'maid', 'sci-fi': 'sci-fi',
    },
    hentaismile: {
      'big breasts': 'big-tits', 'office lady': 'office-lady', 'netorare': 'ntr',
      'school': 'school', 'tentacle': 'tentacles', 'threesome': '3some',
      'virgin': 'virgins', 'group': 'group', 'monster': 'monster',
    },
  };
  return (aliases[config.id] && aliases[config.id][raw]) || slugify(genre);
}
function candidatePagesEnhanced(config, { search, genre, page = 1 }) {
  const base = config.base.replace(/\/$/, '');
  const n = Math.max(1, Number(page) || 1);
  const q = encodeURIComponent(clean(search));
  const g = genreSlug(config, genre);

  if (config.id === 'hentaismile') {
    if (search) {
      const searchRoutes = [
        `${base}/search/${q.replace(/%20/g, '+')}/${n > 1 ? `page/${n}/` : ''}`,
        `${base}/?s=${q}${n > 1 ? `&page=${n}` : ''}`,
        `${base}/?search=${q}${n > 1 ? `&page=${n}` : ''}`,
        ...(config.searchPaths || []).map(path => `${base}${path.replace('{q}', q).replace('{page}', n)}`),
      ];
      return [...new Set(searchRoutes)];
    }
    if (genre) {
      const root = `${base}/tags/${g}/`;
      if (n === 1) return [...new Set([root, `${base}/tag/${g}/`, `${base}/category/${g}/`])];
      return [...new Set([
        `${root}?page=${n}`, `${root}?p=${n}`, `${root}?paged=${n}`,
        `${base}/tags/${g}/page/${n}/`, `${base}/tags/${g}/${n}/`,
        `${base}/tag/${g}/page/${n}/`, `${base}/category/${g}/page/${n}/`,
      ])];
    }
    const root = `${base}/latest-updates/`;
    if (n === 1) return [...new Set([root, `${base}/`])];
    return [...new Set([
      `${root}?page=${n}`, `${root}?p=${n}`, `${root}?paged=${n}`,
      `${root}page/${n}/`, `${root}${n}/`, `${root}page-${n}/`,
      `${base}/?page=${n}`, `${base}/?p=${n}`,
    ])];
  }

  if (search) {
    return [...new Set([
      `${base}/?s=${q}${n > 1 ? `&paged=${n}` : ''}`,
      `${base}/?search=${q}${n > 1 ? `&page=${n}` : ''}`,
      `${base}/search/${q.replace(/%20/g, '+')}/${n > 1 ? `page/${n}/` : ''}`,
      ...(config.searchPaths || []).map(path => `${base}${path.replace('{q}', q).replace('{page}', n)}`),
    ])];
  }
  if (genre) {
    // HentaiMama's 3D archive is /genre/3d/, not /3d/. Uncensored is a top-level archive.
    const paths = config.id === 'hentaimama' && g === 'uncensored'
      ? ['/uncensored/']
      : (config.genrePaths || ['/genre/{g}/', '/tag/{g}/', '/category/{g}/']);
    return [...new Set(paths.flatMap(path => {
      const route = `${base}${path.replace('{g}', g)}`;
      if (n === 1) return [route];
      if (/\.html?$/i.test(route)) return [route.replace(/\.html?$/i, '') + `-${n}.html`, `${route}?page=${n}`];
      return [pagePath(base, path.replace('{g}', g), n), `${route}?page=${n}`, `${route}?paged=${n}`];
    }))];
  }
  return [...new Set((config.listPaths || ['/']).flatMap(path => {
    const route = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    if (n === 1) return [route];
    if (/\.html?$/i.test(route)) return [route.replace(/\.html?$/i, '') + `-${n}.html`, `${route}?page=${n}`, `${route}?paged=${n}`];
    return [pagePath(base, path, n), `${route}?page=${n}`, `${route}?paged=${n}`];
  }))];
}
function candidatePagesLegacy(config, { search, genre, page }) {
  const base = config.base.replace(/\/$/, '');
  if (search) {
    const q = encodeURIComponent(search);
    return [...new Set([
      `${base}/?s=${q}${page > 1 ? `&paged=${page}` : ''}`,
      `${base}/?search=${q}${page > 1 ? `&page=${page}` : ''}`,
      `${base}/search/${q.replace(/%20/g, '+')}/${page > 1 ? `page/${page}/` : ''}`,
      ...(config.searchPaths || []).map(path => `${base}${path.replace('{q}', q).replace('{page}', page)}`),
    ])];
  }
  if (genre) {
    const g = slugify(genre);
    return [...new Set((config.genrePaths || ['/genre/{g}/', '/tag/{g}/', '/category/{g}/']).flatMap(path => {
      const route = `${base}${path.replace('{g}', g)}`;
      return page > 1 ? [pagePath(base, path.replace('{g}', g), page), `${route}${route.includes('?') ? '&' : '?'}page=${page}`, `${route}${route.includes('?') ? '&' : '?'}paged=${page}`] : [route];
    }))];
  }
  return [...new Set((config.listPaths || ['/']).flatMap(path => {
    const route = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    if (page <= 1) return [route];
    const queryPath = `${route}${route.includes('?') ? '&' : '?'}page=${page}`;
    const pagedPath = `${route}${route.includes('?') ? '&' : '?'}paged=${page}`;
    return [pagePath(base, path, page), queryPath, pagedPath];
  }))];
}
function candidatePages(config, args) {
  if (config.id === 'hentaigasm') return candidatePagesLegacy(config, args);
  return candidatePagesEnhanced(config, args);
}

function tightCard($, $a, base, providerId) {
  const itemLinks = providerId === 'hentaismile' ? 'a[href*="/videos/"]' : 'a[href]';
  let node = $a.parent();
  for (let depth = 0; depth < 6 && node.length; depth++, node = node.parent()) {
    const hasPoster = node.find('img[src],img[data-src],img[data-original],img[data-lazy-src],img[srcset],[style*="background-image"]').length > 0;
    const count = node.find(itemLinks).length;
    const classes = `${node.attr('class') || ''} ${node.attr('id') || ''}`;
    const looksLikeItem = /(?:^|[\s_-])(?:video-item|video-card|video-thumb|thumb-block|thumb|movie-item|item|post|entry|bs|bsx|card)(?:$|[\s_-])/i.test(classes) || node.is('article,li');
    if (hasPoster && count > 0 && count <= 3 && (looksLikeItem || depth >= 1)) return node;
  }
  return $a.parent().length ? $a.parent() : $a;
}
function parseHentaiSmileCards(html, base) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('a[href*="/videos/"]').each((_, el) => {
    const $a = $(el);
    const rawUrl = absUrl($a.attr('href'), base);
    if (!rawUrl || !sameProviderHost(rawUrl, base)) return;
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return; }
    if (!/^\/videos\/\d+\/[^/]+\/?$/i.test(parsed.pathname)) return;
    const key = canonicalContentUrl('hentaismile', rawUrl, base);
    if (!key || seen.has(key)) return;
    const $knownCard = $a.closest('article,.video-item,.video-card,.video-thumb,.thumb-block,.thumb,.item,.post,.entry,li');
    const $box = $knownCard.length ? $knownCard : tightCard($, $a, base, 'hentaismile');
    const poster = cardPoster($, $box, $a, base);
    const titleSelectors = '.video-title,.title,.video-name,.name,h2,h3,h4,[data-title]';
    const rawName = clean($box.find(titleSelectors).first().attr('data-title') || $box.find(titleSelectors).first().text());
    const imageAlt = clean($box.find('img').first().attr('alt'));
    const anchorTitle = clean($a.attr('title') || $a.attr('aria-label'));
    const anchorText = clean($a.text());
    const slugTitle = titleFromUrl(key, 'hentaismile');
    const candidates = [anchorTitle, imageAlt, rawName, anchorText].map(cleanVideoTitle).filter(v =>
      v && v.length > 2 && !/^(?:image|thumbnail|watch|play|video|no title found|title not found|untitled|unknown)$/i.test(v)
    );
    // Reject titles borrowed from a neighbouring card. KVS-style source URLs include
    // the video slug, so the displayed title must share meaningful words with it.
    let name = candidates.find(v => !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(v) && hentaiSmileTitleMatchesSlug(v, slugTitle)) || slugTitle;
    name = cleanVideoTitle(name) || slugTitle;
    if (!poster || !name || blocked({ name })) return;
    seen.add(key);
    out.push({ key, name, poster, genres: [], description: clean($box.find('.description,.excerpt').first().text()) });
    if (out.length >= PAGE_LIMIT) return false;
  });
  return out;
}
function parseHentaiMamaGenreCards(html, base) {
  const $ = cheerio.load(html);
  const out = [];
  const seenKeys = new Set();
  const seenTitles = new Set();
  $('a[href]').each((_, el) => {
    const $a = $(el);
    const raw = absUrl($a.attr('href'), base);
    if (!raw || !sameProviderHost(raw, base)) return;
    let parsed;
    try { parsed = new URL(raw); } catch { return; }
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    if (path === '/' || /^\/(?:episodes?|genre|genres|tag|category|recent-episodes|list|uncensored|login|register|wp-admin|wp-content|wp-json)(?:\/|$)/i.test(path)) return;
    const key = canonicalContentUrl('hentaimama', raw, base);
    if (!key || seenKeys.has(key)) return;
    const $card = $a.closest('article,.bs,.bsx,.item,.video-item,.video-card,.thumb,.thumb-block,.post,[class*="item"],[class*="series"],li');
    const $box = $card.length ? $card : ($a.parent().length ? $a.parent() : $a);
    const poster = cardPoster($, $box, $a, base);
    if (!poster) return;
    const candidates = [
      clean($box.find('.tt,.title,.entry-title,.name,h2,h3,h4,[class*="title"]').first().text()),
      clean($a.attr('title') || $a.attr('aria-label')),
      clean($a.find('img').first().attr('alt')),
      clean($a.text()),
      titleFromUrl(key, 'hentaimama'),
    ];
    let name = candidates.find(v => v && v.length > 2 && !/^(image|thumbnail|watch|play|view)$/i.test(v)) || '';
    name = clean(name.replace(/\s+(?:episode|ep)\s*#?\d+.*$/i, ''));
    const titleKey = normalizedTextKey(name);
    const posterKey = String(poster).split('?')[0].replace(/^https?:\/\/(?:www\.)?/i, '').toLowerCase();
    const dedupe = `${titleKey}|${posterKey}`;
    if (!name || blocked({ name }) || seenTitles.has(dedupe)) return;
    seenKeys.add(key); seenTitles.add(dedupe);
    out.push({ key, name, poster, genres: [...new Set($box.find('.genre a,.genres a,.tags a,a[rel="tag"]').map((__, tag) => clean($(tag).text())).get().filter(Boolean))].slice(0, 16), description: clean($box.find('.description,.excerpt,.summary').first().text()) });
    if (out.length >= PAGE_LIMIT) return false;
  });
  return out;
}
function parseHentaiMamaRecentEpisodeCards(html, base) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('a[href*="/episodes/"]').each((_, el) => {
    const $a = $(el);
    const raw = absUrl($a.attr('href'), base);
    if (!raw || !sameProviderHost(raw, base)) return;
    let parsed; try { parsed = new URL(raw); } catch { return; }
    if (!/^\/episodes\/[^/]+\/?$/i.test(parsed.pathname)) return;
    const key = canonicalContentUrl('hentaimama', raw, base);
    if (!key || seen.has(key)) return;
    const $card = $a.closest('article,.bs,.bsx,.item,.video-item,.video-card,.thumb,.thumb-block,.post,[class*="item"],li');
    const $box = $card.length ? $card : ($a.parent().length ? $a.parent() : $a);
    const poster = cardPoster($, $box, $a, base);
    if (!poster) return;
    const urlTitle = titleFromEpisodeUrl(key);
    const candidates = [
      clean($a.attr('title') || $a.attr('aria-label')),
      clean($a.text()),
      clean($box.find('img').first().attr('alt')),
      clean($box.find('.episode-title,.tt,.title,.entry-title,.name,h2,h3,h4,[class*="title"]').first().text()),
      urlTitle,
    ].map(cleanVideoTitle).filter(v => v && v.length > 2 && !/^(image|thumbnail|watch|play|view)$/i.test(v));
    const name = candidates.find(v => /\b(?:episode|ep)\s*#?\d+\b/i.test(v)) || urlTitle || candidates[0] || '';
    if (!name || blocked({ name })) return;
    seen.add(key);
    out.push({ key, name, poster, genres: [], description: clean($box.find('.description,.excerpt,.summary').first().text()) });
    if (out.length >= PAGE_LIMIT) return false;
  });
  return out;
}

function parseProviderCards(config, html, base) {
  if (config.id === 'hentaigasm') return parseCards(html, base);
  if (config.id === 'hentaismile') return parseHentaiSmileCards(html, base);
  if (config.id === 'hentaimama') {
    const path = new URL(base).pathname;
    if (/\/genre\//i.test(path) || /^\/uncensored\/?$/i.test(path)) return parseHentaiMamaGenreCards(html, base);
    if (/\/recent-episodes(?:\/|$)/i.test(path)) return parseHentaiMamaRecentEpisodeCards(html, base);
  }
  return parseCards(html, base).map(item => ({ ...item, key: canonicalContentUrl(config.id, item.key, base) || item.key }));
}
function catalogPageFingerprint(items) {
  return (items || []).map(item => `${normalizedTextKey(item.name)}|${String(item.poster || '').split('?')[0].replace(/^https?:\/\/(?:www\.)?/i, '').toLowerCase()}`).sort().join('\n');
}
function discoverPaginationUrls(html, base, targetPage, providerId) {
  const $ = cheerio.load(html);
  const candidates = [];
  const target = String(targetPage);
  $('a[href], link[rel="next"]').each((_, el) => {
    const $a = $(el);
    const raw = absUrl($a.attr('href'), base);
    if (!raw || !sameProviderHost(raw, base) || raw.split('#')[0] === String(base).split('#')[0]) return;
    let url;
    try { url = new URL(raw); } catch { return; }
    const text = clean($a.text());
    const aria = clean($a.attr('aria-label') || $a.attr('title') || '');
    const isNumericTarget = text === target || new RegExp(`^page\\s*${target}$`, 'i').test(aria) || new RegExp(`^${target}\\s*(?:of|/)\\s*\\d+$`, 'i').test(text);
    const isNextLink = /^(?:next|next page|›|»|→)$/i.test(text) || /next/i.test(aria) || String($a.attr('rel') || '').toLowerCase() === 'next';
    if (!isNumericTarget && !(isNextLink && targetPage === 2)) return;
    const path = url.pathname.toLowerCase();
    if (providerId === 'hentaismile' && /\/videos\/\d+\//i.test(path)) return;
    if (providerId === 'hentaimama' && /\/episodes\//i.test(path)) return;
    if (/\/(?:login|register|sign-up|wp-admin|wp-json)\//i.test(path)) return;
    const parents = $a.parents().toArray().slice(0, 5).map(node => `${node.attribs?.class || ''} ${node.attribs?.id || ''}`).join(' ');
    const score = (isNumericTarget ? 10 : 0) + (/pagination|pager|page-nav|pages-list|nav-links/i.test(`${parents} ${$a.attr('class') || ''}`) ? 5 : 0);
    candidates.push({ url: url.href, score });
  });
  const seen = new Set();
  return candidates.sort((a, b) => b.score - a.score).map(x => x.url).filter(url => !seen.has(url) && seen.add(url));
}
async function fetchCatalog(config, args) {
  let lastError;
  let reachedPage = false;
  const tried = [];
  let firstPageFingerprint = '';
  if ((Number(args.page) || 1) > 1) {
    const firstPageUrl = candidatePages(config, { ...args, page: 1 })[0];
    try { firstPageFingerprint = catalogPageFingerprint(parseProviderCards(config, await getHtml(firstPageUrl, config.base), firstPageUrl)); } catch { /* First page may have become unavailable. */ }
  }
  const seenOnPage = new Set();
  let candidates = candidatePages(config, args);
  const requestedPage = Math.max(1, Number(args.page) || 1);
  if (requestedPage > 1 && config.id !== 'hentaigasm') {
    const firstPageCandidates = candidatePages(config, { ...args, page: 1 });
    for (const firstUrl of firstPageCandidates.slice(0, 3)) {
      try {
        const firstHtml = await getHtml(firstUrl, config.base);
        const discovered = discoverPaginationUrls(firstHtml, firstUrl, requestedPage, config.id);
        if (discovered.length) {
          candidates = [...discovered, ...candidates].filter((url, index, all) => all.indexOf(url) === index);
          break;
        }
      } catch { /* Fall back to the provider-specific route candidates. */ }
    }
  }
  for (const url of candidates) {
    tried.push(url);
    try {
      const html = await getHtml(url, config.base);
      reachedPage = true;
      const parsed = parseProviderCards(config, html, url);
      const items = [];
      for (const item of parsed) {
        const key = canonicalContentUrl(config.id, item.key, url) || item.key;
        const dedupeKey = config.id === 'hentaimama'
          ? `${normalizedTextKey(item.name)}|${String(item.poster || '').split('?')[0].toLowerCase()}`
          : key;
        if (!key || seenOnPage.has(dedupeKey)) continue;
        seenOnPage.add(dedupeKey);
        items.push({ ...item, key });
      }
      // Some sites silently serve page 1 for an invalid page URL. Do not return the same page again.
      if ((Number(args.page) || 1) > 1 && items.length && firstPageFingerprint && catalogPageFingerprint(items) === firstPageFingerprint) continue;
      if (items.length) return items;
    } catch (e) {
      lastError = e;
      // A 404 for one guessed route is normal; continue through the known candidates.
    }
  }
  if (!reachedPage && lastError) throw lastError;
  if (!reachedPage) console.warn(`[${config.name}] no candidate page could be fetched: ${tried.join(' | ')}`);
  else console.warn(`[${config.name}] pages fetched but parser found 0 eligible cards for page ${Math.max(1, Number(args.page) || 1)}${args.genre ? `, genre ${args.genre}` : ''}${args.search ? ', search request' : ''}`);
  return [];
}

async function pageMeta(url, config) {
  const html = await getHtml(url, config.base);
  const $ = cheerio.load(html);
  const hentaimamaTitle = config.id === 'hentaimama' ? clean($('input[name="title"]').first().attr('value')) : '';
  const name = hentaimamaTitle || metaText($, ['meta[property="og:title"]', 'meta[name="twitter:title"]', 'h1', 'title']) || (config.id === 'hentaigasm' ? '' : titleFromUrl(url, config.id));
  const metaPoster = metaText($, ['meta[property="og:image"]', 'meta[name="twitter:image"]']);
  const poster = absUrl(metaPoster || (config.id === 'hentaimama' ? $('div.imagen img').first().attr('src') : ''), url);
  const description = metaText($, ['meta[property="og:description"]', 'meta[name="description"]']) || clean($('.entry-content p,.content p,.description p,.wp-content p,.summary').first().text());
  const genres = [...new Set($('.sgeneros a,.genres a,.genre a,a[rel="tag"],.tags a,[class*="genre"] a,a[href*="/genre/"],a[href*="/tag/"]').map((_, el) => clean($(el).text())).get().filter(x => x && x.length < 40))].slice(0, 20);
  const episodes = [];
  const seen = new Set();
  const hentaimamaEpisodePage = config.id === 'hentaimama' && /\/episodes\//i.test(new URL(url).pathname);
  const episodeSelector = config.id === 'hentaimama'
    ? 'a[href*="/episodes/"]'
    : '.episodes a[href],#episodes a[href],.episodios a[href],.episode-list a[href],.playlist a[href],.eplist a[href],[class*="episode-list"] a[href]';
  if (!hentaimamaEpisodePage) $(episodeSelector).each((_, el) => {
    const $a = $(el); const key = config.id === 'hentaigasm' ? absUrl($a.attr('href'), url) : canonicalContentUrl(config.id, $a.attr('href'), url); const title = clean($a.text() || $a.attr('title'));
    const currentKey = config.id === 'hentaigasm' ? url : canonicalContentUrl(config.id, url, url);
    if (!key || key === currentKey || seen.has(key) || !title || isNoise(key)) return;
    if (config.id === 'hentaimama' && !/\/episodes\//i.test(new URL(key).pathname)) return;
    seen.add(key); episodes.push({ key, title });
  });
  return { name: name || config.name, poster, background: poster, description, genres, episodes };
}
function normalizePlayerText(value) {
  return String(value || '')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&').replace(/\\u003d/gi, '=')
    .replace(/\\u003a/gi, ':').replace(/\\u002f/gi, '/')
    .replace(/\\x3a/gi, ':').replace(/\\x2f/gi, '/')
    .replace(/&amp;/gi, '&').replace(/&#038;/g, '&').replace(/&quot;/g, '"');
}

const MEDIA_URL_RE = /\.(?:m3u8|mp4|m4v|mpd|webm)(?:[?#]|$)/i;
function expandEncodedPlayerText(value) {
  let source = normalizePlayerText(value)
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#0?39;/gi, "'")
    .replace(/&#x2f;/gi, '/').replace(/&#x3a;/gi, ':');
  try { source += '\n' + decodeURIComponent(source.replace(/\+/g, '%20')); } catch { /* Most source text isn't URL-encoded. */ }
  const decoded = [];
  const base64Candidates = source.match(/(?:["'`])([A-Za-z0-9+/_=-]{40,})(?:["'`])/g) || [];
  for (const wrapped of base64Candidates.slice(0, 150)) {
    const token = wrapped.slice(1, -1);
    if (token.length % 4 === 1) continue;
    try {
      const candidate = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      if (/https?:|m3u8|\.mp4|<iframe|jwplayer|source\s*[:=]|video_url/i.test(candidate) && /[\x20-\x7e]{12}/.test(candidate)) decoded.push(candidate);
    } catch { /* Ignore non-base64 strings. */ }
  }
  return source + (decoded.length ? '\n' + decoded.join('\n') : '');
}
function extractMediaLegacy(html, base = '') {
  const source = normalizePlayerText(html);
  const urls = new Set();
  const add = raw => {
    if (!raw) return;
    let candidate = String(raw).trim().replace(/[),;]+$/, '').replace(/["'\\]+$/, '');
    candidate = candidate.replace(/\\u0026/gi, '&').replace(/&amp;/gi, '&');
    const absolute = absUrl(candidate, base || 'https://invalid.local/');
    if (absolute && MEDIA_URL_RE.test(absolute) && !isNoise(absolute)) urls.add(absolute);
  };
  const absolutePattern = /https?:\\?\/\\?\/[^\s"'<>\\)]+?\.(?:m3u8|mp4|m4v|mpd|webm)(?:\?[^\s"'<>\\)]*)?/gi;
  for (const match of source.matchAll(absolutePattern)) add(match[0]);
  const configPattern = /(?:file|src|url|hls|mp4|video_url|stream_url|playlist|source)\s*["']?\s*[:=]\s*["']([^"']+)["']/gi;
  for (const match of source.matchAll(configPattern)) add(match[1]);
  if (base) {
    const $ = cheerio.load(source);
    $('video, video source, source, [data-file], [data-hls], [data-mp4]').each((_, el) => {
      const node = $(el);
      for (const key of ['src', 'data-src', 'data-file', 'data-hls', 'data-mp4']) {
        const value = node.attr(key);
        if (value && MEDIA_URL_RE.test(value)) add(value);
      }
    });
  }
  return [...urls];
}
function candidateStreamsLegacy(html, base) {
  const $ = cheerio.load(normalizePlayerText(html));
  const media = new Set(extractMediaLegacy(html, base));
  const embeds = new Set();
  const addEmbed = raw => {
    const src = absUrl(normalizePlayerText(raw), base);
    if (!src || isNoise(src) || /\.(?:jpe?g|png|gif|webp|svg)(?:[?#]|$)/i.test(src)) return;
    try { const parsed = new URL(src); if (parsed.protocol === 'http:' || parsed.protocol === 'https:') embeds.add(src); } catch {}
  };
  const rawEmbedText = normalizePlayerText(html).replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'");
  for (const match of rawEmbedText.matchAll(/<iframe\b[^>]*\b(?:src|data-src)\s*=\s*["']([^"']+)["']/gi)) addEmbed(match[1]);
  for (const match of rawEmbedText.matchAll(/(?:embed(?:_url)?|player(?:_url)?|iframe_url)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi)) addEmbed(match[1]);
  $('video source, video, source, [data-file], [data-hls], [data-mp4]').each((_, el) => {
    const node = $(el);
    for (const key of ['src', 'data-src', 'data-file', 'data-hls', 'data-mp4']) { const src = absUrl(node.attr(key), base); if (src && MEDIA_URL_RE.test(src)) media.add(src); }
  });
  $('iframe[src], iframe[data-src], [data-embed], [data-player], [data-video]').each((_, el) => {
    const node = $(el);
    for (const key of ['src', 'data-src', 'data-embed', 'data-player', 'data-video']) {
      const src = absUrl(node.attr(key), base);
      if (!src || isNoise(src) || /^(?:about:|javascript:|data:)/i.test(src)) continue;
      try { const parsed = new URL(src); if (sameProviderHost(src, base) && /\/(?:category|genre|tag|search|login|register)\//i.test(parsed.pathname)) continue; } catch { continue; }
      if (MEDIA_URL_RE.test(src)) media.add(src); else embeds.add(src);
    }
  });
  return { media: [...media], embeds: [...embeds] };
}

function extractMedia(html, base = '') {
  const source = expandEncodedPlayerText(html);
  const urls = new Set();
  const add = (raw) => {
    if (!raw) return;
    let candidate = String(raw).trim().replace(/[),;]+$/, '').replace(/["'\\]+$/, '');
    candidate = candidate.replace(/\\u0026/gi, '&').replace(/&amp;/gi, '&');
    const absolute = absUrl(candidate, base || 'https://invalid.local/');
    if (absolute && MEDIA_URL_RE.test(absolute) && !isNoise(absolute)) urls.add(absolute);
  };

  // Plain and JSON-escaped absolute URLs.
  const absolutePattern = /https?:\\?\/\\?\/[^\s"'<>\\)]+?\.(?:m3u8|mp4|m4v|mpd|webm)(?:\?[^\s"'<>\\)]*)?/gi;
  for (const match of source.matchAll(absolutePattern)) add(match[0]);

  // Common player config forms: file, src, url, hls, and source lists.
  const configPattern = /(?:file|src|url|hls|mp4|video_url|stream_url|playlist|source)\s*["']?\s*[:=]\s*["']([^"']+)["']/gi;
  for (const match of source.matchAll(configPattern)) add(match[1]);

  // HTML video tags and source tags, including relative links.
  if (base) {
    const $ = cheerio.load(source);
    $('video, video source, source, [data-file], [data-hls], [data-mp4]').each((_, el) => {
      const node = $(el);
      for (const key of ['src', 'data-src', 'data-file', 'data-hls', 'data-mp4']) {
        const value = node.attr(key);
        if (value && MEDIA_URL_RE.test(value)) add(value);
      }
    });
  }
  return [...urls];
}

function candidateStreams(html, base) {
  const expandedText = expandEncodedPlayerText(html);
  const $ = cheerio.load(expandedText);
  const media = new Set(extractMedia(expandedText, base));
  const embeds = new Set();
  const addEmbed = raw => {
    const src = absUrl(normalizePlayerText(raw), base);
    if (!src || isNoise(src) || /\.(?:jpe?g|png|gif|webp|svg)(?:[?#]|$)/i.test(src)) return;
    try {
      const parsed = new URL(src);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') embeds.add(src);
    } catch {}
  };
  // Some sites expose their player iframe only inside a textarea/input value or escaped embed-code string.
  const rawEmbedText = expandedText.replace(/&quot;/gi, '"').replace(/\\\"/g, '"');
  for (const match of rawEmbedText.matchAll(/<iframe\b[^>]*\b(?:src|data-src)\s*=\s*["']([^"']+)["']/gi)) addEmbed(match[1]);
  for (const match of rawEmbedText.matchAll(/(?:embed(?:_url)?|player(?:_url)?|iframe_url)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi)) addEmbed(match[1]);
  $('video source, video, source, [data-file], [data-hls], [data-mp4]').each((_, el) => {
    const node = $(el);
    for (const key of ['src', 'data-src', 'data-file', 'data-hls', 'data-mp4']) {
      const src = absUrl(node.attr(key), base);
      if (src && MEDIA_URL_RE.test(src)) media.add(src);
    }
  });

  // Player iframes are often one or two levels away from the actual manifest.
  $('iframe[src], iframe[data-src], [data-embed], [data-player], [data-video]').each((_, el) => {
    const node = $(el);
    for (const key of ['src', 'data-src', 'data-embed', 'data-player', 'data-video']) {
      const src = absUrl(node.attr(key), base);
      if (!src || isNoise(src) || isAdOrTracker(src) || /^(?:about:|javascript:|data:)/i.test(src)) continue;
      try {
        const parsed = new URL(src);
        if (sameProviderHost(src, base) && /\/(?:category|genre|tag|search|login|register)\//i.test(parsed.pathname)) continue;
      } catch { continue; }
      if (MEDIA_URL_RE.test(src)) media.add(src);
      else embeds.add(src);
    }
  });
  return { media: [...media], embeds: [...embeds] };
}

function hentaiSmileVideoId(pageUrl) {
  try { return new URL(pageUrl).pathname.match(/^\/(?:videos|embed)\/(\d+)(?:\/|$)/i)?.[1] || ''; }
  catch { return ''; }
}

function hentaiSmileTargetObjectSegments(script, id) {
  const source = String(script || '');
  const stack = [];
  const objects = [];
  let quote = '';
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') stack.push(i);
    else if (ch === '}' && stack.length) {
      const start = stack.pop();
      const segment = source.slice(start, i + 1);
      const hasId = new RegExp(`(?:[\"']?video_id[\"']?\\s*[:=]\\s*[\"']?${id}(?:[\"'\\s,}]|$)|[\"']?videoId[\"']?\\s*[:=]\\s*[\"']?${id}(?:[\"'\\s,}]|$))`, 'i').test(segment);
      const hasSource = /(?:video_url|video_alt_url|stream_url|\bfile\b|\bsources?\b|player_url|embed_url|iframe_url)\s*[:=]/i.test(segment);
      if (hasId && hasSource) objects.push({ start, length: i + 1 - start, segment });
    }
  }
  objects.sort((a, b) => a.length - b.length);
  return objects.map(x => x.segment);
}

function parseHentaiSmileObjectText(raw) {
  const source = String(raw || '').trim();
  try { return JSON.parse(source); } catch {}
  try {
    const jsonish = source
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1\"$2\":')
      .replace(/'/g, '\"')
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/\bundefined\b/g, 'null');
    return JSON.parse(jsonish);
  } catch { return null; }
}

function addHentaiSmileFlashvarSources(value, base, media, embeds, key = '', depth = 0, expectedVideoId = '') {
  if (depth > 8 || value == null) return;
  if (typeof value === 'string') {
    const text = normalizePlayerText(value).trim();
    if (!text) return;
    const sourceField = /^(?:file|src|source|sources|playlist|hls|mp4|video_url(?:_text|_hls)?|video_alt_url\d*(?:_text)?|stream_url|embed(?:_url)?|player(?:_url)?|iframe_url)$/i.test(key);
    if (sourceField) {
      const resolved = absUrl(text, base);
      if (resolved && MEDIA_URL_RE.test(resolved) && !isNoise(resolved) && !isAdOrTracker(resolved)) media.add(resolved);
      else if (resolved && /^(?:embed(?:_url)?|player(?:_url)?|iframe_url)$/i.test(key) && !isNoise(resolved) && !isAdOrTracker(resolved)) embeds.add(resolved);
      // Parse source fields without passing the whole HentaiSmile document through the
      // broad generic scraper, which is precisely what caused cross-title streams.
      const normalized = expandEncodedPlayerText(text);
      const urlPattern = /https?:\/\/[^\s\"'<>\\)]+?\.(?:m3u8|mp4|m4v|mpd|webm)(?:\?[^\s\"'<>\\)]*)?/gi;
      for (const match of normalized.matchAll(urlPattern)) {
        const mediaUrl = absUrl(match[0], base);
        if (mediaUrl && MEDIA_URL_RE.test(mediaUrl) && !isNoise(mediaUrl) && !isAdOrTracker(mediaUrl)) media.add(mediaUrl);
      }
      for (const frame of extractPlayerFrames(text, base)) if (!isAdOrTracker(frame)) embeds.add(frame);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) addHentaiSmileFlashvarSources(item, base, media, embeds, key, depth + 1, expectedVideoId);
    return;
  }
  if (typeof value === 'object') {
    const nestedVideoId = value.video_id ?? value.videoId ?? value.videoid;
    if (expectedVideoId && nestedVideoId != null && String(nestedVideoId) !== String(expectedVideoId)) return;
    for (const [childKey, child] of Object.entries(value)) {
      addHentaiSmileFlashvarSources(child, base, media, embeds, childKey, depth + 1, expectedVideoId);
    }
  }
}

// HentaiSmile pages often contain recommendations, ad iframes and unrelated player
// URLs in the same document. Only accept the main player, explicit embed-code field,
// or player script whose video_id matches the catalog item's numeric ID.
function extractHentaiSmileTargetConfig(html, base, expectedVideoId = '') {
  const source = normalizePlayerText(String(html || '')).replace(/&quot;/gi, '"').replace(/\\"/g, '"');
  const id = String(expectedVideoId || hentaiSmileVideoId(base) || '');
  const media = new Set();
  const embeds = new Set();
  if (!id) return { media: [], embeds: [] };

  const scripts = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  const exactVideoId = new RegExp(`[\"']?(?:video_id|videoId|videoid)[\"']?\\s*[:=]\\s*[\"']?${id}(?:[\"'\\s,}]|$)`, 'i');
  for (const script of scripts) {
    if (!exactVideoId.test(script) || !/(?:flashvars|kt_player|video_url|video_alt_url|player_config|playerConfig|jwplayer|sources?\s*[:=])/i.test(script)) continue;
    let parsedTargetObject = false;
    for (const field of ['flashvars', 'player_config', 'playerConfig', 'config']) {
      const object = extractJsObject(script, field);
      if (!object || String(object.video_id ?? object.videoId ?? object.videoid ?? '') !== id) continue;
      addHentaiSmileFlashvarSources(object, base, media, embeds, '', 0, id);
      parsedTargetObject = true;
    }
    // Some pages define multiple player configs in one script. Inspect the smallest
    // brace-delimited object that contains BOTH the chosen video ID and source fields;
    // never scan every source URL in the entire script as that can capture recs/ads.
    const targetSegments = hentaiSmileTargetObjectSegments(script, id);
    for (const segment of targetSegments) {
      const object = parseHentaiSmileObjectText(segment);
      if (object && String(object.video_id ?? object.videoId ?? object.videoid ?? '') === id) {
        addHentaiSmileFlashvarSources(object, base, media, embeds, '', 0, id);
        parsedTargetObject = true;
      }
    }
    if (!parsedTargetObject && targetSegments.length) {
      const targetSegment = targetSegments[0];
      const normalizedScript = expandEncodedPlayerText(targetSegment);
      const sourcePropertyPattern = /(?:[\"']?(?:video_url(?:_text|_hls)?|video_alt_url\d*(?:_text)?|file|src|hls|mp4|stream_url|playlist)[\"']?)\s*[:=]\s*[\"'`]([^\"'`]+)[\"'`]/gi;
      for (const match of normalizedScript.matchAll(sourcePropertyPattern)) {
        const mediaUrl = absUrl(match[1], base);
        if (mediaUrl && MEDIA_URL_RE.test(mediaUrl) && !isNoise(mediaUrl) && !isAdOrTracker(mediaUrl)) media.add(mediaUrl);
      }
      for (const frame of extractPlayerFrames(targetSegment, base)) if (!isAdOrTracker(frame)) embeds.add(frame);
    }
  }
  return { media: [...media], embeds: [...embeds] };
}

function candidateHentaiSmileStreams(html, base, expectedVideoId = '') {
  const media = new Set();
  const embeds = new Set();
  const addScopedMarkup = markup => {
    if (!markup) return;
    const found = candidateStreams(markup, base);
    for (const url of found.media) if (!isAdOrTracker(url)) media.add(url);
    for (const url of found.embeds) if (!isAdOrTracker(url)) embeds.add(url);
    for (const url of extractPlayerMedia(markup, base)) if (!isAdOrTracker(url)) media.add(url);
    for (const url of extractPlayerFrames(markup, base)) if (!isAdOrTracker(url)) embeds.add(url);
  };

  const source = normalizePlayerText(String(html || ''));
  const targetId = String(expectedVideoId || hentaiSmileVideoId(base) || '');
  if (!targetId) return { media: [], embeds: [] };
  const target = extractHentaiSmileTargetConfig(source, base, targetId);
  target.media.forEach(url => media.add(url));
  target.embeds.forEach(url => embeds.add(url));

  const $ = cheerio.load(source);
  const selectors = '#kt_player,#kt_player_inner,#video-player,#video_player,#video-player-container,#player,#player-container,.video-player,.video-player-container,.player-container,.video-container,[data-video-player]';
  const seenMarkup = new Set();
  $(selectors).each((_, el) => {
    let node = el;
    let excluded = false;
    for (let depth = 0; node && depth < 7; depth++, node = node.parent) {
      const labels = `${node.attribs?.id || ''} ${node.attribs?.class || ''} ${node.attribs?.role || ''} ${node.attribs?.['aria-label'] || ''}`;
      if (/(?:^|[\s_-])(?:ads?|advert|advertisement|related|recommendations?|sidebar|comments?|footer|header|navigation|nav|banner|promo|preview|playlist|similar)(?:$|[\s_-])/i.test(labels)) { excluded = true; break; }
    }
    if (excluded) return;
    const markup = $.html(el) || '';
    if (!markup || seenMarkup.has(markup)) return;
    if (!/(?:<iframe|<video|<source|data-(?:file|src|embed|player|hls)|video_url|video_alt_url|flashvars|jwplayer|\.m3u8|\.mp4)/i.test(markup)) return;
    seenMarkup.add(markup);
    addScopedMarkup(markup);
  });

  // HentaiSmile exposes a share/embed-code field on the video page. Accept it only
  // when the embed value includes this exact video's numeric ID.
  if (targetId) $('textarea,input,[data-embed-code]').each((_, el) => {
    const value = [$(el).attr('value'), $(el).attr('data-embed-code'), $(el).val(), $(el).text()].filter(Boolean).join('\n');
    const idInValue = new RegExp(`(?:/embed/|[?&](?:id|video_id)=|video_id["']?\\s*[:=]\\s*["']?)${targetId}(?:\\b|[/&#?"'])`, 'i');
    const hasPlayerMarkup = /<iframe|<video|\.m3u8|\.mp4|player_url|embed_url/i.test(value);
    const fieldLabel = `${$(el).attr('name') || ''} ${$(el).attr('id') || ''} ${$(el).attr('class') || ''}`;
    if (hasPlayerMarkup && idInValue.test(value) && (/(?:embed|player|video|share|code)/i.test(fieldLabel) || /<iframe/i.test(value))) addScopedMarkup(value);
  });

  return { media: [...media], embeds: [...embeds] };
}

function streamNameForUrl(providerName, url, providerId) {
  if (providerId !== 'hentaismile') return providerName;
  try { return `${providerName} · ${new URL(url).hostname.replace(/^www\./i, '')}`; }
  catch { return providerName; }
}

// Only report a resolution when the provider's source URL or player config states it.
// Never manufacture 480p/720p/1080p entries or infer them from an HLS playlist.
function qualityFromLabel(value, allowBareNumber = false) {
  const text = String(value || '');
  const dimension = text.match(/(?:^|[^0-9])\d{3,5}\s*[x×]\s*(2160|1440|1080|720|576|540|480|360|240)(?:$|[^0-9])/i);
  if (dimension) return `${dimension[1]}p`;
  const match = text.match(/(?:^|[^0-9])(2160|1440|1080|720|576|540|480|360|240)\s*p\b/i);
  if (match) return `${match[1]}p`;
  if (allowBareNumber) {
    const bare = text.trim().match(/^(2160|1440|1080|720|576|540|480|360|240)$/);
    if (bare) return `${bare[1]}p`;
  }
  return '';
}
function sourceAssignments(source) {
  const assignments = [];
  const pattern = /(?:[\"'`])?([A-Za-z_$][\w$]*)[\"'`]?\s*[:=]\s*([\"'`])([^\"'`]+)\2/g;
  for (const match of String(source || '').matchAll(pattern)) assignments.push({ key: match[1], value: match[3], index: match.index });
  return assignments;
}
function detectExplicitQuality(url, source = '') {
  try {
    const parsed = new URL(url);
    const pathQuality = qualityFromLabel(parsed.pathname);
    if (pathQuality) return pathQuality;
    for (const [key, value] of parsed.searchParams) {
      if (/(?:quality|resolution|\bres\b)/i.test(key)) {
        const quality = qualityFromLabel(value, true);
        if (quality) return quality;
      }
    }
  } catch { /* The URL is validated by streamObject; source metadata can still be checked. */ }

  let sourceText = '';
  try { sourceText = typeof source === 'string' ? source : JSON.stringify(source ?? ''); }
  catch { sourceText = String(source || ''); }
  const normalized = sourceText
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/gi, '&');
  const assignments = sourceAssignments(normalized);
  const matching = assignments.find(entry => {
    const raw = entry.value.replace(/\\\//g, '/').replace(/\\u0026/gi, '&');
    try { return new URL(raw, url).href === new URL(url).href; } catch { return raw === url; }
  });
  if (!matching) return '';

  const siblingNames = [
    `${matching.key}_text`, `${matching.key}_quality`, `${matching.key}_label`,
    `${matching.key.replace(/_url$/i, '')}_quality`, `${matching.key.replace(/_url$/i, '')}_label`,
  ];
  for (const name of siblingNames) {
    const entry = assignments.find(item => item.key.toLowerCase() === name.toLowerCase());
    if (entry) {
      const quality = qualityFromLabel(entry.value, true);
      if (quality) return quality;
    }
  }

  // For generic player configs such as {file: URL, label: '1080p'}, read only
  // explicit quality metadata belonging to the same containing object.
  const start = normalized.lastIndexOf('{', matching.index);
  const end = normalized.indexOf('}', matching.index);
  if (start >= 0 && end > matching.index && end - start <= 12000) {
    const objectText = normalized.slice(start, end + 1);
    for (const item of sourceAssignments(objectText)) {
      if (/^(?:quality|resolution|label|title|name)$/i.test(item.key)) {
        const quality = qualityFromLabel(item.value, true);
        if (quality) return quality;
      }
    }
  }
  return '';
}


// Community hentai-anime releases come from Tokyo Toshokan's dedicated Hentai (Anime) category.
// Playback uses Stremio's native BitTorrent support and resolves the info hash from
// the .torrent URL linked by its RSS feed.
const ANIRENA_BASE = (process.env.ANIRENA_BASE || 'https://www.anirena.com').replace(/\/+$/, '');
const ANIRENA_POSTER = process.env.ANIRENA_POSTER || `${ANIRENA_BASE}/favicon.ico`;
const HENTAIOCEAN_BASE = (process.env.HENTAIOCEAN_BASE || 'https://hentaiocean.com').replace(/\/+$/, '');
const HENTAIOCEAN_CONFIG = { id: 'hentaiocean', name: 'HentaiOcean', base: HENTAIOCEAN_BASE };
const TOKYOTOSHO_BASE = (process.env.TOKYOTOSHO_BASE || 'https://www.tokyotosho.info').replace(/\/+$/, '');
const TOKYOTOSHO_BASES = [...new Set([TOKYOTOSHO_BASE, 'https://www.tokyo-tosho.net', 'https://www.tokyotosho.se'])];
const TOKYOTOSHO_POSTER = process.env.TOKYOTOSHO_POSTER || `${TOKYOTOSHO_BASE}/favicon.ico`;
const TOKYOTOSHO_CATALOG_TTL = Math.max(CATALOG_TTL, Number(process.env.TOKYOTOSHO_CACHE_SECONDS || 1800) * 1000);
const TOKYOTOSHO_TRACKERS = [
  'tracker:udp://tracker.opentrackr.org:1337/announce',
  'tracker:udp://open.stealth.si:80/announce',
  'tracker:udp://tracker.torrent.eu.org:451/announce',
  'tracker:udp://exodus.desync.com:6969/announce'
];

// AniRena serves torrent details on first-party subdomains too (e.g. group-hosted
// pages). Treat the entire anirena.com family as first-party, rather than requiring
// every RSS link to use exactly www.anirena.com. This was discarding otherwise valid
// RSS records before they could reach Stremio.
function isAniRenaUrl(value, base = ANIRENA_BASE) {
  try {
    const hostname = canonicalHost(new URL(value).hostname);
    const baseHost = canonicalHost(new URL(base).hostname);
    const root = baseHost === 'anirena.com' || baseHost.endsWith('.anirena.com')
      ? 'anirena.com'
      : baseHost;
    return hostname === root || hostname.endsWith(`.${root}`);
  } catch { return false; }
}

function isHentaiOceanUrl(value, base = HENTAIOCEAN_BASE) {
  try {
    const hostname = canonicalHost(new URL(value).hostname);
    const baseHost = canonicalHost(new URL(base).hostname);
    const root = baseHost === 'hentaiocean.com' || baseHost.endsWith('.hentaiocean.com')
      ? 'hentaiocean.com'
      : baseHost;
    return hostname === root || hostname.endsWith(`.${root}`);
  } catch { return false; }
}
const ANIRENA_TRACKERS = [
  'tracker:http://tracker.anirena.com:80/announce',
  'tracker:udp://tracker-udp.anirena.com:80/announce',
  'tracker:udp://tracker.opentrackr.org:1337/announce',
  'tracker:udp://open.stealth.si:80/announce',
  'tracker:udp://tracker.torrent.eu.org:451/announce',
  'tracker:udp://exodus.desync.com:6969/announce',
];

function normalizeInfoHash(value) {
  const text = String(value || '').trim();
  const hex = text.match(/^[a-f0-9]{40}$/i);
  if (hex) return text.toUpperCase();
  const b32 = text.match(/^[a-z2-7]{32}$/i);
  if (!b32) return '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of text.toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) return '';
    bits += idx.toString(2).padStart(5, '0');
  }
  if (bits.length !== 160) return '';
  let out = '';
  for (let i = 0; i < bits.length; i += 4) out += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return out.toUpperCase();
}

function aniRenaInfoHash(value) {
  const raw = String(value || '').trim();
  const direct = normalizeInfoHash(raw);
  if (direct) return direct;
  const magnetMatch = raw.match(/urn:btih:([a-f0-9]{40}|[a-z2-7]{32})/i);
  if (magnetMatch) return normalizeInfoHash(magnetMatch[1]);
  return '';
}

function aniRenaTorrentId(value) {
  try {
    const u = new URL(String(value || ''), ANIRENA_BASE);
    const pathMatch = u.pathname.match(/\/(?:torrents?|view)\/([a-z0-9-]+)(?:\.torrent)?(?:\/|$)/i);
    if (pathMatch) return pathMatch[1].replace(/\.torrent$/i, '');
    return u.searchParams.get('id') || u.searchParams.get('torrent') || '';
  } catch { return ''; }
}

function aniRenaLooksLiveAction(title) {
  // Keep live-action JAV out even if a bad/mislabelled row leaks into the feed.
  return /(?:^|\s)\[(?:JAV|FC2(?:-?PPV)?|AVSA|IPX|IPZZ|SSIS|SONE|MIDE|MIDV|FSDSS)\b|\bFC2-?PPV-?\d+\b|\bAVSA-\d+\b/i.test(String(title || ''));
}


function communityLooksNonVideo(title) {
  // Tokyo Toshokan's Hentai (Anime) category can still contain archive uploads
  // such as doujinshi/comic ZIPs. They cannot play as video streams in Stremio.
  const value = String(title || '');
  return /\.(?:zip|rar|7z|cbz|cbr|pdf|epub|djvu|psd|jpe?g|png|webp)(?:$|[\s[(†|])/i.test(value)
    || /(?:\bcg[ _-]*集\b|\bdoujinshi\b|\bscanlation\b|\bcomic collection\b)/i.test(value);
}

function aniRenaTooLowQuality(title) {
  return /\b(?:360p|480p|540p|640x480|720x480|848x480|854x480|960x540)\b/i.test(String(title || ''));
}

function aniRenaReleaseKey(record) {
  return JSON.stringify({
    v: 1,
    hash: normalizeInfoHash(record?.hash),
    title: clean(record?.title),
    pageUrl: absUrl(record?.pageUrl, ANIRENA_BASE),
    magnetUrl: String(record?.magnetUrl || ''),
    size: clean(record?.size),
    seeders: clean(record?.seeders),
    poster: absUrl(record?.poster, ANIRENA_BASE),
  });
}

function aniRenaReleaseItem(record) {
  const title = clean(record?.title);
  const hash = aniRenaInfoHash(record?.hash || record?.magnetUrl);
  const pageUrl = absUrl(record?.pageUrl, ANIRENA_BASE);
  const magnetUrl = String(record?.magnetUrl || '');
  if (!title || blocked({ name: title }) || aniRenaLooksLiveAction(title) || communityLooksNonVideo(title) || aniRenaTooLowQuality(title)) return null;
  if (!hash && !pageUrl && !magnetUrl) return null;
  const quality = communityReleaseQuality(title);
  const poster = absUrl(record?.poster, ANIRENA_BASE) || ANIRENA_POSTER;
  const description = [quality, record?.size ? `Size ${clean(record.size)}` : '', record?.seeders ? `${clean(record.seeders)} seeders` : 'Community torrent release']
    .filter(Boolean).join(' · ');
  return {
    key: aniRenaReleaseKey({ ...record, hash, title, pageUrl, magnetUrl, poster }),
    name: title,
    poster,
    description,
    genres: ['Hentai Anime', 'Community Release', ...(quality ? [quality] : [])],
  };
}

function xmlNodeText(node) {
  const parts = [];
  const visit = current => {
    if (!current) return;
    if (current.type === 'text' && current.data) parts.push(current.data);
    for (const child of current.children || []) visit(child);
  };
  visit(node);
  return clean(parts.join(' '));
}

function xmlChildValue($item, names) {
  const wanted = new Set(names.map(name => name.toLowerCase()));
  let value = '';
  $item.children().each((_, child) => {
    const localName = String(child.name || '').split(':').pop().toLowerCase();
    if (!value && wanted.has(localName)) value = xmlNodeText(child);
  });
  return value;
}

function parseAniRenaRss(xml, base = ANIRENA_BASE) {
  const $ = cheerio.load(String(xml || ''), { xmlMode: true });
  const items = [];
  const seen = new Set();
  $('item, entry').each((_, el) => {
    const $item = $(el);
    const title = xmlChildValue($item, ['title']);
    if (!title || aniRenaLooksLiveAction(title) || aniRenaTooLowQuality(title) || blocked({ name: title })) return;
    const linkNode = $item.children().toArray().find(node => String(node.name || '').split(':').pop().toLowerCase() === 'link');
    const link = xmlChildValue($item, ['link']) || clean(linkNode?.attribs?.href);
    const guid = xmlChildValue($item, ['guid', 'id']);
    const torrentNodes = $item.children().toArray().filter(node => ['magnet', 'uri', 'enclosure', 'content'].includes(String(node.name || '').split(':').pop().toLowerCase()));
    const magnetUrl = [
      xmlChildValue($item, ['magnet', 'magneturi', 'magnetlink']),
      clean($item.find('magnet\\:uri, magneturi, magnet').first().attr('href')),
      ...torrentNodes.map(node => clean(node.attribs?.url || node.attribs?.href || xmlNodeText(node))),
    ].find(value => /^magnet:/i.test(value)) || '';
    const explicitHash = normalizeInfoHash(xmlChildValue($item, ['infohash', 'info_hash', 'info_hash_v1', 'hash', 'btih']));
    const hash = explicitHash || aniRenaInfoHash([
      magnetUrl,
      guid,
      link,
      xmlNodeText($item.find('description').first()),
    ].join(' '));
    const candidates = [link, guid].filter(Boolean);
    let pageUrl = '';
    for (const value of candidates) {
      if (/^magnet:/i.test(value)) continue;
      const resolved = absUrl(value, base);
      if (resolved && isAniRenaUrl(resolved, base)) { pageUrl = resolved; break; }
    }
    if (!pageUrl && !hash && !magnetUrl) return;
    const xmlText = xmlNodeText($item.find('description').first());
    const htmlDescription = $item.find('description').first().html() || '';
    const posterMatch = htmlDescription.match(/(?:src|url)=["']([^"']+)["']/i);
    const posterNode = $item.find('media\\:thumbnail, thumbnail, image').first();
    const poster = clean(posterNode.attr('url') || posterNode.attr('href') || (posterMatch && posterMatch[1]));
    const size = xmlChildValue($item, ['size', 'contentlength', 'length']);
    const seeders = xmlChildValue($item, ['seeders', 'seeds', 'seed']);
    const raw = { hash, title, pageUrl, magnetUrl, size, seeders, poster: absUrl(poster, base) };
    const item = aniRenaReleaseItem(raw);
    if (!item || seen.has(item.key)) return;
    seen.add(item.key);
    items.push(item);
  });
  return sortCommunityReleases(items);
}

function parseAniRenaReleaseKey(value) {
  try {
    const item = JSON.parse(String(value || ''));
    const hash = normalizeInfoHash(item?.hash);
    const title = clean(item?.title);
    const pageUrl = absUrl(item?.pageUrl, ANIRENA_BASE);
    const magnetUrl = String(item?.magnetUrl || '');
    if (item?.v !== 1 || !title || blocked({ name: title }) || aniRenaLooksLiveAction(title) || communityLooksNonVideo(title) || aniRenaTooLowQuality(title) || (!hash && !pageUrl && !magnetUrl)) return null;
    return { ...item, hash, title, pageUrl, magnetUrl };
  } catch { return null; }
}

function communityReleaseQuality(title) {
  const text = String(title || '');
  if (/\b(?:8k|4320p)\b/i.test(text)) return '4320p';
  if (/\b(?:4k|2160p|uhd)\b/i.test(text)) return '2160p';
  return qualityFromLabel(text) || '';
}

function sortCommunityReleases(items) {
  const rank = title => {
    const q = communityReleaseQuality(title);
    return q ? Number(q.replace('p', '')) : 0;
  };
  return items.sort((a, b) => {
    const qualityDiff = rank(b.name) - rank(a.name);
    if (qualityDiff) return qualityDiff;
    const seedDiff = (Number(b.description?.match(/(\d+) seeders/i)?.[1]) || 0) - (Number(a.description?.match(/(\d+) seeders/i)?.[1]) || 0);
    return seedDiff;
  });
}

function isTokyoToshoUrl(value, base = TOKYOTOSHO_BASE) {
  try {
    const host = canonicalHost(new URL(value).hostname);
    const allowed = new Set(['tokyotosho.info', 'tokyotosho.se', 'tokyo-tosho.net']);
    const baseHost = canonicalHost(new URL(base).hostname);
    return host === baseHost || allowed.has(host) || [...allowed].some(root => host.endsWith(`.${root}`));
  } catch { return false; }
}

function tokyoToshoMagnet(value) {
  const raw = String(value || '').replace(/&amp;/gi, '&').replace(/&#38;/gi, '&');
  const direct = raw.match(/magnet:\?[^\s"'<>]+/i)?.[0] || '';
  if (direct) return direct;
  const encoded = raw.match(/magnet%3A%3F[^\s"'<>]+/i)?.[0] || '';
  if (!encoded) return '';
  try { return decodeURIComponent(encoded); } catch { return encoded.replace(/%3A/ig, ':').replace(/%3F/ig, '?').replace(/%26/ig, '&').replace(/%3D/ig, '='); }
}

function tokyoToshoReleaseItem(record, base = TOKYOTOSHO_BASE) {
  const title = clean(record?.title);
  const magnetUrl = tokyoToshoMagnet(record?.magnetUrl || '');
  const hash = normalizeInfoHash(record?.hash) || aniRenaInfoHash(magnetUrl);
  const rawPageUrl = absUrl(record?.pageUrl, base);
  const rawTorrentUrl = absUrl(record?.torrentUrl, base);
  const pageUrl = rawPageUrl && isTokyoToshoUrl(rawPageUrl, base) ? rawPageUrl : '';
  const torrentUrl = rawTorrentUrl && isTokyoToshoUrl(rawTorrentUrl, base) ? rawTorrentUrl : '';
  if (!title || blocked({ name: title }) || aniRenaLooksLiveAction(title) || communityLooksNonVideo(title) || aniRenaTooLowQuality(title)) return null;
  if (!hash && !pageUrl && !torrentUrl && !magnetUrl) return null;
  const quality = communityReleaseQuality(title);
  const poster = absUrl(record?.poster, base) || TOKYOTOSHO_POSTER;
  const size = clean(record?.size);
  const seeders = clean(record?.seeders);
  const key = JSON.stringify({ v: 1, hash, title, pageUrl, torrentUrl, magnetUrl, size, seeders, poster });
  const description = [quality, size ? `Size ${size}` : '', seeders ? `${clean(seeders)} seeders` : 'Community torrent release'].filter(Boolean).join(' · ');
  return { key, name: title, poster, artworkShape: 'landscape', description, genres: ['Hentai Anime', 'Community Release', ...(quality ? [quality] : [])] };
}

function parseTokyoToshoRss(xml, base = TOKYOTOSHO_BASE) {
  const $ = cheerio.load(String(xml || ''), { xmlMode: true });
  const out = [];
  const seen = new Set();
  $('item, entry').each((_, el) => {
    const $item = $(el);
    const title = xmlChildValue($item, ['title']);
    if (!title) return;
    const nodes = $item.children().toArray();
    const localName = node => String(node?.name || '').split(':').pop().toLowerCase();
    const linkNode = nodes.find(node => localName(node) === 'link');
    const linkText = linkNode ? (xmlNodeText(linkNode) || clean(linkNode.attribs?.href)) : '';
    const guid = xmlChildValue($item, ['guid', 'id']);
    const body = [xmlChildValue($item, ['description', 'summary', 'content', 'encoded']), $item.html() || ''].join('\n');
    const magnetUrl = tokyoToshoMagnet([
      linkText, guid,
      ...nodes.filter(node => ['enclosure', 'content', 'torrent', 'magnet', 'uri'].includes(localName(node)))
        .flatMap(node => [node.attribs?.url, node.attribs?.href, xmlNodeText(node)]),
      body,
    ].filter(Boolean).join('\n'));
    const hash = aniRenaInfoHash(`${magnetUrl}\n${body}\n${guid}`);
    const rawLinks = [linkText, guid, ...(body.match(/https?:\/\/[^\s"'<>]+/g) || [])]
      .map(value => clean(value).replace(/&amp;/gi, '&'))
      .filter(value => /^https?:/i.test(value));
    const linkCandidates = [...new Set(rawLinks)];
    const firstPartyLinks = linkCandidates.map(value => absUrl(value, base)).filter(url => url && isTokyoToshoUrl(url, base));
    const torrentUrl = firstPartyLinks.find(url => /\.torrent(?:[?#]|$)|\/(?:download|torrent|dl|get)(?:\.php|\.torrent|\/|\?)/i.test(url)) || '';
    const pageUrl = firstPartyLinks.find(url => /details\.php|\/details(?:\/|$)/i.test(url) && !/\.torrent(?:[?#]|$)/i.test(url))
      || firstPartyLinks.find(url => url !== torrentUrl && !/\.torrent(?:[?#]|$)|\/(?:download|torrent|dl|get)(?:\.php|\.torrent|\/|\?)/i.test(url))
      || '';
    const mediaNode = $item.find('media\\:thumbnail, media\\:content, thumbnail, image, enclosure').first();
    const rawPoster = clean(mediaNode.attr('url') || mediaNode.attr('href') || mediaNode.attr('src'));
    const inlineImage = body.match(/(?:src|data-src)=["']([^"']+\.(?:jpe?g|png|webp)(?:\?[^"']*)?)["']/i);
    const poster = absUrl(rawPoster || (inlineImage && inlineImage[1]), base);
    const size = (body.match(/\bsize\s*:?\s*([0-9.]+\s*(?:bytes?|kb|mb|gb|tb|kib|mib|gib|tib))\b/i) || [])[1] || '';
    const seeders = (body.match(/\b(?:seeders?|seeds?)\s*:?\s*(\d+)/i) || [])[1] || '';
    const item = tokyoToshoReleaseItem({ title, hash, pageUrl, torrentUrl, magnetUrl, size, seeders, poster }, base);
    if (!item || seen.has(item.key)) return;
    seen.add(item.key);
    out.push(item);
  });
  return sortCommunityReleases(out);
}

function parseTokyoToshoCards(html, base = TOKYOTOSHO_BASE) {
  const $ = cheerio.load(String(html || ''));
  const out = [];
  const seen = new Set();
  // Tokyo Toshokan's listing is table-based, but row classes vary between
  // mirrors. Key off its Details link instead of assuming a CSS class.
  $('tr').each((_, el) => {
    const $row = $(el);
    const anchors = $row.find('a');
    const hrefs = anchors.map((__, a) => $(a).attr('href') || '').get();
    const detailHref = hrefs.find(value => /details\.php(?:\?|$)|\/details(?:\/|$)/i.test(value)) || '';
    const magnetUrl = tokyoToshoMagnet(hrefs.join('\n') + '\n' + ($row.html() || ''));
    const firstPartyLinks = hrefs.map(value => absUrl(value, base)).filter(url => url && isTokyoToshoUrl(url, base));
    const torrentUrl = firstPartyLinks.find(url => /\.torrent(?:[?#]|$)|\/(?:download|torrent|dl|get)(?:\.php|\.torrent|\/|\?)/i.test(url)) || '';
    const pageUrl = absUrl(detailHref, base) || firstPartyLinks.find(url => /details\.php|\/details(?:\/|$)/i.test(url)) || '';
    const titleAnchor = anchors.filter((__, a) => {
      const text = clean($(a).attr('title') || $(a).text());
      const href = clean($(a).attr('href'));
      return text.length > 5 && !/^(details|website|comment|magnet|download|next|previous|all|anime|hentai)$/i.test(text)
        && !/details\.php|rss\.php|customize\.php|\/login/i.test(href)
        && !/^magnet:/i.test(href);
    }).first();
    const title = clean(titleAnchor.attr('title') || titleAnchor.text());
    if (!title || (!detailHref && !magnetUrl && !torrentUrl)) return;
    const body = clean($row.text());
    const size = (body.match(/\b([0-9.]+\s*(?:bytes?|kb|mb|gb|tb|kib|mib|gib|tib))\b/i) || [])[1] || '';
    const seeders = (body.match(/\bS\s*:\s*(\d+)/i) || body.match(/\b(\d+)\s*(?:seeders?|seeds?)\b/i) || [])[1] || '';
    const rawPoster = titleAnchor.length ? cardPoster($, $row, titleAnchor, base) : '';
    const item = tokyoToshoReleaseItem({ title, magnetUrl, hash: aniRenaInfoHash(magnetUrl), pageUrl, torrentUrl, size, seeders, poster: rawPoster }, base);
    if (!item || seen.has(item.key)) return;
    seen.add(item.key);
    out.push(item);
  });
  return sortCommunityReleases(out);
}

function parseTokyoToshoReleaseKey(value) {
  try {
    const item = JSON.parse(String(value || ''));
    const title = clean(item?.title);
    const hash = normalizeInfoHash(item?.hash) || aniRenaInfoHash(item?.magnetUrl);
    const pageUrl = absUrl(item?.pageUrl, TOKYOTOSHO_BASE);
    const torrentUrl = absUrl(item?.torrentUrl, TOKYOTOSHO_BASE);
    const magnetUrl = tokyoToshoMagnet(item?.magnetUrl || '');
    if (torrentUrl && !isTokyoToshoUrl(torrentUrl)) return null;
    if (item?.v !== 1 || !title || blocked({ name: title }) || aniRenaLooksLiveAction(title) || communityLooksNonVideo(title) || aniRenaTooLowQuality(title) || (!hash && !pageUrl && !torrentUrl && !magnetUrl)) return null;
    return { ...item, title, hash, pageUrl, torrentUrl, magnetUrl };
  } catch { return null; }
}

async function fetchTokyoToshoCatalog({ search = '', genre = '', page = 1 } = {}) {
  const n = Math.max(1, Number(page) || 1);
  const query = clean(search);
  const timeout = Math.max(1800, Number(process.env.TOKYOTOSHO_TIMEOUT_MS || 2600));
  const cacheKey = `tokyotosho:hentai-anime:catalog:${n}:${normalizedTextKey(query)}`;
  const sourceItems = await cached(cacheKey, TOKYOTOSHO_CATALOG_TTL, async () => {
    const bases = [...new Set(TOKYOTOSHO_BASES)];
    const fetchText = async url => {
      const response = await http.get(url, { headers: { Referer: new URL(url).origin }, responseType: 'text', timeout });
      return String(response.data || '');
    };
    const firstNonEmpty = async (attempts, acceptItems = null) => {
      const requests = attempts.map(async attempt => {
        const items = await attempt();
        if (!items?.length || (acceptItems && !acceptItems(items))) throw new Error('empty or duplicate source page');
        return items;
      });
      try { return dedupeCommunityItems(await Promise.any(requests)); }
      catch { return []; }
    };
    const firstPageItems = n > 1 && !query ? await fetchTokyoToshoCatalog({ page: 1 }) : [];
    const firstPageNames = new Set(firstPageItems.map(item => normalizedTextKey(item.name)).filter(Boolean));
    const repeatsFirstPage = pageItems => {
      if (!firstPageNames.size || !pageItems?.length) return false;
      const names = new Set(pageItems.map(item => normalizedTextKey(item.name)).filter(Boolean));
      const shared = [...names].filter(name => firstPageNames.has(name)).length;
      return names.size > 0 && shared / names.size >= 0.72 && shared / firstPageNames.size >= 0.72;
    };
    // Start RSS and HTML concurrently. Returning the RSS immediately used to limit
    // catalog enrichment to that feed and skip the much larger category listing.
    const rssPromise = n === 1 && !query
      ? firstNonEmpty(bases.map(base => async () => {
          try { return parseTokyoToshoRss(await fetchText(`${base}/rss.php?filter=4`), base); }
          catch (error) { console.warn(`[TokyoToshokan] RSS failed (${base}): ${error.code || error.response?.status || error.message}`); return []; }
        })).catch(() => [])
      : Promise.resolve([]);
    let candidates = [];

    const categoryUrls = bases.flatMap(base => {
      if (query) return [
        `${base}/search.php?page=${n}&terms=${encodeURIComponent(query)}`,
        `${base}/search.php?terms=${encodeURIComponent(query)}&page=${n}`,
      ];
      if (n === 1) return [`${base}/index.php?cat=4`];
      return [`${base}/index.php?cat=4&page=${n}`, `${base}/index.php?page=${n}&cat=4`, `${base}/index.php?cat=4&start=${(n - 1) * 25}`];
    });
    candidates = await firstNonEmpty(categoryUrls.map(url => async () => {
      try {
        const html = await fetchText(url);
        return parseTokyoToshoCards(html, new URL(url).origin);
      } catch (error) {
        console.warn(`[TokyoToshokan] category page failed (${url}): ${error.code || error.response?.status || error.message}`);
        return [];
      }
    }), pageItems => !(n > 1 && !query && repeatsFirstPage(pageItems)));

    // If pagination parameters changed, follow links advertised by the real category page.
    if (!candidates.length && n > 1 && !query) {
      const firstPages = await Promise.allSettled(bases.map(async base => {
        const url = `${base}/index.php?cat=4`;
        const html = await fetchText(url);
        return { base, html, url };
      }));
      const pageLinks = firstPages.filter(result => result.status === 'fulfilled').flatMap(result => {
        const { base, html, url } = result.value;
        return discoverPaginationUrls(html, url, n, 'tokyotosho').slice(0, 2).map(link => ({ base, link }));
      });
      const discovered = await Promise.allSettled(pageLinks.map(async ({ base, link }) => parseTokyoToshoCards(await fetchText(link), base)));
      candidates = dedupeCommunityItems(discovered.filter(result => result.status === 'fulfilled').flatMap(result => result.value || []));
    }
    if (n > 1 && !query && candidates.length) {
      try {
        const firstPageItems = await fetchTokyoToshoCatalog({ page: 1 });
        const firstFingerprint = catalogPageFingerprint(firstPageItems);
        if (firstFingerprint && catalogPageFingerprint(candidates.slice(0, PAGE_SIZE)) === firstFingerprint) {
          const firstPages = await Promise.allSettled(bases.map(async base => {
            const url = `${base}/index.php?cat=4`;
            const html = await fetchText(url);
            return { base, url, html };
          }));
          const pageLinks = firstPages.filter(result => result.status === 'fulfilled').flatMap(result => {
            const { base, url, html } = result.value;
            return discoverPaginationUrls(html, url, n, 'tokyotosho').slice(0, 2).map(link => ({ base, link }));
          });
          const discovered = await Promise.allSettled(pageLinks.map(async ({ base, link }) => parseTokyoToshoCards(await fetchText(link), base)));
          const discoveredItems = dedupeCommunityItems(discovered.filter(result => result.status === 'fulfilled').flatMap(result => result.value || []));
          if (discoveredItems.length && catalogPageFingerprint(discoveredItems.slice(0, PAGE_SIZE)) !== firstFingerprint) candidates = discoveredItems;
          else candidates = [];
        }
      } catch { /* Page parameters may legitimately have produced a distinct page already. */ }
    }
    if (n === 1 && !query) {
      const rssItems = await rssPromise;
      candidates = dedupeCommunityItems([...rssItems, ...candidates]);
    }
    return candidates;
  });

  let items = [...sourceItems];
  const normalizedQuery = normalizedTextKey(query);
  if (normalizedQuery) items = items.filter(item => normalizedTextKey(item.name).includes(normalizedQuery));
  if (genre) {
    const wanted = clean(genre).toLowerCase();
    if (/\d{3,4}p|4k|uhd/i.test(wanted)) {
      const quality = wanted === '4k' || wanted === 'uhd' ? '2160p' : wanted;
      items = items.filter(item => communityReleaseQuality(item.name).toLowerCase() === quality);
    } else items = items.filter(item => (item.genres || []).some(value => value.toLowerCase().includes(wanted)) || item.name.toLowerCase().includes(wanted));
  }
  return items.slice(0, PAGE_SIZE);
}

function dedupeCommunityItems(items) {
  const out = [];
  const seen = new Set();
  for (const item of items || []) {
    if (!item?.key || !item.name) continue;
    let parsed = item;
    try { parsed = JSON.parse(item.key); } catch {}
    const id = normalizeInfoHash(parsed.hash) || aniRenaInfoHash(parsed.magnetUrl) || String(parsed.torrentUrl || parsed.pageUrl || item.name).toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return sortCommunityReleases(out);
}

function bencodeValueEnd(buffer, start) {
  if (start < 0 || start >= buffer.length) return -1;
  const token = buffer[start];
  // byte string: <length>:<raw bytes>
  if (token >= 48 && token <= 57) {
    let colon = start;
    while (colon < buffer.length && buffer[colon] !== 58) colon++;
    if (colon >= buffer.length) return -1;
    const lengthText = buffer.toString('ascii', start, colon);
    if (!/^\d+$/.test(lengthText)) return -1;
    const end = colon + 1 + Number(lengthText);
    return end <= buffer.length ? end : -1;
  }
  // integer: i...e
  if (token === 105) {
    const end = buffer.indexOf(101, start + 1);
    return end < 0 ? -1 : end + 1;
  }
  // list/dictionary: l...e or d...e; dictionary keys are byte strings.
  if (token === 108 || token === 100) {
    let pos = start + 1;
    while (pos < buffer.length && buffer[pos] !== 101) {
      const next = bencodeValueEnd(buffer, pos);
      if (next <= pos) return -1;
      pos = next;
      if (token === 100) {
        const valueEnd = bencodeValueEnd(buffer, pos);
        if (valueEnd <= pos) return -1;
        pos = valueEnd;
      }
    }
    return pos < buffer.length ? pos + 1 : -1;
  }
  return -1;
}

function torrentFileInfoHash(value) {
  let buffer;
  try { buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || ''); } catch { return ''; }
  if (buffer.length < 8 || buffer[0] !== 100) return '';
  let pos = 1;
  while (pos < buffer.length && buffer[pos] !== 101) {
    const keyStart = pos;
    const keyEnd = bencodeValueEnd(buffer, keyStart);
    if (keyEnd <= keyStart) return '';
    const colon = buffer.indexOf(58, keyStart);
    if (colon < keyStart || colon >= keyEnd) return '';
    const key = buffer.toString('utf8', colon + 1, keyEnd);
    pos = keyEnd;
    const valueStart = pos;
    const valueEnd = bencodeValueEnd(buffer, valueStart);
    if (valueEnd <= valueStart) return '';
    if (key === 'info') return crypto.createHash('sha1').update(buffer.subarray(valueStart, valueEnd)).digest('hex').toUpperCase();
    pos = valueEnd;
  }
  return '';
}

async function discoverTokyoToshoHash(item) {
  const direct = normalizeInfoHash(item?.hash) || aniRenaInfoHash(item?.magnetUrl);
  if (direct) return direct;
  const candidates = [item?.magnetUrl, item?.torrentUrl, item?.pageUrl].filter(Boolean);
  for (const url of [...new Set(candidates)]) {
    if (/^magnet:/i.test(url)) {
      const hash = aniRenaInfoHash(url);
      if (hash) return hash;
      continue;
    }
    if (!isTokyoToshoUrl(url)) continue;
    try {
      if (url === item?.torrentUrl || /\.torrent(?:[?#]|$)|\/(?:download|dl)\.php(?:[?#]|$)/i.test(url)) {
        const torrentResponse = await http.get(url, { responseType: 'arraybuffer', timeout: Math.max(3000, Number(process.env.TOKYOTOSHO_TIMEOUT_MS || 7000)) });
        const torrentHash = torrentFileInfoHash(torrentResponse.data);
        if (torrentHash) return torrentHash;
      }
      const response = await http.get(url, { responseType: 'text', timeout: Math.max(3000, Number(process.env.TOKYOTOSHO_TIMEOUT_MS || 7000)) });
      const body = String(response.data || '');
      const $ = cheerio.load(body);
      const magnet = tokyoToshoMagnet($('a[href^="magnet:"]').map((_, el) => $(el).attr('href') || '').get().join('\n') + '\n' + body);
      const hash = aniRenaInfoHash(`${response.request?.res?.responseUrl || ''}\n${magnet}\n${body}`);
      if (hash) return hash;
      const labelledHash = body.match(/(?:BT\s+Info\s+Hash|Info\s+Hash)[\s\S]{0,120}?([a-f0-9]{40})/i)?.[1] || '';
      const normalizedLabelledHash = normalizeInfoHash(labelledHash);
      if (normalizedLabelledHash) return normalizedLabelledHash;
      const attrs = $('[data-info-hash],[data-infohash],[data-hash]').map((_, el) => $(el).attr('data-info-hash') || $(el).attr('data-infohash') || $(el).attr('data-hash')).get();
      for (const attr of attrs) { const found = normalizeInfoHash(attr); if (found) return found; }
    } catch (error) {
      console.warn(`[TokyoToshokan] hash lookup failed (${url}): ${error.code || error.response?.status || error.message}`);
    }
  }
  return '';
}

async function fetchTokyoToshoMeta(key) {
  const item = parseTokyoToshoReleaseKey(key);
  if (!item) return null;
  const quality = communityReleaseQuality(item.title);
  const description = [quality, item.size ? `Size ${clean(item.size)}` : '', item.seeders ? `${clean(item.seeders)} seeders` : 'Community torrent release'].filter(Boolean).join(' · ');
  const poster = absUrl(item.poster, TOKYOTOSHO_BASE) || TOKYOTOSHO_POSTER;
  return { name: item.title, poster, background: poster, description, genres: ['Hentai Anime', 'Community Release', ...(quality ? [quality] : [])], episodes: [{ key: JSON.stringify(item), title: description || 'Community release' }] };
}

async function resolveTokyoToshoStreams(key) {
  const item = parseTokyoToshoReleaseKey(key);
  if (!item) return [];
  const hash = await discoverTokyoToshoHash(item);
  if (!hash) return [];
  const quality = communityReleaseQuality(item.title);
  const title = [quality, item.size ? `Size ${clean(item.size)}` : '', item.seeders ? `${clean(item.seeders)} seeders` : 'P2P community release'].filter(Boolean).join(' · ');
  return [{ name: 'Tokyo Toshokan Hentai Anime Release', title, infoHash: hash, sources: TOKYOTOSHO_TRACKERS }];
}

function hentaiOceanSlugFromUrl(value, base = HENTAIOCEAN_BASE) {
  try {
    const u = new URL(String(value || ''), base);
    if (!isHentaiOceanUrl(u.href, base)) return '';
    const match = u.pathname.match(/^\/(?:watch|embed)\/([^/]+)\/?$/i);
    return match ? decodeURIComponent(match[1]) : '';
  } catch { return ''; }
}

function hentaiOceanWatchUrl(slug, base = HENTAIOCEAN_BASE) {
  return `${base}/watch/${encodeURIComponent(String(slug || '').trim())}`;
}
function hentaiOceanThumbnail(slug, base = HENTAIOCEAN_BASE) {
  return `${base}/thumbnail/${encodeURIComponent(String(slug || '').trim())}.webp`;
}
function hentaiOceanCover(coverimg, base = HENTAIOCEAN_BASE) {
  const raw = clean(coverimg);
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return absUrl(raw, base);
  return `${base}/assets/cover/${encodeURIComponent(raw)}`;
}
function hentaiOceanPosterFromItem($item, base, slug) {
  const imageNode = $item.find('media\\:thumbnail, media\\:content, thumbnail, image, enclosure').first();
  const rawImage = clean(imageNode.attr('url') || imageNode.attr('href') || imageNode.attr('src'));
  if (rawImage && /\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(rawImage)) return absUrl(rawImage, base);
  const desc = $item.find('description, summary, content, content\\:encoded').first();
  const markup = `${xmlNodeText(desc)} ${desc.html() || ''} ${$item.html() || ''}`;
  const match = markup.match(/(?:src|data-src|url)=["']([^"']+\.(?:jpe?g|png|webp)(?:\?[^"']*)?)["']/i);
  return (match && absUrl(match[1], base)) || hentaiOceanThumbnail(slug, base);
}

function parseHentaiOceanCards(html, base = HENTAIOCEAN_BASE) {
  const $ = cheerio.load(String(html || ''));
  const out = [];
  const seen = new Set();
  $('a[href*="/watch/"], a[href*="/embed/"]').each((_, el) => {
    const $a = $(el);
    const rawUrl = absUrl($a.attr('href'), base);
    const slug = hentaiOceanSlugFromUrl(rawUrl, base);
    if (!rawUrl || !slug || !isHentaiOceanUrl(rawUrl, base)) return;
    const key = hentaiOceanWatchUrl(slug, base);
    if (seen.has(key)) return;

    const $card = $a.closest('article,.video-card,.video-item,.movie-item,.item,.thumb,.thumbnail,.post,.entry,li');
    const $box = $card.length ? $card : $a.parent();
    const candidates = [
      clean($a.attr('title') || $a.attr('aria-label') || $a.attr('data-title')),
      clean($box.find('.title,.video-title,.name,h2,h3,h4,[data-title]').first().attr('data-title')),
      clean($box.find('.title,.video-title,.name,h2,h3,h4').first().text()),
      clean($box.find('img').first().attr('alt')),
      clean($a.text()),
      clean(slug.replace(/[-_+]+/g, ' ')),
    ].map(cleanVideoTitle).filter(v => v && v.length > 2 && !/^(?:watch|play|view|more|image|thumbnail|untitled)$/i.test(v));
    const name = candidates.find(v => normalizedTextKey(v) !== 'hentai ocean') || clean(slug.replace(/[-_+]+/g, ' '));
    if (!name || blocked({ name })) return;
    const cardPosterValue = cardPoster($, $box, $a, base);
    const poster = cardPosterValue || hentaiOceanThumbnail(slug, base);
    const description = clean($box.find('.description,.excerpt,.summary').first().text());
    const genres = [...new Set($box.find('.genre a,.genres a,.tags a,a[rel="tag"],.category a').map((__, node) => clean($(node).text())).get().filter(Boolean))];
    seen.add(key);
    out.push({ key, name, poster, description, genres: [...new Set(['Hentai Anime', 'Streaming Archive', ...genres])] });
    if (out.length >= 250) return false;
  });
  return out;
}

function parseHentaiOceanRss(xml, base = HENTAIOCEAN_BASE) {
  const $ = cheerio.load(String(xml || ''), { xmlMode: true });
  const out = [];
  const seen = new Set();
  $('item, entry').each((_, el) => {
    const $item = $(el);
    const title = xmlChildValue($item, ['title']);
    const children = $item.children().toArray();
    const local = node => String(node?.name || '').split(':').pop().toLowerCase();
    const linkNodes = children.filter(node => local(node) === 'link');
    const rawLinks = [
      ...linkNodes.flatMap(node => [xmlNodeText(node), clean(node.attribs?.href), clean(node.attribs?.url)]),
      ...children.filter(node => ['guid', 'id', 'url', 'link'].includes(local(node))).map(node => xmlNodeText(node)),
    ];
    const descriptionNode = $item.find('description, summary, content, content\\:encoded').first();
    const descriptionText = [xmlNodeText(descriptionNode), descriptionNode.html() || '', $item.html() || ''].join(' ');
    rawLinks.push(...(descriptionText.match(/https?:[^\s"'<>]+/g) || []));
    const cleanLinks = rawLinks.map(value => clean(value).replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>'));
    const url = cleanLinks.map(value => absUrl(value, base)).find(value => value && isHentaiOceanUrl(value, base) && hentaiOceanSlugFromUrl(value, base)) || '';
    const slug = hentaiOceanSlugFromUrl(url, base);
    if (!title || !slug || !isHentaiOceanUrl(url, base) || blocked({ name: title })) return;
    const key = hentaiOceanWatchUrl(slug, base);
    if (seen.has(key)) return;
    const categoryValues = children.filter(node => local(node) === 'category').map(node => xmlNodeText(node)).filter(Boolean);
    const poster = hentaiOceanPosterFromItem($item, base, slug);
    const description = stripHtml(xmlChildValue($item, ['description', 'summary']));
    seen.add(key);
    out.push({ key, name: cleanVideoTitle(title), poster, description, genres: [...new Set(['Hentai Anime', 'Streaming Archive', ...categoryValues])] });
    if (out.length >= 500) return false;
  });
  return out;
}

function mergeHentaiOceanItems(groups) {
  const byKey = new Map();
  for (const group of groups) for (const item of (group || [])) {
    if (!item?.key || !item.name || blocked(item)) continue;
    const key = hentaiOceanWatchUrl(hentaiOceanSlugFromUrl(item.key), HENTAIOCEAN_BASE);
    if (!key || key.endsWith('/watch/')) continue;
    const previous = byKey.get(key);
    if (!previous) byKey.set(key, { ...item, key });
    else {
      const merged = { ...previous, ...item, key };
      if (!item.description && previous.description) merged.description = previous.description;
      if ((!item.genres || item.genres.length <= 2) && previous.genres?.length > (item.genres?.length || 0)) merged.genres = previous.genres;
      if (String(item.poster || '').includes('/thumbnail/') && previous.poster && !String(previous.poster).includes('/thumbnail/')) merged.poster = previous.poster;
      byKey.set(key, merged);
    }
  }
  return [...byKey.values()];
}

async function fetchHentaiOceanRss() {
  return cached('hentaiocean:rss', CATALOG_TTL, async () => {
    const timeout = Math.max(1800, Number(process.env.HENTAIOCEAN_TIMEOUT_MS || 2800));
    const xml = await getHtmlFresh(`${HENTAIOCEAN_BASE}/rss.xml`, HENTAIOCEAN_BASE, {}, timeout);
    return parseHentaiOceanRss(xml, HENTAIOCEAN_BASE);
  });
}

async function fetchHentaiOceanRouteItems(urls, root, timeout, acceptItems = null) {
  // These routes are distinct collections (recent, newly added, and search).
  // Promise.any returned just the fastest route, silently discarding the rest.
  const uniqueUrls = [...new Set(urls)].slice(0, 8);
  const results = await Promise.allSettled(uniqueUrls.map(async url => {
    const html = await getHtmlFresh(url, root, {}, timeout);
    const items = parseHentaiOceanCards(html, url);
    const accepted = acceptItems ? acceptItems(items) : items;
    if (!items.length || (acceptItems && !accepted.length)) throw new Error('no matching parseable cards');
    return items;
  }));
  return mergeHentaiOceanItems(results
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value));
}

async function fetchHentaiOceanCatalog({ search = '', genre = '', page = 1 } = {}) {
  const n = Math.max(1, Number(page) || 1);
  const query = clean(search);
  const wantedGenre = clean(genre);
  const root = HENTAIOCEAN_BASE.replace(/\/$/, '');
  const timeout = Math.max(1800, Number(process.env.HENTAIOCEAN_TIMEOUT_MS || 2800));
  const cacheKey = `hentaiocean:catalog-page:${n}:${normalizedTextKey(query)}`;
  // The first load caches the merged RSS + HTML catalogue (not just the 20 Stremio
  // items returned to clients). Reuse that full pool for later pages before probing
  // more guessed URLs, which was both slow and artificially limiting the catalogue.
  if (n > 1 && !query && !wantedGenre) {
    await fetchHentaiOceanCatalog({ page: 1 });
    const firstPool = cache.get('hentaiocean:catalog-page:1:')?.value;
    if (Array.isArray(firstPool)) {
      const pooledPage = firstPool.slice((n - 1) * PAGE_SIZE, n * PAGE_SIZE);
      if (pooledPage.length) return pooledPage;
    }
  }
  let items = await cached(cacheKey, CATALOG_TTL, async () => {
    if (query) {
      const q = encodeURIComponent(query);
      const routes = n === 1
        ? [`${root}/?s=${q}`, `${root}/search/${q.replace(/%20/g, '+')}/`, `${root}/?search=${q}`]
        : [`${root}/?s=${q}&paged=${n}`, `${root}/search/${q.replace(/%20/g, '+')}/page/${n}/`, `${root}/?search=${q}&page=${n}`];
      return fetchHentaiOceanRouteItems(routes, root, timeout, values => {
        const normalizedQuery = normalizedTextKey(query);
        return values.filter(item => normalizedTextKey(item.name).includes(normalizedQuery));
      });
    }

    if (n === 1) {
      // The documented RSS and the HTML archive are queried in parallel. Only wait
      // for these two sources, avoiding the previous fan-out to several guessed URLs.
      const [rssResult, htmlResult] = await Promise.allSettled([
        fetchHentaiOceanRss(),
        fetchHentaiOceanRouteItems([
          `${root}/view/recent-releases`,
          `${root}/view/newly-added`,
          `${root}/`,
        ], root, timeout),
      ]);
      const rssItems = rssResult.status === 'fulfilled' ? rssResult.value : [];
      const htmlItems = htmlResult.status === 'fulfilled' ? htmlResult.value : [];
      if (rssResult.status === 'rejected') console.warn(`[HentaiOcean] RSS request failed: ${rssResult.reason?.code || rssResult.reason?.response?.status || rssResult.reason?.message}`);
      // The official view routes contain hundreds of links; the homepage alone has
      // only a handful. Keep the merged pool intact for Stremio skip/page handling.
      return mergeHentaiOceanItems([rssItems, htmlItems]).slice(0, 1000);
    }

    const routes = [
      `${root}/view/recent-releases?page=${n}`,
      `${root}/view/newly-added?page=${n}`,
      `${root}/view/recent-releases/page/${n}/`,
      `${root}/view/newly-added/page/${n}/`,
      `${root}/page/${n}/`,
      `${root}/?paged=${n}`,
      `${root}/?page=${n}`,
    ];
    return fetchHentaiOceanRouteItems(routes, root, timeout);
  });

  if (n > 1 && !query) {
    const firstPage = await fetchHentaiOceanCatalog({ page: 1 });
    const firstKeys = new Set(firstPage.map(item => item.key));
    const unique = items.filter(item => !firstKeys.has(item.key));
    if (unique.length) items = unique;
    else {
      // Some WordPress mirrors silently return page one for an unsupported route.
      // Discover the real numbered link only after detecting that duplicate response.
      try {
        const firstHtml = await getHtmlFresh(`${root}/`, root, {}, timeout);
        const discovered = discoverPaginationUrls(firstHtml, `${root}/`, n, 'hentaiocean').slice(0, 3);
        if (discovered.length) {
          const discoveredItems = await fetchHentaiOceanRouteItems(discovered, root, timeout);
          const actual = discoveredItems.filter(item => !firstKeys.has(item.key));
          if (actual.length) items = actual;
          else items = [];
        } else items = [];
      } catch { items = []; }
      if (!items.length) {
        const rssItems = await fetchHentaiOceanRss().catch(() => []);
        items = rssItems.slice((n - 1) * PAGE_SIZE, n * PAGE_SIZE);
      }
    }
  }

  if (query) {
    const normalizedQuery = normalizedTextKey(query);
    items = items.filter(item => normalizedTextKey(item.name).includes(normalizedQuery));
  }
  if (wantedGenre) {
    const wanted = normalizedTextKey(wantedGenre);
    items = items.filter(item => (item.genres || []).some(value => normalizedTextKey(value).includes(wanted)) || normalizedTextKey(item.name).includes(wanted));
  }
  return mergeHentaiOceanItems([items]).slice(0, PAGE_SIZE);
}

async function fetchHentaiOceanMeta(key) {
  const slug = hentaiOceanSlugFromUrl(key, HENTAIOCEAN_BASE);
  if (!slug) return null;
  try {
    const result = await cached(`hentaiocean:api-meta:${slug}`, DETAIL_TTL, async () => {
      const response = await http.get(`${HENTAIOCEAN_BASE}/api`, {
        params: { action: 'hentai', slug },
        responseType: 'json',
        timeout: Math.max(2500, Number(process.env.HENTAIOCEAN_TIMEOUT_MS || 6000)),
      });
      return response.data;
    });
    const info = Array.isArray(result?.info) ? result.info[0] : null;
    if (info) {
      const title = clean(info.videoname || info.title || slug.replace(/[-_+]+/g, ' '));
      const poster = hentaiOceanCover(info.coverimg, HENTAIOCEAN_BASE) || hentaiOceanThumbnail(slug, HENTAIOCEAN_BASE);
      const genres = Array.isArray(result.genres) ? result.genres.map(value => clean(value?.genre || value)).filter(Boolean) : [];
      return {
        name: title,
        poster,
        background: hentaiOceanThumbnail(slug, HENTAIOCEAN_BASE),
        description: clean(info.description || info.description_en || ''),
        genres: [...new Set(['Hentai Anime', ...genres])],
        episodes: [{ key: hentaiOceanWatchUrl(slug, HENTAIOCEAN_BASE), title }],
      };
    }
  } catch (error) {
    console.warn(`[HentaiOcean] documented metadata API failed for ${slug}: ${error.code || error.response?.status || error.message}`);
  }
  try {
    const data = await pageMeta(hentaiOceanWatchUrl(slug, HENTAIOCEAN_BASE), HENTAIOCEAN_CONFIG);
    if (!data.poster) data.poster = hentaiOceanThumbnail(slug, HENTAIOCEAN_BASE);
    if (!data.name || data.name === HENTAIOCEAN_CONFIG.name) data.name = clean(slug.replace(/[-_+]+/g, ' '));
    data.genres = [...new Set([...(data.genres || []), 'Hentai Anime', 'Streaming Archive'])];
    return data;
  } catch {
    return { name: clean(slug.replace(/[-_+]+/g, ' ')), poster: hentaiOceanThumbnail(slug, HENTAIOCEAN_BASE), background: hentaiOceanThumbnail(slug, HENTAIOCEAN_BASE), genres: ['Hentai Anime'], episodes: [{ key: hentaiOceanWatchUrl(slug, HENTAIOCEAN_BASE), title: slug }] };
  }
}

async function resolveHentaiOceanStreams(key) {
  const slug = hentaiOceanSlugFromUrl(key, HENTAIOCEAN_BASE);
  if (!slug) return [];
  const embedUrl = `${HENTAIOCEAN_BASE}/embed/${encodeURIComponent(slug)}?la=1`;
  const direct = await resolveStreams('HentaiOcean', embedUrl, 'hentaiocean', Math.max(2500, Number(process.env.HENTAIOCEAN_STREAM_TIMEOUT_MS || 6500)));
  if (direct.length) return direct;
  return resolveStreams('HentaiOcean', hentaiOceanWatchUrl(slug, HENTAIOCEAN_BASE), 'hentaiocean', Math.max(2500, Number(process.env.HENTAIOCEAN_STREAM_TIMEOUT_MS || 6500)));
}

async function fetchAniRenaCatalog({ search = '', genre = '', page = 1 } = {}) {
  const n = Math.max(1, Number(page) || 1);
  const query = clean(search);
  // The current official guide documents /rss?category=hentai. Some deployments
  // also honour the older adult=1 switch, so try both rather than treating an empty
  // first response as a valid empty catalogue.
  const variants = [
    { category: 'hentai', adult: 1, ...(query ? { q: query } : {}) },
    { category: 'hentai', ...(query ? { q: query } : {}) },
  ];
  let items = [];
  let lastFeedError = null;
  for (const params of variants) {
    const cacheKey = `anirena:rss:${JSON.stringify(params)}`;
    try {
      const rss = await cached(cacheKey, CATALOG_TTL, async () => {
        const response = await http.get(`${ANIRENA_BASE}/rss`, { params, responseType: 'text' });
        return String(response.data || '');
      });
      const parsed = parseAniRenaRss(rss);
      if (parsed.length) { items = parsed; break; }
    } catch (error) {
      lastFeedError = error;
      console.warn(`[AniRena] RSS request failed for ${JSON.stringify(params)}: ${error.code || error.response?.status || error.message}`);
    }
  }
  if (!items.length && lastFeedError) throw lastFeedError;
  if (!items.length) console.warn('[AniRena] RSS responded, but no parseable Hentai-category records were found.');
  if (query) {
    const normalizedQuery = normalizedTextKey(query);
    items = items.filter(item => normalizedTextKey(item.name).includes(normalizedQuery));
  }
  if (genre) {
    const wanted = clean(genre).toLowerCase();
    if (/\d{3,4}p|4k|uhd/i.test(wanted)) {
      items = items.filter(item => communityReleaseQuality(item.name).toLowerCase() === (wanted === '4k' || wanted === 'uhd' ? '2160p' : wanted));
    } else {
      items = items.filter(item => item.name.toLowerCase().includes(wanted));
    }
  }
  // RSS feeds are typically bounded to recent items. A requested page is
  // sliced locally so duplicate RSS responses don't repeat the same cards.
  const start = (n - 1) * PAGE_SIZE;
  return items.slice(start, start + PAGE_SIZE);
}

async function fetchAniRenaMeta(key) {
  const item = parseAniRenaReleaseKey(key);
  if (!item) return null;
  const quality = communityReleaseQuality(item.title);
  const description = [quality, item.size ? `Size ${item.size}` : '', item.seeders ? `${item.seeders} seeders` : 'Community torrent release']
    .filter(Boolean).join(' · ');
  return {
    name: item.title,
    poster: absUrl(item.poster, ANIRENA_BASE) || ANIRENA_POSTER,
    background: absUrl(item.poster, ANIRENA_BASE) || ANIRENA_POSTER,
    description,
    genres: ['Hentai Anime', 'Community Release', ...(quality ? [quality] : [])],
    episodes: [{ key: aniRenaReleaseKey(item), title: description || 'Community release' }],
  };
}

async function discoverAniRenaHash(item) {
  const directHash = normalizeInfoHash(item?.hash) || aniRenaInfoHash(item?.magnetUrl);
  if (directHash) return directHash;
  const hrefCandidates = [item?.magnetUrl].filter(Boolean);
  const torrentId = aniRenaTorrentId(item?.pageUrl);
  if (torrentId) hrefCandidates.push(`${ANIRENA_BASE}/torrents/${torrentId}/magnet`);
  if (item?.pageUrl) hrefCandidates.push(item.pageUrl);
  for (const url of [...new Set(hrefCandidates)]) {
    if (/^magnet:/i.test(url)) {
      const hash = aniRenaInfoHash(url);
      if (hash) return hash;
      continue;
    }
    if (!isAniRenaUrl(url, ANIRENA_BASE)) continue;
    try {
      const response = await http.get(url, { maxRedirects: 0, responseType: 'text', validateStatus: status => status >= 200 && status < 400 });
      const location = String(response.headers?.location || '');
      let hash = aniRenaInfoHash(`${location}\n${String(response.data || '')}`);
      if (hash) return hash;
      const $ = cheerio.load(String(response.data || ''));
      const magnet = $('a[href^="magnet:"]').map((_, el) => $(el).attr('href')).get().find(Boolean) || '';
      hash = aniRenaInfoHash(magnet);
      if (hash) return hash;
      const attrs = $('[data-info-hash],[data-infohash],[data-hash]').map((_, el) => $(el).attr('data-info-hash') || $(el).attr('data-infohash') || $(el).attr('data-hash')).get();
      for (const attr of attrs) { hash = normalizeInfoHash(attr); if (hash) return hash; }
    } catch (error) {
      console.warn(`[AniRena] couldn't resolve torrent hash (${url}): ${error.code || error.response?.status || error.message}`);
    }
  }
  return '';
}

async function resolveAniRenaStreams(key) {
  const item = parseAniRenaReleaseKey(key);
  if (!item) return [];
  const hash = await discoverAniRenaHash(item);
  if (!hash) return [];
  const quality = communityReleaseQuality(item.title);
  const title = [quality, item.size ? `Size ${item.size}` : '', item.seeders ? `${item.seeders} seeders` : 'P2P community release']
    .filter(Boolean).join(' · ');
  return [{ name: 'AniRena Hentai Anime Release', title, infoHash: hash, sources: ANIRENA_TRACKERS }];
}

function cleanCommunityTitle(value) {
  let text = String(value || '').normalize('NFKC');
  // Strip common fansub/release labels, including full-width Japanese brackets.
  text = text.replace(/^\s*(?:(?:\[[^\]]+\]|【[^】]+】|〔[^〕]+〕|〖[^〗]+〗)\s*)+/g, ' ');
  text = text.replace(/[\[{(【〔〖][^\])}】〕〗]*\b(?:\d{3,4}p|2160p|4k|uhd|bd|blu.?ray|dvd|web.?dl|hdtv|x26[45]|h26[45]|hevc|avc|aac|flac|10.?bit|8.?bit|uncensored|subbed|multi.?sub)[^\])}】〕〗]*[\])}】〕〗]/gi, ' ');
  text = text.replace(/\b(?:4320p|2160p|1440p|1080p|720p|480p|360p|4k|uhd|bd|blu.?ray|dvd|web.?dl|hdtv|x26[45]|h26[45]|hevc|avc|aac|flac|10.?bit|8.?bit|uncensored|subbed|multi.?sub)\b/gi, ' ');
  text = text.replace(/\.(?:mkv|mp4|avi|webm|torrent)$/i, ' ');
  // Unlike normalizedTextKey, preserve Japanese/CJK letters so anime releases with
  // Japanese titles can match AniList's native title field instead of losing all text.
  return text.toLowerCase().replace(/[\u2000-\u206f\u2e00-\u2e7f]/g, ' ')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function communityPosterScore(releaseTitle, candidateTitle) {
  const cleanA = cleanCommunityTitle(releaseTitle);
  const cleanB = cleanCommunityTitle(candidateTitle);
  if (!cleanA || !cleanB) return 0;
  if (cleanA === cleanB || cleanA.includes(cleanB) || cleanB.includes(cleanA)) return Math.min(cleanA.length, cleanB.length) >= 7 ? 1 : 0;
  const noise = new Set(['the','and','with','from','episode','episodes','complete','series','hentai','anime','uncensored','subbed','raw','ova','oad','vol','part','special']);
  const a = [...new Set(cleanA.split(' ').filter(token => token.length >= 3 && !noise.has(token)))];
  const b = [...new Set(cleanB.split(' ').filter(token => token.length >= 3 && !noise.has(token)))];
  const shared = a.filter(token => b.includes(token)).length;
  const union = new Set([...a, ...b]).size;
  const overlap = shared / Math.max(1, Math.min(a.length, b.length));
  const jaccard = shared / Math.max(1, union);
  // Torrent release names often retain only one distinctive word from a short OVA
  // title once fansub tags and episode/resolution labels are removed. Allow that case
  // only when the shared token is long and distinctive.
  if (shared === 1 && a.length <= 2 && b.length <= 2) {
    const token = a.find(value => b.includes(value)) || '';
    if (token.length >= 7 && !noise.has(token)) return 0.62;
  }
  return shared >= 2 && overlap >= 0.70 && jaccard >= 0.42 ? jaccard : 0;
}
function applyCommunityPosterMatches(items, posterItems) {
  const candidates = (posterItems || []).filter(item => item?.providerId !== 'tokyotosho' && item?.name && item?.poster
    && !String(item.poster).includes('/favicon.') && !String(item.poster).includes('placeholder'));
  if (!candidates.length) return items;
  for (const item of items || []) {
    if (item.providerId !== 'tokyotosho' || (item.poster && !String(item.poster).includes('/favicon.'))) continue;
    let best = null;
    let bestScore = 0;
    for (const candidate of candidates) {
      const score = communityPosterScore(item.name, candidate.name);
      if (score > bestScore) { best = candidate; bestScore = score; }
    }
    if (!best || bestScore < 0.55) continue;
    item.poster = best.poster;
    item.artworkShape = best.providerId === 'hentaimama' ? 'poster' : 'landscape';
    // Persist the resolved poster in the ID payload so detail metadata uses the same artwork.
    try {
      const data = JSON.parse(item.key);
      data.poster = item.poster;
      data.artworkShape = item.artworkShape;
      item.key = JSON.stringify(data);
    } catch {}
  }
  return items;
}


function communityArtworkSearchTitle(value) {
  let text = String(value || '').normalize('NFKC');
  text = text.replace(/^\s*(?:(?:\[[^\]]+\]|【[^】]+】|〔[^〕]+〕|〖[^〗]+〗)\s*)+/g, ' ');
  text = text.replace(/[\[{(][^\])}]*\b(?:\d{3,4}p|2160p|4k|uhd|bd|blu.?ray|dvd|web.?dl|hdtv|x26[45]|h26[45]|hevc|avc|aac|flac|10.?bit|8.?bit|uncensored|subbed|multi.?sub)[^\])}]*[\])}]/gi, ' ');
  text = text.replace(/\b(?:4320p|2160p|1440p|1080p|720p|480p|360p|4k|uhd|blu.?ray|web.?dl|hdtv|x26[45]|h26[45]|hevc|avc|aac|flac|10.?bit|8.?bit|uncensored|subbed|multi.?sub)\b/gi, ' ');
  text = text.replace(/\.(?:mkv|mp4|avi|webm|torrent)$/i, ' ');
  text = text.replace(/\b(?:S\d{1,2}\s*E\d{1,3}|episode\s*#?\s*\d{1,3}|ep\s*#?\s*\d{1,3})\b/ig, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, 100);
}

async function fetchAniListCommunityPosters(items) {
  const targets = (items || []).filter(item => item?.providerId === 'tokyotosho'
    && (!item.poster || /\/favicon\./i.test(String(item.poster)) || /placeholder/i.test(String(item.poster))))
    .slice(0, 20);
  if (!targets.length) return items;
  const requests = targets.map(item => ({ item, query: communityArtworkSearchTitle(item.name) })).filter(entry => entry.query.length >= 4);
  if (!requests.length) return items;
  const cacheKey = `community:anilist-posters:${crypto.createHash('sha1').update(requests.map(entry => entry.query).join('|')).digest('hex')}`;
  const responseData = await cached(cacheKey, 6 * 60 * 60 * 1000, async () => {
    const query = `query { ${requests.map((entry, index) => `q${index}: Page(page: 1, perPage: 10) { media(search: ${JSON.stringify(entry.query)}, type: ANIME, sort: [SEARCH_MATCH]) { title { romaji english native } coverImage { extraLarge large } isAdult genres } }`).join('\n')} }`;
    const response = await http.post('https://graphql.anilist.co', { query }, {
      timeout: Math.max(1200, Number(process.env.COMMUNITY_POSTER_TIMEOUT_MS || 1800)),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });
    return response.data?.data || {};
  }).catch(error => {
    console.warn(`[Community artwork] AniList lookup failed: ${error.code || error.response?.status || error.message}`);
    return null;
  });
  if (!responseData) return items;

  requests.forEach(({ item }, index) => {
    const results = responseData[`q${index}`]?.media || [];
    let best = null;
    let bestScore = 0;
    for (const candidate of results) {
      const titleValues = [candidate.title?.english, candidate.title?.romaji, candidate.title?.native].filter(Boolean);
      for (const candidateTitle of titleValues) {
        const score = communityPosterScore(item.name, candidateTitle);
        if (score > bestScore) { best = candidate; bestScore = score; }
      }
    }
    const genres = (best?.genres || []).map(value => String(value).toLowerCase());
    const adultTagged = best?.isAdult === true || genres.includes('hentai');
    const poster = best?.coverImage?.extraLarge || best?.coverImage?.large || '';
    // Tokyo's source is already the dedicated Hentai (Anime) torrent category. Permit
    // non-Adult metadata only for an almost exact title match; this avoids empty covers
    // when AniList's adult flag is missing while rejecting loosely similar titles.
    if (!poster || bestScore < 0.55 || (!adultTagged && bestScore < 0.90)) return;
    item.poster = poster;
    item.artworkShape = 'poster';
    try {
      const data = JSON.parse(item.key);
      data.poster = poster;
      data.artworkShape = 'poster';
      item.key = JSON.stringify(data);
    } catch {}
  });
  return items;
}

function posterShapeFor(item, genre) {
  if (item?.artworkShape === 'poster' || item?.artworkShape === 'landscape') return item.artworkShape;
  return clean(genre) && ['hentaimama'].includes(item?.providerId) ? 'poster' : 'landscape';
}

// A master HLS playlist can list real variant playlists at explicit resolutions.
// Convert those listed variants to separate Stremio stream choices; never guess URLs.
function parseHlsVariantPlaylist(playlist, baseUrl) {
  const lines = String(playlist || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.some(line => line === '#EXTM3U')) return [];
  const variants = [];
  const seenQualities = new Set();
  const seenUrls = new Set();
  let pendingQuality = '';
  for (const line of lines) {
    if (/^#EXT-X-STREAM-INF:/i.test(line)) {
      pendingQuality = qualityFromLabel(line);
      continue;
    }
    if (!pendingQuality || line.startsWith('#')) continue;
    try {
      const url = new URL(line, baseUrl).href;
      if (!/^https?:$/.test(new URL(url).protocol) || seenQualities.has(pendingQuality) || seenUrls.has(url)) {
        pendingQuality = '';
        continue;
      }
      variants.push({ quality: pendingQuality, url });
      seenQualities.add(pendingQuality);
      seenUrls.add(url);
    } catch { /* Skip malformed variant entries instead of creating links. */ }
    pendingQuality = '';
  }
  return variants.sort((a, b) => Number(b.quality.replace('p', '')) - Number(a.quality.replace('p', '')));
}

async function expandHlsQualityStreams(streams) {
  const sourceStreams = Array.isArray(streams) ? streams : [];
  const expanded = new Map();
  let checked = 0;
  await Promise.all(sourceStreams.map(async (stream, index) => {
    expanded.set(index, [stream]);
    if (!stream?.url || !/\.m3u8(?:[?#]|$)/i.test(stream.url) || qualityFromLabel(stream.title) || checked >= 4) return;
    checked++;
    try {
      const requestHeaders = stream.behaviorHints?.proxyHeaders?.request || { 'User-Agent': UA };
      const response = await http.get(stream.url, { responseType: 'text', headers: requestHeaders });
      const finalUrl = response.request?.res?.responseUrl || response.request?.responseURL || stream.url;
      const variants = parseHlsVariantPlaylist(String(response.data || ''), finalUrl);
      // Keep the original master unless at least two different, explicitly labelled variants exist.
      if (variants.length < 2) return;
      expanded.set(index, variants.map(variant => {
        let filename = '';
        try { filename = decodeURIComponent(new URL(variant.url).pathname.split('/').pop() || ''); } catch {}
        return {
          ...stream,
          title: `${variant.quality} · HLS`,
          url: variant.url,
          behaviorHints: {
            ...(stream.behaviorHints || {}),
            notWebReady: true,
            ...(filename ? { filename } : {}),
          },
        };
      }));
    } catch { /* Keep the original valid master URL if variant lookup fails. */ }
  }));
  return [...expanded.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, group]) => group).slice(0, 20);
}

function isAdOrTracker(url) {
  try {
    const u = new URL(url);
    return /(?:doubleclick|googlesyndication|google-analytics|googletagmanager|trackwilltrk|xhubtraffic|zlink|yandex|popads|adservice|exoclick|trafficjunky|adsterra|onclickads|juicyads|push-notification)/i.test(u.hostname)
      || /\/(?:ads?|advert|banner|tracking|analytics|promo)(?:\/|\.|$)/i.test(u.pathname);
  } catch { return true; }
}
function scorePlayerUrl(url) {
  try {
    const u = new URL(url);
    let score = 0;
    if (/\.(?:m3u8|mp4|m4v|mpd|webm)(?:[?#]|$)/i.test(url)) score += 100;
    if (/\/(?:embed|player|video|watch|stream|iframe|jwplayer)(?:\/|$)/i.test(u.pathname)) score += 20;
    if (/(?:player|embed|stream|video)/i.test(`${u.hostname}${u.pathname}`)) score += 8;
    if (isAdOrTracker(url)) score -= 1000;
    return score;
  } catch { return -1000; }
}
function streamObject(providerName, url, referer, preserveHentaigasm = false, source = '') {
  const parsed = new URL(url);
  const ext = parsed.pathname.toLowerCase();
  const type = ext.endsWith('.m3u8') ? 'HLS' : ext.endsWith('.mpd') ? 'DASH' : ext.endsWith('.webm') ? 'WEBM' : 'MP4';
  const quality = detectExplicitQuality(url, source);
  let filename = ext.split('/').pop() || `stream.${type.toLowerCase()}`;
  try { filename = decodeURIComponent(filename); } catch { /* Preserve the raw filename if the URL contains invalid escapes. */ }
  return {
    name: providerName,
    title: quality ? `${quality} · ${type}` : type,
    url,
    behaviorHints: {
      notWebReady: true,
      filename,
      proxyHeaders: { request: preserveHentaigasm
        ? { Referer: referer, 'User-Agent': UA }
        : { Referer: referer, Origin: (() => { try { return new URL(referer).origin; } catch { return undefined; } })(), 'User-Agent': UA } },
    },
  };
}

async function resolveStreams(providerName, pageUrl, providerId = '', timeoutOverride = 0) {
  const streams = [];
  const streamUrls = new Set();
  const visited = new Set();
  const queue = [{ url: pageUrl, referer: pageUrl, depth: 0, html: null }];
  const hentaiSmileTargetId = providerId === 'hentaismile' ? hentaiSmileVideoId(pageUrl) : '';
  const maxDepth = Number(process.env.EMBED_DEPTH || (providerId === 'hentaigasm' || providerId === 'hentaiocean' ? 3 : 5));
  const maxPages = Number(process.env.EMBED_PAGE_LIMIT || (providerId === 'hentaigasm' ? 18 : providerId === 'hentaiocean' ? 10 : 24));

  while (queue.length && visited.size < maxPages) {
    const current = queue.shift();
    if (!current?.url || visited.has(current.url) || current.depth > maxDepth) continue;
    visited.add(current.url);
    try {
      const html = current.html ?? (providerId === 'hentaigasm' ? await getHtml(current.url, current.referer) : await getHtmlFresh(current.url, current.referer, {}, timeoutOverride));
      const found = providerId === 'hentaigasm' ? candidateStreamsLegacy(html, current.url)
        : providerId === 'hentaismile' ? candidateHentaiSmileStreams(html, current.url, hentaiSmileTargetId)
        : candidateStreams(html, current.url);
      const mediaCandidates = found.media.map(url => ({ url, quality: detectExplicitQuality(url, html) }));
      // Prefer explicitly labelled variants over an unlabelled URL from the same host.
      if (providerId === 'hentaismile') {
        mediaCandidates.sort((a, b) => Number(Boolean(b.quality)) - Number(Boolean(a.quality))
          || Number(b.quality.replace('p', '') || 0) - Number(a.quality.replace('p', '') || 0));
      }
      for (const candidate of mediaCandidates) {
        const mediaUrl = candidate.url;
        if ((providerId !== 'hentaigasm' && isAdOrTracker(mediaUrl)) || streamUrls.has(mediaUrl)) continue;
        let hostKey = '';
        if (providerId === 'hentaismile') {
          try { hostKey = canonicalHost(new URL(mediaUrl).hostname); } catch {}
          const sameHostStreams = hostKey ? streams.filter(stream => {
            try { return canonicalHost(new URL(stream.url).hostname) === hostKey; } catch { return false; }
          }) : [];
          // Keep same-host choices only when each one has a different, explicit quality.
          if (sameHostStreams.length && (!candidate.quality || sameHostStreams.some(stream => {
            const existingQuality = qualityFromLabel(stream.title);
            return !existingQuality || existingQuality === candidate.quality;
          }))) continue;
        }
        streamUrls.add(mediaUrl);
        try { streams.push(streamObject(streamNameForUrl(providerName, mediaUrl, providerId), mediaUrl, current.url, providerId === 'hentaigasm', html)); }
        catch { /* Ignore malformed player URLs. */ }
      }
      // Once the HentaiOcean embed itself exposes a playable source, don't crawl
      // every sibling iframe (many are trackers/recommendations and make resolving slow).
      if (providerId === 'hentaiocean' && found.media.length) break;
      // A matching HentaiSmile KVS config can contain a direct source plus unrelated
      // alternate/advert iframe fields. Once a title-bound direct source was found,
      // don't crawl those iframes and accidentally add a different video's stream.
      if (providerId === 'hentaismile' && hentaiSmileTargetId && found.media.length) continue;
      const embedUrls = providerId === 'hentaigasm' ? found.embeds : [...found.embeds].sort((a, b) => scorePlayerUrl(b) - scorePlayerUrl(a));
      for (const embedUrl of embedUrls) {
        if ((providerId !== 'hentaigasm' && isAdOrTracker(embedUrl)) || visited.has(embedUrl) || queue.some(item => item.url === embedUrl)) continue;
        if (current.depth < maxDepth) queue.push({ url: embedUrl, referer: current.url, depth: current.depth + 1, html: null });
      }
    } catch (e) {
      console.warn(`[${providerName}] player fetch failed (${current.url}): ${e.code || e.response?.status || e.message}`);
    }
  }

  console.log(`[${providerName}] stream resolver: ${streams.filter(s => s.url).length} direct, ${visited.size} pages checked`);
  return streams;
}

function extractJsObject(source, variableName = 'data') {
  const re = new RegExp(`(?:(?:var|let|const)\\s+|window\\.)${variableName}\\s*=\\s*`, 'm');
  const m = re.exec(String(source || ''));
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 0, quote = '', escaped = false, objectStart = -1;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') { if (depth === 0) objectStart = i; depth++; }
    if (ch === '}') {
      depth--;
      if (depth === 0 && objectStart >= 0) {
        const raw = source.slice(objectStart, i + 1);
        try { return JSON.parse(raw); } catch { /* Normalize ordinary JS object syntax below. */ }
        try {
          const jsonish = raw
            .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
            .replace(/'/g, '"')
            .replace(/,\s*([}\]])/g, '$1')
            .replace(/\bundefined\b/g, 'null');
          return JSON.parse(jsonish);
        } catch { return null; }
      }
    }
  }
  return null;
}
function flattenPayloadTexts(value, out = [], depth = 0) {
  if (depth > 6 || value == null) return out;
  if (typeof value === 'string') {
    out.push(value);
    // AJAX endpoints sometimes double-encode a JSON payload.
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try { flattenPayloadTexts(JSON.parse(trimmed), out, depth + 1); } catch { /* It may be HTML rather than JSON. */ }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) flattenPayloadTexts(item, out, depth + 1);
  } else if (typeof value === 'object') {
    for (const item of Object.values(value)) flattenPayloadTexts(item, out, depth + 1);
  }
  return out;
}
function extractPlayerFrames(value, base) {
  const frames = new Set();
  for (const textValue of flattenPayloadTexts(value)) {
    const source = normalizePlayerText(textValue)
      .replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'")
      .replace(/\\"/g, '"');
    const matches = [
      ...[...source.matchAll(/<(?:iframe|frame)\b[^>]*\b(?:src|data-src)\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]),
      ...[...source.matchAll(/(?:iframe_url|player_url|embed_url)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi)].map(m => m[1]),
    ];
    for (const candidate of matches) {
      const url = absUrl(candidate, base);
      if (url && !isNoise(url) && !isAdOrTracker(url)) frames.add(url);
    }
  }
  return [...frames];
}
function extractPlayerFrame(value, base) {
  return extractPlayerFrames(value, base)[0] || '';
}
function extractPlayerMedia(value, base) {
  const texts = flattenPayloadTexts(value);
  const urls = new Set();
  for (const textValue of texts) {
    const expanded = expandEncodedPlayerText(textValue);
    for (const url of extractMedia(expanded, base)) {
      if (!isAdOrTracker(url)) urls.add(url);
    }
    // Some JWPlayer configs use a JS object, single quotes, or escaped JSON.
    const normalized = normalizePlayerText(expanded).replace(/\\"/g, '"').replace(/&quot;/gi, '"');
    for (const match of normalized.matchAll(/(?:["']?(?:file|src|hls|video_url|stream_url)["']?)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi)) {
      const url = absUrl(match[1], base);
      if (url && MEDIA_URL_RE.test(url) && !isNoise(url) && !isAdOrTracker(url)) urls.add(url);
    }
  }
  return [...urls];
}
function extractHentaiMamaAjaxCandidates(html) {
  const scripts = [...String(html || '').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  const sources = scripts.length ? scripts : [String(html || '')];
  const found = [];
  const seen = new Set();
  for (const script of sources) {
    const actions = [...script.matchAll(/(?:["']action["']\s*:\s*|\baction\s*[:=]\s*)["']([^"']+)["']/gi)];
    const ids = [...script.matchAll(/(?:["']a["']\s*:\s*|\ba\s*[:=]\s*)["']?(\d+)["']?/gi)];
    for (const action of actions) {
      // Pair the action with the nearest numeric `a` parameter in the same script.
      const id = ids.map(m => ({ value: m[1], distance: Math.abs(m.index - action.index) }))
        .filter(m => m.distance <= 500).sort((a, b) => a.distance - b.distance)[0];
      if (!id) continue;
      const candidate = { action: action[1], a: id.value };
      const key = `${candidate.action}|${candidate.a}`;
      if (!seen.has(key)) { seen.add(key); found.push(candidate); }
    }
  }
  // Older templates provide the request body as `var data = {...}`.
  const data = extractJsObject(String(html || ''), 'data');
  if (data && typeof data === 'object' && data.action && (data.a != null || data.id != null)) {
    const candidate = { action: String(data.action), a: String(data.a ?? data.id) };
    const key = `${candidate.action}|${candidate.a}`;
    if (!seen.has(key)) found.push(candidate);
  }
  return found.slice(0, 5);
}
function parsePayload(value) {
  if (typeof value !== 'string') return value;
  let payload = value.trim();
  for (let i = 0; i < 2; i++) {
    try { payload = JSON.parse(payload); } catch { break; }
    if (typeof payload !== 'string') break;
  }
  return payload;
}
async function resolveHentaiMamaStreams(episodeUrl) {
  const base = 'https://hentaimama.io';
  const streams = [];
  const seen = new Set();
  const addSources = (value, referer) => {
    for (const url of extractPlayerMedia(value, referer)) {
      if (seen.has(url)) continue;
      seen.add(url);
      streams.push(streamObject('HentaiMama', url, referer, false, value));
    }
  };
  const addPlayerFrames = async (frames, referer, cookies = '') => {
    for (const frameUrl of frames.slice(0, 6)) {
      try {
        const response = await http.get(frameUrl, {
          responseType: 'text',
          headers: { Referer: referer, ...(cookies ? { Cookie: cookies } : {}) },
        });
        const playerHtml = String(response.data || '');
        addSources(playerHtml, frameUrl);
        if (!streams.length) {
          const nested = await resolveStreams('HentaiMama', frameUrl, 'hentaimama');
          for (const stream of nested) {
            if (stream.url && !seen.has(stream.url)) { seen.add(stream.url); streams.push(stream); }
          }
        }
        if (streams.length >= 8) break;
      } catch (e) {
        console.warn(`[HentaiMama] player mirror failed (${frameUrl}): ${e.code || e.response?.status || e.message}`);
      }
    }
  };

  try {
    const pageResponse = await http.get(episodeUrl, { responseType: 'text' });
    const pageHtml = String(pageResponse.data || '');
    const cookies = (pageResponse.headers?.['set-cookie'] || []).map(v => String(v).split(';')[0]).filter(Boolean).join('; ');

    // Some mirrors expose a direct source without AJAX. Parse it before making requests.
    addSources(pageHtml, episodeUrl);
    if (streams.length) return streams.slice(0, 8);

    // HentaiMama's player selector uses WordPress AJAX on the episode page. A single
    // `var data` object is not guaranteed; inspect all inline scripts for action + a.
    const ajaxCandidates = extractHentaiMamaAjaxCandidates(pageHtml);
    for (const candidate of ajaxCandidates) {
      try {
        const postBody = new URLSearchParams({ action: candidate.action, a: candidate.a }).toString();
        const ajaxResponse = await http.post(`${base}/wp-admin/admin-ajax.php`, postBody, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Referer: episodeUrl,
            Origin: base,
            ...(cookies ? { Cookie: cookies } : {}),
            'X-Requested-With': 'XMLHttpRequest',
          },
        });
        const payload = parsePayload(ajaxResponse.data);
        addSources(payload, episodeUrl);
        if (streams.length) return streams.slice(0, 8);
        const frames = extractPlayerFrames(payload, base);
        if (frames.length) await addPlayerFrames(frames, episodeUrl, cookies);
        if (streams.length) return streams.slice(0, 8);
      } catch (e) {
        console.warn(`[HentaiMama] AJAX candidate ${candidate.action}/${candidate.a} failed: ${e.code || e.response?.status || e.message}`);
      }
    }

    // Different templates place player iframes directly on the page or inside escaped embed code.
    const pageFrames = extractPlayerFrames(pageHtml, episodeUrl);
    if (pageFrames.length) await addPlayerFrames(pageFrames, episodeUrl, cookies);
    if (streams.length) return streams.slice(0, 8);

    // Last resort: recurse through embedded players, but return only direct media URLs.
    const nested = await resolveStreams('HentaiMama', episodeUrl, 'hentaimama');
    for (const stream of nested) {
      if (stream.url && !seen.has(stream.url)) { seen.add(stream.url); streams.push(stream); }
    }
  } catch (e) {
    console.warn(`[HentaiMama] stream extraction failed (${episodeUrl}): ${e.code || e.response?.status || e.message}`);
  }
  return streams.filter(stream => Boolean(stream.url)).slice(0, 8);
}

function htmlProvider(config) {
  return {
    ...config,
    async catalog(args) { return fetchCatalog(config, args); },
    async meta(key) {
      const data = await pageMeta(key, config);
      if (!data.poster) {
        const cards = parseCards(await getHtml(key, config.base), key);
        if (cards[0]) data.poster = cards[0].poster;
      }
      return data;
    },
    async streams(key) { return config.id === 'hentaimama' ? resolveHentaiMamaStreams(key) : resolveStreams(config.name, key, config.id); },
  };
}

const hentaimama = htmlProvider({ id: 'hentaimama', name: 'HentaiMama', base: process.env.HENTAIMAMA_BASE || 'https://hentaimama.io', listPaths: ['/recent-episodes/', '/'], genrePaths: ['/genre/{g}/'] });
const hentaigasm = htmlProvider({ id: 'hentaigasm', name: 'Hentaigasm', base: process.env.HENTAIGASM_BASE || 'https://hentaigasm.com', listPaths: ['/'], genrePaths: ['/genre/{g}/', '/tag/{g}/', '/category/{g}/'] });
const hentaismile = htmlProvider({ id: 'hentaismile', name: 'HentaiSmile', base: process.env.HENTAISMILE_BASE || 'https://www.hentaismile.com', listPaths: ['/latest-updates/'], genrePaths: ['/tags/{g}/'], searchPaths: ['/search/{q}/', '/search/{q}/page/{page}/'] });

const anirena = {
  id: 'anirena',
  name: 'Hentai Anime Community Releases',
  base: ANIRENA_BASE,
  async catalog(args) { return fetchAniRenaCatalog(args); },
  async meta(key) { return fetchAniRenaMeta(key); },
  async streams(key) { return resolveAniRenaStreams(key); },
};

const tokyotosho = {
  id: 'tokyotosho',
  name: 'Hentai Anime Community Torrents',
  base: TOKYOTOSHO_BASE,
  async catalog(args) { return fetchTokyoToshoCatalog(args); },
  async meta(key) { return fetchTokyoToshoMeta(key); },
  async streams(key) { return resolveTokyoToshoStreams(key); },
};

const hentaiocean = {
  id: 'hentaiocean',
  name: 'HentaiOcean Streaming Archive',
  base: HENTAIOCEAN_BASE,
  async catalog(args) { return fetchHentaiOceanCatalog(args); },
  async meta(key) { return fetchHentaiOceanMeta(key); },
  async streams(key) { return resolveHentaiOceanStreams(key); },
};

const PROVIDERS = { hentaimama, hentaigasm, hentaismile, tokyotosho, hentaiocean };
const makeExtra = genres => [
  { name: 'search', isRequired: false },
  ...(genres?.length ? [{ name: 'genre', isRequired: false, options: genres, optionsLimit: 1 }] : []),
  { name: 'skip', isRequired: false },
];
const catalogs = [{ type: TYPE, id: 'hn-all', name: 'Hentai Hub - All Providers', extra: makeExtra(GENRES) }, ...Object.values(PROVIDERS).map(p => ({ type: TYPE, id: `hn-${p.id}`, name: p.name, extra: makeExtra(PROVIDER_GENRES[p.id]) }))];
const manifest = { id: 'community.hentai.hub', version: '2.6.7', name: 'Hentai Hub', description: 'Adult anime catalogs across multiple providers. Adults 18+ only.', resources: ['catalog','meta','stream'], types: [TYPE], idPrefixes: ['hn:'], catalogs, behaviorHints: { adult: true, configurable: false } };
const builder = new addonBuilder(manifest);
const makeId = (providerId, key) => `hn:${providerId}:${encodeKey(key)}`;
function parseId(id) {
  const parts = String(id || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'hn') return null;
  try { return { providerId: parts[1], key: decodeKey(parts[2]) }; } catch { return null; }
}
function selectedProviders(id) {
  if (id === 'hn-all') return Object.values(PROVIDERS);
  const name = String(id || '').replace(/^hn-/, '');
  return PROVIDERS[name] ? [PROVIDERS[name]] : [];
}

async function collectProviderCatalog(provider, { search = '', genre = '', target = PAGE_SIZE, maxPages } = {}) {
  const desired = Math.max(1, Number(target) || PAGE_SIZE);
  const pageCap = Math.min(3000, Math.max(1, Number(maxPages) || Math.ceil(desired / 8) + 2));
  const list = [];
  const seenKeys = new Set();
  const seenPages = new Set();
  for (let page = 1; page <= pageCap; page++) {
    let pageItems;
    try {
      pageItems = await provider.catalog({ search, genre, page });
    } catch (e) {
      console.error(`[${provider.name}] catalog failed at ${provider.catalogUrl || provider.base || 'unknown URL'} (source page ${page}): ${e.code || e.response?.status || e.message}`);
      break;
    }
    if (!pageItems || !pageItems.length) break;
    const fingerprint = catalogPageFingerprint(pageItems);
    if (seenPages.has(fingerprint)) break;
    seenPages.add(fingerprint);
    let newItems = 0;
    for (const item of pageItems) {
      const key = String(item.key || '');
      if (!key || !item.name || !item.poster || blocked(item)) continue;
      let duplicateKey = key;
      if (provider.id === 'hentaimama') {
        let posterKey = String(item.poster).split('?')[0].split('#')[0].toLowerCase();
        try {
          const posterUrl = new URL(posterKey);
          posterUrl.hostname = canonicalHost(posterUrl.hostname);
          posterKey = posterUrl.href;
        } catch {}
        duplicateKey = `${normalizedTextKey(item.name)}|${posterKey}`;
      }
      if (seenKeys.has(duplicateKey)) continue;
      seenKeys.add(duplicateKey);
      list.push({ ...item, providerId: provider.id });
      newItems++;
    }
    if (list.length >= desired || newItems === 0) break;
  }
  return list;
}
function interleaveCatalogLists(providerLists) {
  const combined = [];
  for (let i = 0; providerLists.some(list => i < list.length); i++) {
    for (const list of providerLists) if (list[i]) combined.push(list[i]);
  }
  return combined;
}

builder.defineCatalogHandler(async ({ id, extra = {} }) => {
  const selected = selectedProviders(id);
  if (!selected.length) return { metas: [], cacheMaxAge: 300 };
  const search = clean(extra.search);
  const genre = clean(extra.genre);
  const skip = Math.max(0, Number(extra.skip) || 0);

  // Stremio skip counts addon items, not upstream pages. Fetch source pages until
  // each provider contributes enough unique items, then apply skip in the combined catalog.
  const targetPerProvider = Math.ceil((skip + PAGE_SIZE) / selected.length);
  const maxSourcePages = Math.min(3000, Math.max(2, Math.ceil(targetPerProvider / 8) + 2));
  const providerLists = await Promise.all(selected.map(provider => collectProviderCatalog(provider, {
    search, genre, target: targetPerProvider, maxPages: maxSourcePages,
  })));
  let artworkLists = providerLists.flat();
  if (selected.some(provider => provider.id === 'tokyotosho')) {
    const usableArtworkCount = artworkLists.filter(item => item.providerId !== 'tokyotosho' && item?.poster
      && !/\/favicon\.|placeholder/i.test(String(item.poster))).length;
    // All-provider catalogs apportion only a few rows per source; fetch a wider art
    // pool even when HentaiMama/HentaiOcean are selected, or Tokyo cards retain icons.
    if (usableArtworkCount < 30) {
      const artworkProviders = [PROVIDERS.hentaiocean, PROVIDERS.hentaimama].filter(Boolean);
      const fetchedArtwork = await Promise.all(artworkProviders.map(provider => collectProviderCatalog(provider, {
        search: '', genre: '', target: PAGE_SIZE, maxPages: 1,
      }).catch(() => [])));
      artworkLists = artworkLists.concat(...fetchedArtwork);
    }
    for (const list of providerLists) applyCommunityPosterMatches(list, artworkLists);
    const unmatchedCommunity = providerLists.flat().filter(item => item.providerId === 'tokyotosho' && /\/favicon\./i.test(String(item.poster || '')));
    if (unmatchedCommunity.length) await fetchAniListCommunityPosters(unmatchedCommunity);
  }
  const combined = interleaveCatalogLists(providerLists);
  const metas = combined.slice(skip, skip + PAGE_SIZE).map(item => ({
    id: makeId(item.providerId, item.key),
    type: TYPE,
    name: item.name,
    poster: item.poster,
    posterShape: posterShapeFor(item, genre),
    ...(item.description ? { description: item.description } : {}),
    ...(item.genres?.length ? { genres: item.genres } : {}),
  }));
  return { metas, cacheMaxAge: Math.floor(CATALOG_TTL / 1000) };
});

builder.defineMetaHandler(async ({ id }) => {
  const parsed = parseId(id); if (!parsed) return { meta: null };
  const provider = PROVIDERS[parsed.providerId]; if (!provider) return { meta: null };
  try {
    const data = await provider.meta(parsed.key);
    if (!data || data.blocked || blocked(data)) return { meta: null };
    const episodes = Array.isArray(data.episodes) && data.episodes.length ? data.episodes : [{ key: parsed.key, title: data.name }];
    const seen = new Set();
    const videos = episodes.filter(ep => ep.key && !seen.has(ep.key) && seen.add(ep.key)).map((ep, index) => ({ id: makeId(parsed.providerId, ep.key), title: clean(ep.title) || `Part ${index + 1}`, season: 1, episode: index + 1, released: new Date(Date.UTC(2000, 0, 1 + index)).toISOString() }));
    return { meta: { id, type: TYPE, name: clean(data.name) || 'Untitled', ...(data.poster ? { poster: data.poster } : {}), ...(data.background || data.poster ? { background: data.background || data.poster } : {}), ...(data.description ? { description: data.description } : {}), ...(data.genres?.length ? { genres: data.genres } : {}), videos }, cacheMaxAge: Math.floor(DETAIL_TTL / 1000) };
  } catch (e) { console.error(`[${provider.name}] metadata failed: ${e.code || e.response?.status || e.message}`); return { meta: null, cacheMaxAge: 60 }; }
});

builder.defineStreamHandler(async ({ id }) => {
  const parsed = parseId(id); if (!parsed) return { streams: [] };
  const provider = PROVIDERS[parsed.providerId]; if (!provider) return { streams: [] };
  try {
    const ttl = parsed.providerId === 'hentaigasm' ? STREAM_TTL : FRESH_STREAM_TTL;
    const streams = await cached(`streams:${parsed.providerId}:${parsed.key}`, ttl, async () => {
      const resolved = await provider.streams(parsed.key);
      return expandHlsQualityStreams(resolved || []);
    });
    return { streams: (streams || []).slice(0, 20), cacheMaxAge: Math.floor(ttl / 1000) };
  } catch (e) { console.error(`[${provider.name}] streams failed: ${e.code || e.response?.status || e.message}`); return { streams: [], cacheMaxAge: 60 }; }
});

if (require.main === module) {
  serveHTTP(builder.getInterface(), { port: PORT });
  console.log(`Hentai Hub v2.6.7 listening on port ${PORT}`);
  console.log(`Manifest: http://127.0.0.1:${PORT}/manifest.json`);
}

module.exports = { manifest, PROVIDERS, PROVIDER_GENRES, communityLooksNonVideo, fetchHentaiOceanCatalog, fetchHentaiOceanMeta, resolveHentaiOceanStreams, parseHentaiOceanCards, parseHentaiOceanRss, hentaiOceanSlugFromUrl, hentaiOceanThumbnail, communityPosterScore, communityArtworkSearchTitle, fetchAniListCommunityPosters, applyCommunityPosterMatches, normalizeInfoHash, aniRenaInfoHash, aniRenaTorrentId, isAniRenaUrl, isTokyoToshoUrl, tokyoToshoMagnet, torrentFileInfoHash, parseTokyoToshoRss, parseTokyoToshoCards, parseTokyoToshoReleaseKey, fetchTokyoToshoCatalog, fetchTokyoToshoMeta, discoverTokyoToshoHash, resolveTokyoToshoStreams, isHentaiOceanUrl, parseAniRenaRss, parseAniRenaReleaseKey, fetchAniRenaCatalog, resolveAniRenaStreams, discoverAniRenaHash, parseCards, parseStructuredCards, candidatePages, discoverPaginationUrls, fetchCatalog, candidateStreams, candidateHentaiSmileStreams, extractHentaiSmileTargetConfig, hentaiSmileTargetObjectSegments, streamNameForUrl, hentaiSmileVideoId, detectExplicitQuality, posterShapeFor, streamObject, parseHlsVariantPlaylist, expandHlsQualityStreams, extractMedia, extractMediaLegacy, candidateStreamsLegacy, parseHentaiSmileCards, parseHentaiMamaGenreCards, parseHentaiMamaRecentEpisodeCards, cleanVideoTitle, hentaiSmileTitleMatchesSlug, titleFromEpisodeUrl, tightCard, parseProviderCards, extractJsObject, extractPlayerFrame, extractPlayerFrames, extractPlayerMedia, extractHentaiMamaAjaxCandidates, expandEncodedPlayerText, normalizedTextKey, sameProviderHost, blocked, absUrl, canonicalContentUrl, genreSlug, resolveHentaiMamaStreams, resolveStreams, collectProviderCatalog, interleaveCatalogLists };
