// ===== Constants =====
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let feedData = null;
let refreshTimer = null;
let countdownTimer = null;
let nextRefreshTime = null;

// ===== DOM Helpers =====
const $ = (sel) => document.querySelector(sel);
const show = (el) => el.removeAttribute('hidden');
const hide = (el) => el.setAttribute('hidden', '');

// ===== Format Helpers =====
function formatDuration(seconds) {
  if (!seconds) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDate(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-AU', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

function timeAgo(dateStr) {
  if (!dateStr) return null;
  try {
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const diff = now - then;
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 30) return `${days}d ago`;
    return formatDate(dateStr);
  } catch {
    return formatDate(dateStr);
  }
}

function formatCountdown(ms) {
  if (ms <= 0) return 'now';
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== Render Functions =====
function renderHero(item) {
  const hero = $('#hero');
  if (!item || !item.thumbnail) {
    hide(hero);
    return;
  }

  const duration = formatDuration(item.duration);
  const date = timeAgo(item.pubDate);

  hero.innerHTML = `
    <div class="hero-card" onclick="openModal(0)">
      <img src="${escapeHtml(item.thumbnail)}" alt="${escapeHtml(item.title)}" loading="eager">
      <div class="hero-overlay">
        ${item.categories?.[0] ? `<span class="card-category">${escapeHtml(item.categories[0])}</span>` : ''}
        <h2>${escapeHtml(item.title)}</h2>
        <p>${escapeHtml(item.description)}</p>
        <div class="hero-meta">
          ${date ? `<span>${date}</span>` : ''}
          ${duration ? `<span>${duration}</span>` : ''}
        </div>
      </div>
    </div>
  `;
  show(hero);
}

function renderCard(item, index) {
  const duration = formatDuration(item.duration);
  const date = timeAgo(item.pubDate);
  const category = item.categories?.[0];

  return `
    <article class="card" onclick="openModal(${index})">
      <div class="card-thumb">
        ${item.thumbnail
          ? `<img src="${escapeHtml(item.thumbnail)}" alt="${escapeHtml(item.title)}" loading="lazy">`
          : ''}
        ${duration ? `<span class="card-duration">${duration}</span>` : ''}
      </div>
      <div class="card-body">
        <h3 class="card-title">${escapeHtml(item.title)}</h3>
        <p class="card-desc">${escapeHtml(item.description)}</p>
        <div class="card-meta">
          ${category ? `<span class="card-category">${escapeHtml(category)}</span>` : ''}
          ${date ? `<span>${date}</span>` : ''}
        </div>
      </div>
    </article>
  `;
}

function renderFeed(data) {
  feedData = data;
  const items = data.items || [];

  if (items.length === 0) {
    $('#feed-grid').innerHTML = '<p style="color:var(--color-text-muted);text-align:center;padding:2rem;">No content available.</p>';
    hide($('#hero'));
    return;
  }

  // First item as hero
  renderHero(items[0]);

  // Rest as grid cards
  const gridItems = items.slice(1);
  $('#feed-grid').innerHTML = gridItems.map((item, i) => renderCard(item, i + 1)).join('');

  // Update header meta
  const fetchedAt = data.fetchedAt ? formatDate(data.fetchedAt) : 'Unknown';
  $('#last-updated').textContent = `Updated: ${fetchedAt}`;
}

// ===== Modal =====
function openModal(index) {
  if (!feedData?.items?.[index]) return;
  const item = feedData.items[index];

  const duration = formatDuration(item.duration);
  const date = formatDate(item.pubDate);

  let html = '';

  if (item.thumbnail) {
    html += `<img class="modal-detail-thumb" src="${escapeHtml(item.thumbnail)}" alt="${escapeHtml(item.title)}">`;
  }

  html += `<h2 class="modal-detail-title">${escapeHtml(item.title)}</h2>`;

  html += '<div class="modal-detail-meta">';
  if (date) html += `<span>${date}</span>`;
  if (duration) html += `<span>${duration}</span>`;
  if (item.rating) html += `<span>Rating: ${escapeHtml(item.rating)}</span>`;
  html += '</div>';

  if (item.categories?.length) {
    html += '<div class="modal-detail-categories">';
    item.categories.forEach((c) => {
      html += `<span class="card-category">${escapeHtml(c)}</span>`;
    });
    html += '</div>';
  }

  if (item.description) {
    html += `<p class="modal-detail-desc">${escapeHtml(item.description)}</p>`;
  }

  if (item.keywords?.length) {
    html += `<p class="modal-detail-keywords"><strong>Keywords:</strong> ${item.keywords.map(escapeHtml).join(', ')}</p>`;
  }

  if (item.credits?.length) {
    html += '<p class="modal-detail-keywords">';
    item.credits.forEach((c) => {
      html += `<strong>${escapeHtml(c.role || 'Credit')}:</strong> ${escapeHtml(c.value)}<br>`;
    });
    html += '</p>';
  }

  if (item.link) {
    html += `<a href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer" class="modal-detail-link">Watch on SBS</a>`;
  }

  $('#modal-body').innerHTML = html;
  show($('#modal'));
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  hide($('#modal'));
  document.body.style.overflow = '';
}

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

// ===== Feed Loading =====
async function loadFeed(forceRefresh = false) {
  const loadingEl = $('#loading');
  const errorEl = $('#error');
  const heroEl = $('#hero');
  const gridEl = $('#feed-grid');

  hide(errorEl);
  show(loadingEl);
  hide(heroEl);
  gridEl.innerHTML = '';

  try {
    const url = forceRefresh ? '/api/feed?refresh=true' : '/api/feed';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    hide(loadingEl);
    renderFeed(data);
    scheduleNextRefresh();
  } catch (err) {
    console.error('Failed to load feed:', err);
    hide(loadingEl);
    show(errorEl);
  }
}

// ===== 24-Hour Refresh =====
function scheduleNextRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (countdownTimer) clearInterval(countdownTimer);

  nextRefreshTime = Date.now() + REFRESH_INTERVAL_MS;

  // Update countdown display
  countdownTimer = setInterval(() => {
    const remaining = nextRefreshTime - Date.now();
    if (remaining <= 0) {
      $('#next-refresh').textContent = 'Refreshing...';
      clearInterval(countdownTimer);
    } else {
      $('#next-refresh').textContent = `Next refresh: ${formatCountdown(remaining)}`;
    }
  }, 60000); // Update every minute

  // Show initial countdown
  $('#next-refresh').textContent = `Next refresh: ${formatCountdown(REFRESH_INTERVAL_MS)}`;

  // Schedule the actual refresh
  refreshTimer = setTimeout(() => {
    loadFeed(true);
  }, REFRESH_INTERVAL_MS);
}

// ===== Init =====
loadFeed();
