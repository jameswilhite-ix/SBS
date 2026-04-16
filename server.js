const express = require('express');
const https = require('https');
const http = require('http');
const { parseString } = require('xml2js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const FEED_URL = 'https://feed.theplatform.com/f/Bgtm9B/sbs-telaria';

// Known series mappings: series key -> patterns to match in titles/categories
const KNOWN_SERIES = {
  tourdefrance: {
    label: 'Tour de France',
    patterns: ['tour de france'],
  },
  fifaworldcup: {
    label: 'FIFA World Cup',
    patterns: ['fifa world cup', 'fifa women\'s world cup'],
  },
};

let feedCache = { data: null, lastFetched: null };
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'SBS-MRSS-Reader/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function extractText(val) {
  if (val == null) return null;
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return extractText(val[0]);
  if (typeof val === 'object' && val._) return val._;
  if (typeof val === 'object' && val.$) return val.$.url || val.$.href || null;
  return String(val);
}

function extractAttr(val, attr) {
  if (val == null) return null;
  if (Array.isArray(val)) return extractAttr(val[0], attr);
  if (typeof val === 'object' && val.$ && val.$[attr]) return val.$[attr];
  return null;
}

// Detect series from title, categories, and any explicit series fields
function detectSeries(title, categories, item, mediaGroup) {
  const matches = [];
  const searchText = (title || '').toLowerCase();

  // Check explicit thePlatform series fields
  const seriesFields = [
    'pl1:seriesTitle', 'pl:seriesTitle', 'plcategory$series',
    'pl1:series', 'pl:series', 'sbs:series',
  ];
  for (const field of seriesFields) {
    const val = extractText(item[field]?.[0] || mediaGroup?.[field]?.[0]);
    if (val) {
      // Map explicit field values to known series keys
      const lower = val.toLowerCase().replace(/\s+/g, '');
      for (const [key, cfg] of Object.entries(KNOWN_SERIES)) {
        if (lower.includes(key) || cfg.patterns.some((p) => lower.includes(p.replace(/\s+/g, '')))) {
          matches.push(key);
        }
      }
      // If no known series matched but there's an explicit value, use it as-is
      if (matches.length === 0) {
        matches.push(val.toLowerCase().replace(/\s+/g, ''));
      }
    }
  }

  // Check categories for series scheme
  for (const cat of categories) {
    if (cat.scheme && cat.scheme.toLowerCase().includes('series') && cat.value) {
      const lower = cat.value.toLowerCase().replace(/\s+/g, '');
      for (const [key, cfg] of Object.entries(KNOWN_SERIES)) {
        if (lower.includes(key) || cfg.patterns.some((p) => lower.includes(p.replace(/\s+/g, '')))) {
          if (!matches.includes(key)) matches.push(key);
        }
      }
    }
  }

  // Fallback: match title against known series patterns
  if (matches.length === 0) {
    for (const [key, cfg] of Object.entries(KNOWN_SERIES)) {
      if (cfg.patterns.some((p) => searchText.includes(p))) {
        matches.push(key);
      }
    }
  }

  return [...new Set(matches)];
}

// Extract categories with scheme info
function extractCategories(item, mediaGroup) {
  const cats = [];
  const sources = [
    ...(item['media:category'] || []),
    ...((mediaGroup && mediaGroup !== item) ? (mediaGroup['media:category'] || []) : []),
    ...(item.category || []),
  ];
  for (const c of sources) {
    if (typeof c === 'string') {
      cats.push({ label: c, scheme: null, value: c });
    } else if (c && typeof c === 'object') {
      cats.push({ label: c._ || extractText(c), scheme: c.$?.scheme || null, value: c._ || extractText(c) });
    }
  }
  return cats;
}

// Search for scheduling/dayparting fields
function findField(item, mediaGroup, fieldNames) {
  for (const name of fieldNames) {
    const val = item[name]?.[0] || mediaGroup?.[name]?.[0];
    if (val != null) return extractText(val);
  }
  return null;
}

