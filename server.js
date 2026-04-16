const express = require('express');
const https = require('https');
const http = require('http');
const { parseString } = require('xml2js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const FEED_URL = 'https://feed.theplatform.com/f/Bgtm9B/sbs-telaria';

// In-memory cache for the feed data
let feedCache = {
  data: null,
  lastFetched: null,
};

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
  if (typeof val === 'object' && val.$) return val.$.url || val.$.href || JSON.stringify(val.$);
  return String(val);
}

function extractAttr(val, attr) {
  if (val == null) return null;
  if (Array.isArray(val)) return extractAttr(val[0], attr);
  if (typeof val === 'object' && val.$ && val.$[attr]) return val.$[attr];
  return null;
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
        // Media content - could be under media:content or media:group
        const mediaGroup = item['media:group']?.[0] || item;
        const mediaContent = mediaGroup['media:content'] || item['media:content'] || [];

        // Find the best video URL
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
          if (type.includes('video')) break; // Prefer video type
        }

        // Thumbnails
        const thumbnails = (mediaGroup['media:thumbnail'] || item['media:thumbnail'] || [])
          .map((t) => ({
            url: t?.$?.url,
            width: t?.$?.width ? parseInt(t.$.width, 10) : null,
            height: t?.$?.height ? parseInt(t.$.height, 10) : null,
          }))
          .filter((t) => t.url);

        // Pick best thumbnail (largest)
        const thumbnail = thumbnails.length > 0
          ? thumbnails.reduce((best, t) =>
              (t.width || 0) > (best.width || 0) ? t : best, thumbnails[0])
          : null;

        // Categories
        const categories = (item['media:category'] || item.category || [])
          .map((c) => extractText(c))
          .filter(Boolean);

        // Keywords
        const keywords = (mediaGroup['media:keywords'] || item['media:keywords'] || [])
          .map((k) => extractText(k))
          .filter(Boolean)
          .flatMap((k) => k.split(',').map((s) => s.trim()));

        // Rating
        const rating = extractText(
          (item['media:rating'] || mediaGroup['media:rating'] || [])[0]
        );

        // Credit
        const credits = (item['media:credit'] || mediaGroup['media:credit'] || [])
          .map((c) => ({
            role: extractAttr(c, 'role'),
            value: extractText(c),
          }))
          .filter((c) => c.value);

        return {
          title: extractText(item.title?.[0]) || extractText(mediaGroup['media:title']?.[0]),
          description: extractText(item.description?.[0]) || extractText(mediaGroup['media:description']?.[0]),
          link: extractText(item.link?.[0]),
          guid: extractText(item.guid?.[0]),
          pubDate: extractText(item.pubDate?.[0]),
          videoUrl,
          duration: videoDuration,
          thumbnail: thumbnail?.url || null,
          thumbnails,
          categories,
          keywords,
          rating,
          credits,
        };
      });

      resolve({
        channel: {
          title: extractText(channel.title?.[0]),
          link: extractText(channel.link?.[0]),
          description: extractText(channel.description?.[0]),
        },
        items,
        fetchedAt: new Date().toISOString(),
      });
    });
  });
}

async function getFeedData(forceRefresh = false) {
  const now = Date.now();
  if (
    !forceRefresh &&
    feedCache.data &&
    feedCache.lastFetched &&
    now - feedCache.lastFetched < CACHE_DURATION_MS
  ) {
    return feedCache.data;
  }

  const xml = await fetchUrl(FEED_URL);
  const data = await parseFeedItems(xml);
  feedCache.data = data;
  feedCache.lastFetched = now;
  return data;
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// API endpoint for feed data
app.get('/api/feed', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const data = await getFeedData(forceRefresh);
    res.json(data);
  } catch (err) {
    console.error('Error fetching feed:', err.message);
    // Return cached data if available, even if stale
    if (feedCache.data) {
      res.json({ ...feedCache.data, stale: true, error: err.message });
    } else {
      res.status(502).json({ error: 'Failed to fetch MRSS feed', details: err.message });
    }
  }
});

// Pre-fetch feed data on startup
getFeedData().then(() => {
  console.log('Feed data pre-fetched successfully');
}).catch((err) => {
  console.error('Initial feed fetch failed:', err.message);
});

app.listen(PORT, () => {
  console.log(`SBS MRSS Feed UI running at http://localhost:${PORT}`);
});
