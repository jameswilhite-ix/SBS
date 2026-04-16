// ===== State =====
const REFRESH_MS = 24 * 60 * 60 * 1000;
let feedData = null;
let currentView = 'schedule';
let currentSeries = 'all';
let searchQuery = '';
let refreshTimer = null;
let countdownTimer = null;
let nextRefreshTime = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const show = (el) => el.removeAttribute('hidden');
const hide = (el) => el.setAttribute('hidden', '');

// ===== Formatters =====
function fmtDuration(sec) {
  if (!sec) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDate(str) {
  if (!str) return null;
  try { return new Date(str).toLocaleDateString('en-AU', { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return str; }
}

function fmtDatetime(str) {
  if (!str) return null;
  try {
    const d = new Date(str);
    return d.toLocaleDateString('en-AU', { year: 'numeric', month: 'short', day: 'numeric' })
      + ' ' + d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
  } catch { return str; }
}

function timeAgo(str) {
  if (!str) return null;
  try {
    const diff = Date.now() - new Date(str).getTime();
    const m = Math.floor(diff / 60000);
    const h = Math.floor(diff / 3600000);
    const d = Math.floor(diff / 86400000);
    if (m < 60) return `${m}m ago`;
    if (h < 24) return `${h}h ago`;
    if (d < 30) return `${d}d ago`;
    return fmtDate(str);
  } catch { return fmtDate(str); }
}

function fmtCountdown(ms) {
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ===== Filtering =====
function getFilteredItems() {
  if (!feedData?.items) return [];
  return feedData.items.filter((item) => {
    if (currentSeries !== 'all' && !item.series.includes(currentSeries)) return false;
    if (searchQuery && !(item.title || '').toLowerCase().includes(searchQuery)) return false;
    return true;
  });
}

// ===== Series Targeting Panel =====
function renderTargetingPanel() {
  const container = $('#series-tags');
  if (!feedData?.allSeries || Object.keys(feedData.allSeries).length === 0) {
    container.innerHTML = '<span style="color:var(--text-muted);font-size:0.82rem;">No series detected in current feed.</span>';
    return;
  }

  const knownKeys = feedData.knownSeriesKeys || [];

  container.innerHTML = Object.entries(feedData.allSeries).map(([key, label]) => {
    const count = feedData.items.filter((i) => i.series.includes(key)).length;
    const isKnown = knownKeys.includes(key);
    return `
      <div class="series-tag">
        <span class="series-tag-key">${esc(key)}</span>
        <span class="series-tag-label">${esc(label)}</span>
        <span class="series-tag-count">${count} items</span>
        <button class="series-tag-copy" onclick="copySeries(event, '${esc(key)}')" title="Copy series value">Copy</button>
        ${isKnown ? '<span style="color:var(--green);font-size:0.65rem;">INDEX</span>' : ''}
      </div>
    `;
  }).join('');
}

function copySeries(e, key) {
  e.stopPropagation();
  navigator.clipboard.writeText(key).then(() => {
    const btn = e.target;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
  });
}

// ===== Filter Chips =====
function renderFilterChips() {
  const container = $('#series-filters');
  let html = '<button class="chip active" data-series="all" onclick="filterBySeries(\'all\')">All Content</button>';

  if (feedData?.allSeries) {
    const knownKeys = feedData.knownSeriesKeys || [];
    // Show known series first, then discovered
    const sorted = Object.entries(feedData.allSeries).sort(([a], [b]) => {
      const aKnown = knownKeys.includes(a) ? 0 : 1;
      const bKnown = knownKeys.includes(b) ? 0 : 1;
      return aKnown - bKnown;
    });

    for (const [key, label] of sorted) {
      html += `<button class="chip" data-series="${esc(key)}" onclick="filterBySeries('${esc(key)}')">${esc(label)}</button>`;
    }
  }

  container.innerHTML = html;
}

function filterBySeries(series) {
  currentSeries = series;
  $$('#series-filters .chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.series === series);
  });
  renderContent();
}

// ===== Search =====
$('#search-input').addEventListener('input', (e) => {
  searchQuery = e.target.value.toLowerCase().trim();
  renderContent();
});

// ===== View Toggle =====
function setView(view) {
  currentView = view;
  $$('.view-toggle .chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.view === view);
  });
  if (view === 'schedule') { show($('#schedule-view')); hide($('#grid-view')); }
  else { hide($('#schedule-view')); show($('#grid-view')); }
  renderContent();
}

// ===== Schedule View =====
function renderScheduleView(items) {
  const container = $('#schedule-list');

  if (items.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);padding:2rem;text-align:center;">No items match your filters.</p>';
    return;
  }

  // Group items by series (or "Uncategorized")
  const groups = {};
  for (const item of items) {
    const seriesKeys = item.series.length > 0 ? item.series : ['_uncategorized'];
    for (const s of seriesKeys) {
      if (!groups[s]) groups[s] = [];
      groups[s].push(item);
    }
  }

  // Sort: known series first, then alphabetical
  const knownKeys = feedData?.knownSeriesKeys || [];
  const sortedGroups = Object.entries(groups).sort(([a], [b]) => {
    if (a === '_uncategorized') return 1;
    if (b === '_uncategorized') return -1;
    const aK = knownKeys.includes(a) ? 0 : 1;
    const bK = knownKeys.includes(b) ? 0 : 1;
    if (aK !== bK) return aK - bK;
    return a.localeCompare(b);
  });

  let html = '';
  for (const [seriesKey, groupItems] of sortedGroups) {
    const label = seriesKey === '_uncategorized'
      ? 'Other Content'
      : (feedData?.allSeries?.[seriesKey] || seriesKey);
    const isKnown = knownKeys.includes(seriesKey);

    html += `<div class="schedule-group-header">${esc(label)}${isKnown ? ' <span style="color:var(--green);">[Index Exchange]</span>' : ''} (${groupItems.length})</div>`;

    for (const item of groupItems) {
      const idx = feedData.items.indexOf(item);
      const duration = fmtDuration(item.duration);
      const date = item.schedule?.pubDate ? fmtDate(item.schedule.pubDate) : null;
      const availDate = item.schedule?.availableDate ? fmtDatetime(item.schedule.availableDate) : null;

      html += `
        <div class="schedule-row" onclick="openModal(${idx})">
          ${item.thumbnail
            ? `<img class="schedule-thumb" src="${esc(item.thumbnail)}" alt="" loading="lazy">`
            : '<div class="schedule-thumb"></div>'}
          <div class="schedule-info">
            <div class="schedule-title">${esc(item.title)}</div>
            ${item.description ? `<div class="schedule-desc">${esc(item.description)}</div>` : ''}
            <div class="schedule-series-tags">
              ${item.series.map((s) =>
                `<span class="series-pill ${knownKeys.includes(s) ? 'known' : ''}">${esc(s)}</span>`
              ).join('')}
            </div>
          </div>
          <div class="schedule-date">${availDate || date || ''}</div>
          <div class="schedule-duration">${duration || ''}</div>
        </div>
      `;
    }
  }

  container.innerHTML = html;
}

// ===== Grid View =====
function renderGridView(items) {
  const container = $('#feed-grid');

  if (items.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);padding:2rem;text-align:center;">No items match your filters.</p>';
    return;
  }

  const knownKeys = feedData?.knownSeriesKeys || [];

  container.innerHTML = items.map((item) => {
    const idx = feedData.items.indexOf(item);
    const duration = fmtDuration(item.duration);
    const date = timeAgo(item.pubDate);

    return `
      <article class="card" onclick="openModal(${idx})">
        <div class="card-thumb">
          ${item.thumbnail ? `<img src="${esc(item.thumbnail)}" alt="" loading="lazy">` : ''}
          ${duration ? `<span class="card-duration">${duration}</span>` : ''}
        </div>
        <div class="card-body">
          <h3 class="card-title">${esc(item.title)}</h3>
          <div class="card-meta">
            ${item.series.map((s) =>
              `<span class="series-pill ${knownKeys.includes(s) ? 'known' : ''}">${esc(s)}</span>`
            ).join('')}
            ${date ? `<span>${date}</span>` : ''}
          </div>
        </div>
      </article>
    `;
  }).join('');
}

