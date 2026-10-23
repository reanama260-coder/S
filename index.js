'use strict';

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

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
  hentaicity: ['3D','Anal','Babe','Big Dick','Big Tits','Blowjob','Cartoon','Comics','Cumshot','Fetish','Futanari','Gay','Groupsex','Hentai','Lesbian','Masturbation','Mature','Monster','Rough Sex','Teen','Toys','Voyeur'],
};

const http = axios.create({
  timeout: Number(process.env.HTTP_TIMEOUT_MS || 15000),
  maxRedirects: 5,
  headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  validateStatus: status => status >= 200 && status < 400,
});

const cache = new Map();
async function cached(key, ttl, fn) {
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) return entry.value;
  const value = await fn();
  cache.set(key, { value, expires: Date.now() + ttl });
  if (cache.size > 1500) {
    for (const [k, v] of cache) if (v.expires <= Date.now()) cache.delete(k);
    while (cache.size > 1500) cache.delete(cache.keys().next().value);
  }
  return value;
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
    if (providerId === 'hentaicity') {
      const clickPrefix = u.pathname.match(/^\/click\/[^/]+\/video\/(.+)$/i);
      if (clickPrefix) u.pathname = `/video/${clickPrefix[1]}`;
    }
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
    if (providerId === 'hentaicity') parts = parts.filter(p => p !== 'click' && p !== 'video');
    let slug = parts[parts.length - 1] || '';
    slug = slug.replace(/\.(?:html?|php)$/i, '');
    if (providerId === 'hentaicity') slug = slug.replace(/-[A-Z0-9]{8,}$/i, '');
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
async function getHtmlFresh(url, referer, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (referer) headers.Referer = referer;
  const response = await http.get(url, { headers, responseType: 'text' });
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
    hentaicity: {
      'big breasts': 'big-tits', 'big tits': 'big-tits', 'group': 'groupsex',
      'deep throat': 'blowjob', 'creampie': 'cumshot', 'threesome': 'groupsex',
      'rough': 'rough-sex', 'rough sex': 'rough-sex',
    },
  };
  return (aliases[config.id] && aliases[config.id][raw]) || slugify(genre);
}
function candidatePagesEnhanced(config, { search, genre, page = 1 }) {
  const base = config.base.replace(/\/$/, '');
  const n = Math.max(1, Number(page) || 1);
  const q = encodeURIComponent(clean(search));
  const g = genreSlug(config, genre);

  if (config.id === 'hentaicity') {
    if (search) {
      const custom = (config.searchPaths || []).map(path => `${base}${path.replace('{q}', q).replace('{page}', n)}`);
      return [...new Set([
        ...custom,
        `${base}/videos/straight/search.html?q=${q}${n > 1 ? `&page=${n}` : ''}`,
        `${base}/?q=${q}${n > 1 ? `&page=${n}` : ''}`,
      ])];
    }
    if (genre) {
      const genreRoutes = (config.genrePaths || []).map(path => `${base}${path.replace('{g}', g)}`);
      const routes = genreRoutes.flatMap(route => {
        if (n === 1) return [route];
        if (/\.html?$/i.test(route)) return [route.replace(/\.html?$/i, '') + `-${n}.html`, `${route}?page=${n}`, `${route}?paged=${n}`];
        return [pagePath(base, route.replace(base, ''), n), `${route}?page=${n}`, `${route}?paged=${n}`];
      });
      return [...new Set(routes)];
    }
    const listRoutes = (config.listPaths || ['/']).map(path => `${base}${path.startsWith('/') ? path : `/${path}`}`);
    return [...new Set(listRoutes.flatMap(route => {
      if (n === 1) return [route];
      if (/\.html?$/i.test(route)) return [route.replace(/\.html?$/i, '') + `-${n}.html`, `${route}?page=${n}`, `${route}?paged=${n}`];
      return [pagePath(base, route.replace(base, ''), n), `${route}?page=${n}`, `${route}?paged=${n}`];
    }))];
  }

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
  const itemLinks = providerId === 'hentaismile' ? 'a[href*="/videos/"]'
    : providerId === 'hentaicity' ? 'a[href*="/click/"][href*="/video/"],a[href*="/video/"]'
    : 'a[href]';
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
function parseHentaiCityCards(html, base) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('a[href]').each((_, el) => {
    const $a = $(el);
    const rawUrl = absUrl($a.attr('href'), base);
    if (!rawUrl || !sameProviderHost(rawUrl, base)) return;
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return; }
    if (!/^\/click\/[^/]+\/video\/.+\.html?$/i.test(parsed.pathname) && !/^\/video\/.+\.html?$/i.test(parsed.pathname)) return;
    const key = canonicalContentUrl('hentaicity', rawUrl, base);
    if (!key || seen.has(key)) return;
    const $box = tightCard($, $a, base, 'hentaicity');
    const poster = cardPoster($, $box, $a, base);
    const candidateNames = [
      clean($box.find('.title,.video-title,.video-name,h2,h3,h4,[class*=\"title\"]').first().text()),
      clean($a.attr('title') || $a.attr('aria-label')),
      clean($box.find('img').first().attr('alt')),
      clean($a.text()),
      titleFromUrl(key, 'hentaicity'),
    ].map(cleanVideoTitle);
    let name = candidateNames.find(v => v && v.length > 2 && !/^(?:hd)?\d{1,2}:\d{2}(?::\d{2})?$/i.test(v)) || '';
    name = cleanVideoTitle(name);
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
  if (config.id === 'hentaicity') return parseHentaiCityCards(html, base);
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
    if (providerId === 'hentaicity' && !/\/videos\/straight\//i.test(path)) return;
    if (providerId === 'hentaimama' && /\/episodes\//i.test(path)) return;
    if (/\/(?:login|register|sign-up|wp-admin|wp-json)\//i.test(path)) return;
    const parents = $a.parents().toArray().slice(0, 5).map(node => `${node.attribs?.class || ''} ${node.attribs?.id || ''}`).join(' ');
    const score = (isNumericTarget ? 10 : 0) + (/pagination|pager|page-nav|pages-list|nav-links/i.test(`${parents} ${$a.attr('class') || ''}`) ? 5 : 0) + (providerId === 'hentaicity' && /\.html?$/i.test(path) ? 3 : 0);
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

function posterShapeFor(item, genre) {
  return clean(genre) && item?.providerId === 'hentaimama' ? 'poster' : 'landscape';
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

async function resolveStreams(providerName, pageUrl, providerId = '') {
  const streams = [];
  const streamUrls = new Set();
  const visited = new Set();
  const queue = [{ url: pageUrl, referer: pageUrl, depth: 0, html: null }];
  const hentaiSmileTargetId = providerId === 'hentaismile' ? hentaiSmileVideoId(pageUrl) : '';
  const maxDepth = Number(process.env.EMBED_DEPTH || (providerId === 'hentaigasm' ? 3 : 5));
  const maxPages = Number(process.env.EMBED_PAGE_LIMIT || (providerId === 'hentaigasm' ? 18 : 24));

  while (queue.length && visited.size < maxPages) {
    const current = queue.shift();
    if (!current?.url || visited.has(current.url) || current.depth > maxDepth) continue;
    visited.add(current.url);
    try {
      const html = current.html ?? (providerId === 'hentaigasm' ? await getHtml(current.url, current.referer) : await getHtmlFresh(current.url, current.referer));
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
const hentaicity = htmlProvider({ id: 'hentaicity', name: 'HentaiCity', base: process.env.HENTAICITY_BASE || 'https://www.hentaicity.com', listPaths: ['/videos/straight/all-recent.html'], genrePaths: ['/videos/straight/{g}-popular.html'], searchPaths: ['/search/{q}/'] });

const PROVIDERS = { hentaimama, hentaigasm, hentaismile, hentaicity };
const makeExtra = genres => [{ name: 'search', isRequired: false }, { name: 'genre', isRequired: false, options: genres, optionsLimit: 1 }, { name: 'skip', isRequired: false }];
const catalogs = [{ type: TYPE, id: 'hn-all', name: 'Hentai Hub - All Providers', extra: makeExtra(GENRES) }, ...Object.values(PROVIDERS).map(p => ({ type: TYPE, id: `hn-${p.id}`, name: p.name, extra: makeExtra(PROVIDER_GENRES[p.id] || GENRES) }))];
const manifest = { id: 'community.hentai.hub', version: '2.5.4', name: 'Hentai Hub', description: 'Adult anime catalog across multiple providers. Adults 18+ only.', resources: ['catalog','meta','stream'], types: [TYPE], idPrefixes: ['hn:'], catalogs, behaviorHints: { adult: true, configurable: false } };
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

  // Stremio skip counts addon items, not upstream pages. Some providers return 20
  // cards per page while HentaiCity returns considerably more. Fetch upstream pages
  // from page 1 until each provider contributes enough unique items, then apply skip.
  const targetPerProvider = Math.ceil((skip + PAGE_SIZE) / selected.length);
  const maxSourcePages = Math.min(3000, Math.max(2, Math.ceil(targetPerProvider / 8) + 2));
  const providerLists = await Promise.all(selected.map(provider => collectProviderCatalog(provider, {
    search, genre, target: targetPerProvider, maxPages: maxSourcePages,
  })));
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
  console.log(`Hentai Hub v2.5.4 listening on port ${PORT}`);
  console.log(`Manifest: http://127.0.0.1:${PORT}/manifest.json`);
}

module.exports = { manifest, PROVIDERS, PROVIDER_GENRES, parseCards, parseStructuredCards, candidatePages, discoverPaginationUrls, fetchCatalog, candidateStreams, candidateHentaiSmileStreams, extractHentaiSmileTargetConfig, hentaiSmileTargetObjectSegments, streamNameForUrl, hentaiSmileVideoId, detectExplicitQuality, posterShapeFor, streamObject, parseHlsVariantPlaylist, expandHlsQualityStreams, extractMedia, extractMediaLegacy, candidateStreamsLegacy, parseHentaiSmileCards, parseHentaiCityCards, parseHentaiMamaGenreCards, parseHentaiMamaRecentEpisodeCards, cleanVideoTitle, hentaiSmileTitleMatchesSlug, titleFromEpisodeUrl, tightCard, parseProviderCards, extractJsObject, extractPlayerFrame, extractPlayerFrames, extractPlayerMedia, extractHentaiMamaAjaxCandidates, expandEncodedPlayerText, normalizedTextKey, sameProviderHost, blocked, absUrl, canonicalContentUrl, genreSlug, resolveHentaiMamaStreams, resolveStreams, collectProviderCatalog, interleaveCatalogLists };