// Extract all namespaced fields for raw inspection
function extractAllCustomFields(item) {
  const custom = {};
  for (const [key, val] of Object.entries(item)) {
    if (key.includes(':') || key.includes('$')) {
      if (Array.isArray(val)) {
        custom[key] = val.map((v) => {
          if (typeof v === 'string') return v;
          if (v && typeof v === 'object') return { text: v._ || null, attrs: v.$ || null };
          return v;
        });
      } else {
        custom[key] = val;
      }
    }
  }
  return custom;
}

function parseFeedItems(xml) {
  return new Promise((resolve, reject) => {
    parseString(xml, {
      explicitArray: true,
      mergeAttrs: false,
      normalize: true,
      normalizeTags: false,
    }, (err, result) => {
      if (err) return reject(err);

      const channel = result.rss?.channel?.[0] || {};
      const rawItems = channel.item || [];

      const items = rawItems.map((item) => {
        const mediaGroup = item['media:group']?.[0] || item;
        const mediaContent = mediaGroup['media:content'] || item['media:content'] || [];

        // Video URL + duration
        let videoUrl = null;
        let videoDuration = null;
        for (const mc of mediaContent) {
          const url = mc?.$?.url;
          const type = mc?.$?.type || '';
          const dur = mc?.$?.duration;
          if (url) {
            videoUrl = url;
            if (dur) videoDuration = parseInt(dur, 10);
          }
          if (type.includes('video')) break;
        }

        // Thumbnails
        const thumbnails = (mediaGroup['media:thumbnail'] || item['media:thumbnail'] || [])
          .map((t) => ({
            url: t?.$?.url,
            width: t?.$?.width ? parseInt(t.$.width, 10) : null,
            height: t?.$?.height ? parseInt(t.$.height, 10) : null,
          }))
          .filter((t) => t.url);

        const thumbnail = thumbnails.length > 0
          ? thumbnails.reduce((best, t) => (t.width || 0) > (best.width || 0) ? t : best, thumbnails[0])
          : null;

        // Categories
        const categories = extractCategories(item, mediaGroup);

        // Series detection
        const series = detectSeries(
          extractText(item.title?.[0]) || extractText(mediaGroup['media:title']?.[0]),
          categories, item, mediaGroup
        );

        // Scheduling / dayparting
        const availableDate = findField(item, mediaGroup, [
          'pl1:availableDate', 'pl:availableDate', 'dcterms:valid', 'media:valid',
        ]);
        const expirationDate = findField(item, mediaGroup, [
          'pl1:expirationDate', 'pl:expirationDate',
        ]);
        const airDate = findField(item, mediaGroup, [
          'pl1:originalAirDate', 'pl:originalAirDate', 'pl1:airDate', 'pl:airDate',
        ]);

        // Keywords
        const keywords = (mediaGroup['media:keywords'] || item['media:keywords'] || [])
          .map((k) => extractText(k))
          .filter(Boolean)
          .flatMap((k) => k.split(',').map((s) => s.trim()));

        // Rating
        const rating = extractText((item['media:rating'] || mediaGroup['media:rating'] || [])[0]);

        // Credits
        const credits = (item['media:credit'] || mediaGroup['media:credit'] || [])
          .map((c) => ({ role: extractAttr(c, 'role'), value: extractText(c) }))
          .filter((c) => c.value);

        // GUID to detect A/B variants
        const guid = extractText(item.guid?.[0]);

        return {
          title: extractText(item.title?.[0]) || extractText(mediaGroup['media:title']?.[0]),
          description: extractText(item.description?.[0]) || extractText(mediaGroup['media:description']?.[0]),
          link: extractText(item.link?.[0]),
          guid,
          pubDate: extractText(item.pubDate?.[0]),
          videoUrl,
          duration: videoDuration,
          thumbnail: thumbnail?.url || null,
          categories,
          series,
          keywords,
          rating,
          credits,
          schedule: { availableDate, expirationDate, airDate, pubDate: extractText(item.pubDate?.[0]) },
          customFields: extractAllCustomFields(item),
        };
      });

      // Deduplicate A/B variants: group by base title (strip trailing A/B suffix from GUID)
      const deduped = [];
      const seen = new Set();
      for (const item of items) {
        // The feed has items with same title but GUIDs like 12345, 12345A, 12345B
        // Use title as the dedup key
        const key = item.title;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        deduped.push(item);
      }

      // Collect all unique series
      const allSeries = {};
      for (const item of deduped) {
        for (const s of item.series) {
          if (!allSeries[s]) {
            allSeries[s] = KNOWN_SERIES[s]?.label || s;
          }
        }
      }

      // Infer series groups from titles for items without a known series
      const titleGroups = {};
      for (const item of deduped) {
        if (item.series.length === 0) {
          // Try to group by common prefix patterns
          const title = item.title || '';
          // Match patterns like "Series Name S2024 Ep3 - ..." or "Event: ..."
          const prefixMatch = title.match(/^(.+?)(?:\s+S\d{4}|\s+-\s+|\s*:\s*)/);
          if (prefixMatch) {
            const group = prefixMatch[1].trim();
            if (!titleGroups[group]) titleGroups[group] = 0;
            titleGroups[group]++;
          }
        }
      }

      // Series with 2+ items are likely real series - add them as discovered
      for (const [group, count] of Object.entries(titleGroups)) {
        if (count >= 2) {
          const key = group.toLowerCase().replace(/[^a-z0-9]+/g, '');
          if (!allSeries[key]) {
            allSeries[key] = group;
            // Tag items retroactively
            for (const item of deduped) {
              if (item.series.length === 0 && item.title && item.title.startsWith(group)) {
                item.series.push(key);
              }
            }
          }
        }
      }

      resolve({
        channel: {
          title: extractText(channel.title?.[0]),
          link: extractText(channel.link?.[0]),
          description: extractText(channel.description?.[0]),
        },
        items: deduped,
        totalRawItems: items.length,
        allSeries,
        knownSeriesKeys: Object.keys(KNOWN_SERIES),
        fetchedAt: new Date().toISOString(),
      });
    });
  });
}