// ===== Render =====
function renderContent() {
  const items = getFilteredItems();
  if (currentView === 'schedule') renderScheduleView(items);
  else renderGridView(items);
  $('#item-count').textContent = `${items.length} items`;
}

// ===== Modal =====
function openModal(index) {
  const item = feedData?.items?.[index];
  if (!item) return;

  const knownKeys = feedData?.knownSeriesKeys || [];
  const duration = fmtDuration(item.duration);
  const pubDate = fmtDatetime(item.schedule?.pubDate);
  const availDate = fmtDatetime(item.schedule?.availableDate);
  const expDate = fmtDatetime(item.schedule?.expirationDate);
  const airDate = fmtDatetime(item.schedule?.airDate);

  let html = '';

  if (item.thumbnail) {
    html += `<img class="modal-thumb" src="${esc(item.thumbnail)}" alt="">`;
  }

  html += `<h2 class="modal-title">${esc(item.title)}</h2>`;

  // Series pills
  if (item.series.length > 0) {
    html += '<div class="modal-series">';
    item.series.forEach((s) => {
      html += `<span class="series-pill ${knownKeys.includes(s) ? 'known' : ''}" style="font-size:0.8rem;padding:3px 12px;">${esc(s)}</span>`;
    });
    html += '</div>';
  }

  // Meta
  html += '<div class="modal-meta">';
  if (pubDate) html += `<span>Published: ${pubDate}</span>`;
  if (duration) html += `<span>Duration: ${duration}</span>`;
  if (item.rating) html += `<span>Rating: ${esc(item.rating)}</span>`;
  html += '</div>';

  if (item.description) {
    html += `<p class="modal-desc">${esc(item.description)}</p>`;
  }

  // Schedule / Dayparting
  if (availDate || expDate || airDate) {
    html += '<p class="modal-section-title">Schedule / Dayparting</p>';
    html += '<dl class="modal-kv">';
    if (airDate) html += `<dt>Air Date</dt><dd>${airDate}</dd>`;
    if (availDate) html += `<dt>Available From</dt><dd>${availDate}</dd>`;
    if (expDate) html += `<dt>Expires</dt><dd>${expDate}</dd>`;
    html += '</dl>';
  }

  // Index Exchange targeting
  if (item.series.length > 0) {
    html += '<p class="modal-section-title">Index Exchange Targeting</p>';
    html += '<dl class="modal-kv">';
    item.series.forEach((s) => {
      html += `<dt>series</dt><dd>${esc(s)}</dd>`;
    });
    html += '</dl>';
  }

  // Categories
  if (item.categories?.length) {
    html += '<p class="modal-section-title">Categories</p>';
    html += '<div style="display:flex;gap:0.3rem;flex-wrap:wrap;margin-bottom:0.5rem;">';
    item.categories.forEach((c) => {
      html += `<span class="chip" style="cursor:default;">${esc(c.label)}${c.scheme ? ` <small style="color:var(--text-muted);">(${esc(c.scheme)})</small>` : ''}</span>`;
    });
    html += '</div>';
  }

  // Keywords
  if (item.keywords?.length) {
    html += `<p class="modal-section-title">Keywords</p>`;
    html += `<p style="font-size:0.82rem;color:var(--text-muted);">${item.keywords.map(esc).join(', ')}</p>`;
  }

  // Link
  if (item.link) {
    html += `<a href="${esc(item.link)}" target="_blank" rel="noopener noreferrer" class="modal-link">View on SBS</a>`;
  }

  // Raw custom fields (collapsible)
  if (item.customFields && Object.keys(item.customFields).length > 0) {
    html += `
      <button class="raw-toggle" onclick="this.nextElementSibling.toggleAttribute('hidden')">Show Raw Feed Fields</button>
      <div class="raw-fields" hidden>${esc(JSON.stringify(item.customFields, null, 2))}</div>
    `;
  }

  $('#modal-body').innerHTML = html;
  show($('#modal'));
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  hide($('#modal'));
  document.body.style.overflow = '';
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

// ===== Feed Loading =====
async function loadFeed(forceRefresh = false) {
  hide($('#error'));
  show($('#loading'));
  hide($('#schedule-view'));
  hide($('#grid-view'));

  try {
    const url = forceRefresh ? '/api/feed?refresh=true' : '/api/feed';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    feedData = await res.json();

    hide($('#loading'));
    if (currentView === 'schedule') show($('#schedule-view'));
    else show($('#grid-view'));

    renderTargetingPanel();
    renderFilterChips();
    renderContent();

    const fetchedAt = feedData.fetchedAt ? fmtDatetime(feedData.fetchedAt) : 'Unknown';
    $('#last-updated').textContent = `Updated: ${fetchedAt}`;

    scheduleNextRefresh();
  } catch (err) {
    console.error('Failed to load feed:', err);
    hide($('#loading'));
    show($('#error'));
  }
}

// ===== 24-Hour Auto Refresh =====
function scheduleNextRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (countdownTimer) clearInterval(countdownTimer);

  nextRefreshTime = Date.now() + REFRESH_MS;

  countdownTimer = setInterval(() => {
    const remaining = nextRefreshTime - Date.now();
    $('#next-refresh').textContent = remaining <= 0
      ? 'Refreshing...'
      : `Next refresh: ${fmtCountdown(remaining)}`;
    if (remaining <= 0) clearInterval(countdownTimer);
  }, 60000);

  $('#next-refresh').textContent = `Next refresh: ${fmtCountdown(REFRESH_MS)}`;
  refreshTimer = setTimeout(() => loadFeed(true), REFRESH_MS);
}

// ===== Init =====
loadFeed();