async function getFeedData(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && feedCache.data && feedCache.lastFetched && now - feedCache.lastFetched < CACHE_DURATION_MS) {
    return feedCache.data;
  }
  const xml = await fetchUrl(FEED_URL);
  const data = await parseFeedItems(xml);
  feedCache.data = data;
  feedCache.lastFetched = now;
  return data;
}

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// API: parsed feed with optional series filter
app.get('/api/feed', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const data = await getFeedData(forceRefresh);

    const seriesFilter = req.query.series;
    if (seriesFilter) {
      return res.json({
        ...data,
        items: data.items.filter((item) => item.series.includes(seriesFilter.toLowerCase())),
      });
    }
    res.json(data);
  } catch (err) {
    console.error('Error fetching feed:', err.message);
    if (feedCache.data) {
      res.json({ ...feedCache.data, stale: true, error: err.message });
    } else {
      res.status(502).json({ error: 'Failed to fetch MRSS feed', details: err.message });
    }
  }
});

// API: raw XML for inspection
app.get('/api/feed/raw', async (req, res) => {
  try {
    const xml = await fetchUrl(FEED_URL);
    res.type('application/xml').send(xml);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// API: debug view of parsed XML structure (first N items)
app.get('/api/feed/debug', async (req, res) => {
  try {
    const xml = await fetchUrl(FEED_URL);
    parseString(xml, { explicitArray: true, mergeAttrs: false }, (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      const count = Math.min(parseInt(req.query.count) || 3, 20);
      const items = result.rss?.channel?.[0]?.item?.slice(0, count) || [];
      res.json({ itemCount: result.rss?.channel?.[0]?.item?.length, sampleItems: items });
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Pre-fetch on startup
getFeedData().then(() => {
  console.log('Feed data pre-fetched successfully');
}).catch((err) => {
  console.error('Initial feed fetch failed:', err.message);
});

app.listen(PORT, () => {
  console.log(`SBS MRSS Feed UI running at http://localhost:${PORT}`);
});
