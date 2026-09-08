// ============================================================
// SahamCompress — Main Application Logic
// ============================================================

// ============================================================
// APP STATE
// ============================================================
const App = {
  // Google Apps Script deployment URL — user must set this
  apiUrl: localStorage.getItem('sahamcompress_api_url') || '',

  // Current tab
  activeTab: 'dashboard',

  // Cached data
  dashboardData: null,
  runningTrades: [],
  doneTrades: [],
  screenerResults: [],

  // Scanning state
  isScanning: false,
  scanProgress: 0,
  scanTotal: 0,

  // Sort state
  sortColumn: null,
  sortDirection: 'asc',

  // Auto-refresh interval (ms)
  refreshInterval: 5 * 60 * 1000, // 5 minutes
  refreshTimer: null,
};

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initClock();
  initApiUrl();
  loadCachedData();

  if (App.apiUrl) {
    refreshAllData();
    startAutoRefresh();
  }
});

function initTabs() {
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      switchTab(target);
    });
  });
}

function switchTab(tabName) {
  App.activeTab = tabName;

  // Update nav
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.nav-tab[data-tab="${tabName}"]`)?.classList.add('active');

  // Update panels
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`panel-${tabName}`)?.classList.add('active');
}

function initClock() {
  const updateClock = () => {
    const now = new Date();
    const el = document.getElementById('clock');
    if (el) {
      el.textContent = now.toLocaleTimeString('id-ID', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZone: 'Asia/Jakarta'
      }) + ' WIB';
    }
  };
  updateClock();
  setInterval(updateClock, 1000);
}

function initApiUrl() {
  const input = document.getElementById('api-url-input');
  const saveBtn = document.getElementById('api-url-save');

  if (input) input.value = App.apiUrl;

  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const url = input.value.trim();
      if (!url) {
        showToast('URL tidak boleh kosong', 'error');
        return;
      }
      App.apiUrl = url;
      localStorage.setItem('sahamcompress_api_url', url);
      showToast('API URL tersimpan', 'success');
      refreshAllData();
      startAutoRefresh();
    });
  }
}

// ============================================================
// API CALLS
// ============================================================

async function apiGet(action, params = {}) {
  if (!App.apiUrl) {
    showToast('Set Apps Script URL terlebih dahulu', 'error');
    throw new Error('API URL not set');
  }

  const url = new URL(App.apiUrl);
  url.searchParams.set('action', action);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function apiPost(action, body = {}) {
  if (!App.apiUrl) {
    showToast('Set Apps Script URL terlebih dahulu', 'error');
    throw new Error('API URL not set');
  }

  const response = await fetch(App.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// ============================================================
// DATA LOADING
// ============================================================

async function refreshAllData() {
  if (!App.apiUrl) return;

  setConnectionStatus(true);
  try {
    await Promise.all([
      loadDashboard(),
      loadRunningTrades(),
      loadDoneTrades(),
      loadTickerCount(),
    ]);
    showToast('Data berhasil di-refresh', 'success');
  } catch (err) {
    console.error('Refresh error:', err);
    setConnectionStatus(false);
    showToast('Gagal refresh data: ' + err.message, 'error');
  }
}

async function loadDashboard() {
  try {
    const data = await apiGet('getDashboard');
    App.dashboardData = data;
    cacheData('dashboard', data);
    renderDashboard(data);
  } catch (err) {
    console.error('Dashboard error:', err);
  }
}

async function loadRunningTrades() {
  try {
    const data = await apiGet('getRunning');
    App.runningTrades = data.trades || [];
    cacheData('running', data);
    renderRunningTrades(App.runningTrades);
    updateTabBadge('running', App.runningTrades.length);
  } catch (err) {
    console.error('Running trades error:', err);
  }
}

async function loadDoneTrades() {
  try {
    const data = await apiGet('getDone');
    App.doneTrades = data.trades || [];
    cacheData('done', data);
    renderDoneTrades(App.doneTrades, data);
    updateTabBadge('done', App.doneTrades.length);
  } catch (err) {
    console.error('Done trades error:', err);
  }
}

// ============================================================
// AUTO REFRESH & CHECK TRADES
// ============================================================

function startAutoRefresh() {
  if (App.refreshTimer) clearInterval(App.refreshTimer);
  App.refreshTimer = setInterval(() => {
    refreshAllData();
  }, App.refreshInterval);
}

async function checkTrades() {
  const btn = document.getElementById('btn-check-trades');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Checking...';
  }

  try {
    const result = await apiGet('checkTrades');
    showToast(`Trades checked. ${result.movedToDone || 0} trade(s) completed.`, 'success');
    await refreshAllData();
  } catch (err) {
    showToast('Error checking trades: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '🔄 Check TP/SL';
    }
  }
}

// ============================================================
// SCREENER
// ============================================================

async function startScan() {
  if (App.isScanning) return;

  const presetEl = document.getElementById('scan-preset');
  const thresholdEl = document.getElementById('scan-threshold');
  const preset = presetEl ? presetEl.value : 'all';
  const threshold = thresholdEl ? parseFloat(thresholdEl.value) : 5;

  App.isScanning = true;
  App.screenerResults = [];
  App.scanProgress = 0;

  updateScanUI(true);
  renderScreenerResults([]);

  // Mode: scan from spreadsheet (auto) or from hardcoded list
  if (preset === 'from-sheet') {
    // Use scanAuto endpoint — reads tickers from sheet, auto-saves results
    updateScanProgress(0, 100, 'Scanning from Ticker List sheet...');
    try {
      const result = await apiGet('scanAuto', { threshold: threshold.toString() });

      if (result.error) {
        showToast(result.error, 'error');
      } else if (result.results) {
        App.screenerResults = result.results;
        renderScreenerResults(result.results);
        showToast(
          `✅ Scan selesai: ${result.found} compressed dari ${result.total} saham. Auto-saved ke spreadsheet.`,
          'success'
        );
      }
    } catch (err) {
      showToast('Scan error: ' + err.message, 'error');
    }

    App.isScanning = false;
    updateScanUI(false);
    updateScanProgress(100, 100, 'Scan complete!');
    setTimeout(() => {
      const pc = document.getElementById('scan-progress');
      if (pc) pc.classList.remove('visible');
    }, 3000);
    return;
  }

  // Manual mode: use hardcoded lists with batching
  let tickers;
  switch (preset) {
    case 'lq45': tickers = IDX_LQ45; break;
    case 'idx30': tickers = IDX_IDX30; break;
    default: tickers = IDX_TICKERS;
  }

  App.scanTotal = tickers.length;

  // Batch scan (50 tickers per batch to avoid timeout)
  const batchSize = 50;
  const allResults = [];
  const allErrors = [];

  for (let i = 0; i < tickers.length; i += batchSize) {
    if (!App.isScanning) break; // cancelled

    const batch = tickers.slice(i, i + batchSize);
    App.scanProgress = i;
    updateScanProgress(i, tickers.length, `Scanning batch ${Math.floor(i/batchSize)+1}...`);

    try {
      const result = await apiGet('scan', {
        tickers: batch.join(','),
        threshold: threshold.toString()
      });

      if (result.results) {
        allResults.push(...result.results);
        // Live update results
        App.screenerResults = allResults;
        renderScreenerResults(allResults);
      }
      if (result.errors) {
        allErrors.push(...result.errors);
      }
    } catch (err) {
      console.error(`Batch error at ${i}:`, err);
    }
  }

  App.isScanning = false;
  App.screenerResults = allResults;
  updateScanUI(false);
  updateScanProgress(tickers.length, tickers.length, 'Scan complete!');

  showToast(
    `Scan selesai: ${allResults.length} saham compressed dari ${tickers.length} total. ${allErrors.length} error.`,
    'success'
  );

  // Hide progress after 3s
  setTimeout(() => {
    const pc = document.getElementById('scan-progress');
    if (pc) pc.classList.remove('visible');
  }, 3000);
}

/**
 * Scrape IDX tickers from idx.co.id and save to Ticker List sheet
 */
async function scrapeTickers() {
  const btn = document.getElementById('btn-scrape-tickers');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Scraping IDX...';
  }

  try {
    const result = await apiGet('scrapeTickers', { fallbackTickers: IDX_TICKERS.join(',') });
    if (result.error) {
      showToast('Scrape gagal: ' + result.error, 'error');
    } else {
      showToast(`✅ ${result.count} ticker IDX berhasil di-scrape & disimpan ke spreadsheet!`, 'success');
      // Update ticker count display
      const countEl = document.getElementById('ticker-count');
      if (countEl) countEl.textContent = result.count + ' tickers';
    }
  } catch (err) {
    showToast('Scrape error: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '🌐 Scrape IDX Tickers';
    }
  }
}

/**
 * Load ticker count from sheet for display
 */
async function loadTickerCount() {
  try {
    const result = await apiGet('getTickerList');
    const countEl = document.getElementById('ticker-count');
    if (countEl) {
      countEl.textContent = result.count > 0 ? result.count + ' tickers' : 'Empty — scrape first';
    }
  } catch (err) {
    // ignore
  }
}

function stopScan() {
  App.isScanning = false;
  updateScanUI(false);
  showToast('Scan dibatalkan', 'info');
}

function updateScanUI(scanning) {
  const startBtn = document.getElementById('btn-start-scan');
  const stopBtn = document.getElementById('btn-stop-scan');
  if (startBtn) startBtn.style.display = scanning ? 'none' : 'inline-flex';
  if (stopBtn) stopBtn.style.display = scanning ? 'inline-flex' : 'none';
}

function updateScanProgress(current, total, text) {
  const container = document.getElementById('scan-progress');
  const fill = document.getElementById('scan-progress-fill');
  const label = document.getElementById('scan-progress-label');
  const count = document.getElementById('scan-progress-count');

  if (container) container.classList.add('visible');
  if (fill) fill.style.width = `${(current / total * 100).toFixed(1)}%`;
  if (label) label.textContent = text || 'Scanning...';
  if (count) count.textContent = `${current}/${total}`;
}

// ============================================================
// TAKE TRADE (from Screener)
// ============================================================

function showTakeTradeModal(stockData) {
  const modal = document.getElementById('trade-modal');
  if (!modal) return;

  // Fill modal with data
  document.getElementById('modal-ticker').textContent = stockData.ticker;
  document.getElementById('modal-price').textContent = formatPrice(stockData.close);
  document.getElementById('modal-compression').textContent = stockData.compressionRatio + '%';
  document.getElementById('modal-breakout').textContent =
    stockData.breakoutSignal === 'confirmed' ? '✅ Confirmed' :
    stockData.breakoutSignal === 'potential' ? '⚡ Potential' : '—';

  if (stockData.fibonacci) {
    document.getElementById('modal-tp1').textContent = formatPrice(stockData.fibonacci.tp1) + ` (+${stockData.fibonacci.tp1Pct}%)`;
    document.getElementById('modal-tp2').textContent = formatPrice(stockData.fibonacci.tp2) + ` (+${stockData.fibonacci.tp2Pct}%)`;
    document.getElementById('modal-sl').textContent = formatPrice(stockData.fibonacci.sl) + ` (${stockData.fibonacci.slPct}%)`;
  } else {
    document.getElementById('modal-tp1').textContent = 'N/A';
    document.getElementById('modal-tp2').textContent = 'N/A';
    document.getElementById('modal-sl').textContent = 'N/A';
  }

  // Store data for confirm action
  modal.dataset.stockData = JSON.stringify(stockData);
  modal.classList.add('visible');
}

function closeTakeTradeModal() {
  const modal = document.getElementById('trade-modal');
  if (modal) modal.classList.remove('visible');
}

async function confirmTakeTrade() {
  const modal = document.getElementById('trade-modal');
  if (!modal) return;

  const stockData = JSON.parse(modal.dataset.stockData || '{}');
  if (!stockData.ticker) return;

  const trade = {
    ticker: stockData.ticker,
    buyPrice: stockData.close,
    tp1: stockData.fibonacci ? stockData.fibonacci.tp1 : 0,
    tp2: stockData.fibonacci ? stockData.fibonacci.tp2 : 0,
    cl: stockData.fibonacci ? stockData.fibonacci.sl : 0,
  };

  try {
    const result = await apiPost('addTrade', { trade });
    if (result.success) {
      showToast(`✅ Trade ${stockData.ticker} ditambahkan ke Running`, 'success');
      closeTakeTradeModal();
      await loadRunningTrades();
    } else {
      showToast('Gagal menambahkan trade: ' + (result.error || 'Unknown'), 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// ============================================================
// RENDERING — DASHBOARD
// ============================================================

function renderDashboard(data) {
  if (!data) return;

  const r = data.running || {};
  const d = data.done || {};

  // Stat cards
  setStatValue('stat-running', r.count || 0);
  setStatValue('stat-win-rate', (d.winRate || 0) + '%', d.winRate >= 50 ? 'positive' : 'negative');
  setStatValue('stat-total-tp', d.hitTP || 0);
  setStatValue('stat-total-sl', d.hitSL || 0);
  setStatValue('stat-realized', (d.totalRealizedPct > 0 ? '+' : '') + (d.totalRealizedPct || 0) + '%',
    d.totalRealizedPct >= 0 ? 'positive' : 'negative');
  setStatValue('stat-floating', (r.totalFloatingPct > 0 ? '+' : '') + (r.totalFloatingPct || 0) + '%',
    r.totalFloatingPct >= 0 ? 'positive' : 'negative');

  // Details
  setStatDetail('stat-running', `${r.positive || 0} profit / ${r.negative || 0} loss`);
  setStatDetail('stat-total-tp', `TP1: ${d.hitTP1 || 0} · TP2: ${d.hitTP2 || 0}`);
  setStatDetail('stat-win-rate', `${d.hitTP || 0}W / ${d.hitSL || 0}L`);

  if (d.bestTrade) {
    setStatDetail('stat-realized', `Best: ${d.bestTrade.ticker} ${d.bestTrade.pnl}`);
  }

  // Render charts
  renderDistributionChart(d);
  renderEquityCurve(data);
}

function setStatValue(id, value, className) {
  const el = document.getElementById(id);
  if (!el) return;
  const valEl = el.querySelector('.stat-value');
  if (valEl) {
    valEl.textContent = value;
    valEl.className = 'stat-value' + (className ? ' ' + className : '');
  }
}

function setStatDetail(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  const detEl = el.querySelector('.stat-detail');
  if (detEl) detEl.textContent = text;
}

// ============================================================
// RENDERING — CHARTS (Canvas-based, no external library)
// ============================================================

function renderDistributionChart(doneData) {
  const canvas = document.getElementById('chart-distribution');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();

  canvas.width = rect.width * dpr;
  canvas.height = 220 * dpr;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = '220px';
  ctx.scale(dpr, dpr);

  const tp1 = doneData.hitTP1 || 0;
  const tp2 = doneData.hitTP2 || 0;
  const sl = doneData.hitSL || 0;
  const inv = doneData.invalid || 0;
  const total = tp1 + tp2 + sl + inv;

  if (total === 0) return;

  const slices = [
    { label: 'HIT TP1', value: tp1, color: '#00d4aa' },
    { label: 'HIT TP2', value: tp2, color: '#00ffcc' },
    { label: 'HIT SL', value: sl, color: '#ff4757' },
    { label: 'Invalid', value: inv, color: '#5a5b6e' },
  ].filter(s => s.value > 0);

  const cx = 110;
  const cy = 110;
  const radius = 85;
  const innerRadius = 50;
  let startAngle = -Math.PI / 2;

  for (const slice of slices) {
    const sliceAngle = (slice.value / total) * 2 * Math.PI;
    const endAngle = startAngle + sliceAngle;

    ctx.beginPath();
    ctx.arc(cx, cy, radius, startAngle, endAngle);
    ctx.arc(cx, cy, innerRadius, endAngle, startAngle, true);
    ctx.closePath();
    ctx.fillStyle = slice.color;
    ctx.fill();

    // Label
    const midAngle = startAngle + sliceAngle / 2;
    const labelR = radius + 18;
    const lx = cx + Math.cos(midAngle) * labelR;
    const ly = cy + Math.sin(midAngle) * labelR;
    ctx.fillStyle = '#8b8ca0';
    ctx.font = '11px JetBrains Mono';
    ctx.textAlign = 'center';
    ctx.fillText(`${slice.value}`, lx, ly);

    startAngle = endAngle;
  }

  // Center text
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 20px JetBrains Mono';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(total, cx, cy - 8);
  ctx.fillStyle = '#5a5b6e';
  ctx.font = '10px JetBrains Mono';
  ctx.fillText('TRADES', cx, cy + 10);

  // Legend on the right side
  let legendY = 30;
  for (const slice of slices) {
    const lx = 240;
    ctx.fillStyle = slice.color;
    ctx.fillRect(lx, legendY - 5, 10, 10);
    ctx.fillStyle = '#8b8ca0';
    ctx.font = '11px JetBrains Mono';
    ctx.textAlign = 'left';
    ctx.fillText(`${slice.label}: ${slice.value} (${((slice.value/total)*100).toFixed(0)}%)`, lx + 16, legendY + 3);
    legendY += 22;
  }
}

function renderEquityCurve(data) {
  const canvas = document.getElementById('chart-equity');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();

  canvas.width = rect.width * dpr;
  canvas.height = 220 * dpr;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = '220px';
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = 220;
  const padding = { top: 20, right: 20, bottom: 30, left: 50 };

  // Build equity curve from done trades
  const trades = App.doneTrades.filter(t => t.status !== 'invalid');
  if (trades.length === 0) return;

  let cumulative = 0;
  const points = [{ x: 0, y: 0 }];
  for (let i = 0; i < trades.length; i++) {
    const pnl = trades[i].buyPrice > 0
      ? ((trades[i].currentPrice - trades[i].buyPrice) / trades[i].buyPrice * 100)
      : 0;
    cumulative += pnl;
    points.push({ x: i + 1, y: cumulative });
  }

  const maxX = points.length - 1;
  const maxY = Math.max(...points.map(p => p.y), 10);
  const minY = Math.min(...points.map(p => p.y), -10);
  const rangeY = maxY - minY || 1;

  const chartW = w - padding.left - padding.right;
  const chartH = h - padding.top - padding.bottom;

  const toX = (x) => padding.left + (x / maxX) * chartW;
  const toY = (y) => padding.top + chartH - ((y - minY) / rangeY) * chartH;

  // Grid lines
  ctx.strokeStyle = '#1e1f32';
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const gy = padding.top + (chartH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, gy);
    ctx.lineTo(w - padding.right, gy);
    ctx.stroke();

    const val = maxY - (rangeY / 4) * i;
    ctx.fillStyle = '#5a5b6e';
    ctx.font = '10px JetBrains Mono';
    ctx.textAlign = 'right';
    ctx.fillText(val.toFixed(1) + '%', padding.left - 6, gy + 4);
  }

  // Zero line
  const zeroY = toY(0);
  ctx.strokeStyle = '#282940';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(padding.left, zeroY);
  ctx.lineTo(w - padding.right, zeroY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Gradient fill
  const gradient = ctx.createLinearGradient(0, padding.top, 0, h - padding.bottom);
  const lastY = points[points.length - 1].y;
  if (lastY >= 0) {
    gradient.addColorStop(0, 'rgba(0, 212, 170, 0.15)');
    gradient.addColorStop(1, 'rgba(0, 212, 170, 0)');
  } else {
    gradient.addColorStop(0, 'rgba(255, 71, 87, 0)');
    gradient.addColorStop(1, 'rgba(255, 71, 87, 0.15)');
  }

  // Fill area
  ctx.beginPath();
  ctx.moveTo(toX(0), zeroY);
  for (const p of points) {
    ctx.lineTo(toX(p.x), toY(p.y));
  }
  ctx.lineTo(toX(maxX), zeroY);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(toX(points[0].x), toY(points[0].y));
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(toX(points[i].x), toY(points[i].y));
  }
  ctx.strokeStyle = lastY >= 0 ? '#00d4aa' : '#ff4757';
  ctx.lineWidth = 2;
  ctx.stroke();

  // End point dot
  const lastPt = points[points.length - 1];
  ctx.beginPath();
  ctx.arc(toX(lastPt.x), toY(lastPt.y), 4, 0, Math.PI * 2);
  ctx.fillStyle = lastY >= 0 ? '#00d4aa' : '#ff4757';
  ctx.fill();
  ctx.strokeStyle = '#0a0a0f';
  ctx.lineWidth = 2;
  ctx.stroke();

  // End value label
  ctx.fillStyle = lastY >= 0 ? '#00d4aa' : '#ff4757';
  ctx.font = 'bold 12px JetBrains Mono';
  ctx.textAlign = 'left';
  ctx.fillText(`${lastY >= 0 ? '+' : ''}${lastY.toFixed(1)}%`, toX(lastPt.x) + 8, toY(lastPt.y) + 4);

  // X-axis label
  ctx.fillStyle = '#5a5b6e';
  ctx.font = '10px JetBrains Mono';
  ctx.textAlign = 'center';
  ctx.fillText('Trades →', w / 2, h - 4);
}

// ============================================================
// RENDERING — TABLES
// ============================================================

function renderRunningTrades(trades) {
  const tbody = document.getElementById('running-tbody');
  if (!tbody) return;

  if (trades.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" class="empty-state">
      <div class="empty-icon">📭</div>
      <div class="empty-title">Tidak ada trade aktif</div>
      <div class="empty-text">Gunakan Screener untuk mencari peluang</div>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = trades.map((t, i) => {
    const pnlValue = parsePnl(t.floatingPnl);
    const pnlClass = pnlValue >= 0 ? 'positive' : 'negative';
    const nearSL = t.currentPrice > 0 && t.cl > 0 &&
      ((t.currentPrice - t.cl) / t.currentPrice * 100) < 2;

    return `<tr ${nearSL ? 'style="background:rgba(255,71,87,0.05)"' : ''}>
      <td>${t.no || i+1}</td>
      <td class="ticker">${t.ticker}</td>
      <td>${formatDate(t.recomDate)}</td>
      <td>${formatPrice(t.buyPrice)}</td>
      <td class="positive">${formatPrice(t.tp1)}</td>
      <td class="positive">${formatPrice(t.tp2)}</td>
      <td class="negative">${formatPrice(t.cl)}</td>
      <td>${formatPrice(t.currentPrice)}</td>
      <td class="${pnlClass}">${t.floatingPnl || '0%'}</td>
      <td><span class="badge badge-running">● Running</span></td>
      <td>${t.potentialTP1 || ''}</td>
      <td>${nearSL ? '⚠️ Near SL' : ''}</td>
    </tr>`;
  }).join('');

  // Update count
  const countEl = document.querySelector('#panel-running .count');
  if (countEl) countEl.textContent = trades.length;
}

function renderDoneTrades(trades, stats) {
  const tbody = document.getElementById('done-tbody');
  if (!tbody) return;

  if (trades.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" class="empty-state">
      <div class="empty-icon">📋</div>
      <div class="empty-title">Belum ada trade selesai</div>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = trades.map((t, i) => {
    const badgeClass = getBadgeClass(t.status);
    const pnl = t.buyPrice > 0
      ? ((t.currentPrice - t.buyPrice) / t.buyPrice * 100).toFixed(2)
      : 0;
    const pnlClass = pnl >= 0 ? 'positive' : 'negative';

    return `<tr>
      <td>${t.no || i+1}</td>
      <td class="ticker">${t.ticker}</td>
      <td>${formatDate(t.recomDate)}</td>
      <td>${formatPrice(t.buyPrice)}</td>
      <td class="positive">${formatPrice(t.tp1)}</td>
      <td class="positive">${formatPrice(t.tp2)}</td>
      <td class="negative">${formatPrice(t.cl)}</td>
      <td>${formatPrice(t.currentPrice)}</td>
      <td class="${pnlClass}">${pnl >= 0 ? '+' : ''}${pnl}%</td>
      <td><span class="badge ${badgeClass}">${t.status}</span></td>
    </tr>`;
  }).join('');

  // Update stats
  const countEl = document.querySelector('#panel-done .count');
  if (countEl) countEl.textContent = trades.length;

  // Summary
  if (stats) {
    const summaryEl = document.getElementById('done-summary');
    if (summaryEl) {
      summaryEl.innerHTML = `
        <span class="badge badge-tp1">TP: ${stats.hitTP || 0}</span>
        <span class="badge badge-sl">SL: ${stats.hitSL || 0}</span>
        <span class="badge badge-invalid">Invalid: ${stats.invalid || 0}</span>
      `;
    }
  }
}

function renderScreenerResults(results) {
  const tbody = document.getElementById('screener-tbody');
  const countEl = document.getElementById('screener-count');
  if (!tbody) return;

  if (countEl) countEl.textContent = results.length;

  if (results.length === 0) {
    tbody.innerHTML = `<tr><td colspan="13" class="empty-state">
      <div class="empty-icon">🔍</div>
      <div class="empty-title">Klik "Scan" untuk mulai screening</div>
      <div class="empty-text">Pilih preset dan threshold, lalu scan</div>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = results.map(r => {
    const compBadge = r.compressionLevel === 'strong' ? 'badge-strong' : 'badge-compressed';
    const breakBadge = r.breakoutSignal === 'confirmed' ? 'badge-confirmed' :
                       r.breakoutSignal === 'potential' ? 'badge-potential' : '';
    const volClass = r.volumeRatio >= 1.5 ? 'positive' : 'neutral';
    const hasFib = r.fibonacci && r.fibonacci.tp1;

    return `<tr>
      <td class="ticker">${r.ticker}</td>
      <td>${formatPrice(r.close)}</td>
      <td>${formatPrice(r.ma5)}</td>
      <td>${formatPrice(r.ma10)}</td>
      <td>${formatPrice(r.ma20)}</td>
      <td><span class="badge ${compBadge}">${r.compressionRatio}%</span></td>
      <td class="${volClass}">${r.volumeRatio}x</td>
      <td>${breakBadge ? `<span class="badge ${breakBadge}">${r.breakoutDirection} ${r.breakoutSignal}</span>` : '—'}</td>
      <td class="neutral">${r.rsi !== null ? r.rsi : '—'}</td>
      <td class="neutral">${r.macdHistogram !== null ? r.macdHistogram : '—'}</td>
      <td class="positive">${hasFib ? formatPrice(r.fibonacci.tp1) + ' / ' + formatPrice(r.fibonacci.tp2) : '—'}</td>
      <td class="negative">${hasFib ? formatPrice(r.fibonacci.sl) : '—'}</td>
      <td>${hasFib && r.breakoutSignal !== 'none' ?
        `<button class="btn btn-primary btn-sm" onclick='showTakeTradeModal(${JSON.stringify(r).replace(/'/g, "&#39;")})'>📈 Take</button>` :
        '<span class="neutral">—</span>'}
      </td>
    </tr>`;
  }).join('');
}

// ============================================================
// SORTING
// ============================================================

function sortTable(tableId, column, type) {
  // Determine data source
  let data;
  let renderFn;

  if (tableId === 'screener') {
    data = App.screenerResults;
    renderFn = renderScreenerResults;
  } else if (tableId === 'running') {
    data = App.runningTrades;
    renderFn = renderRunningTrades;
  } else if (tableId === 'done') {
    data = App.doneTrades;
    renderFn = (d) => renderDoneTrades(d);
  } else return;

  // Toggle direction
  if (App.sortColumn === `${tableId}-${column}`) {
    App.sortDirection = App.sortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    App.sortColumn = `${tableId}-${column}`;
    App.sortDirection = 'asc';
  }

  data.sort((a, b) => {
    let va = a[column], vb = b[column];
    if (type === 'number') {
      va = parseFloat(va) || 0;
      vb = parseFloat(vb) || 0;
    } else {
      va = (va || '').toString();
      vb = (vb || '').toString();
    }
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return App.sortDirection === 'asc' ? cmp : -cmp;
  });

  renderFn(data);
}

// ============================================================
// EXPORT CSV
// ============================================================

function exportCSV(tableId) {
  let data, headers, filename;

  if (tableId === 'running') {
    headers = ['No', 'Ticker', 'Date', 'Buy Price', 'TP1', 'TP2', 'CL', 'Current', 'PNL', 'Status'];
    data = App.runningTrades.map(t => [
      t.no, t.ticker, formatDate(t.recomDate), t.buyPrice,
      t.tp1, t.tp2, t.cl, t.currentPrice, t.floatingPnl, t.status
    ]);
    filename = 'running_trades.csv';
  } else if (tableId === 'done') {
    headers = ['No', 'Ticker', 'Date', 'Buy Price', 'TP1', 'TP2', 'CL', 'Exit Price', 'PNL', 'Status'];
    data = App.doneTrades.map(t => [
      t.no, t.ticker, formatDate(t.recomDate), t.buyPrice,
      t.tp1, t.tp2, t.cl, t.currentPrice,
      (t.buyPrice > 0 ? ((t.currentPrice - t.buyPrice) / t.buyPrice * 100).toFixed(2) + '%' : ''),
      t.status
    ]);
    filename = 'done_trades.csv';
  } else if (tableId === 'screener') {
    headers = ['Ticker', 'Close', 'MA5', 'MA10', 'MA20', 'Compression%', 'Vol Ratio', 'Breakout', 'RSI', 'MACD'];
    data = App.screenerResults.map(r => [
      r.ticker, r.close, r.ma5, r.ma10, r.ma20,
      r.compressionRatio, r.volumeRatio,
      r.breakoutSignal !== 'none' ? r.breakoutDirection + ' ' + r.breakoutSignal : '',
      r.rsi, r.macdHistogram
    ]);
    filename = 'screener_results.csv';
  } else return;

  const csv = [headers.join(','), ...data.map(row => row.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);

  showToast(`Exported ${filename}`, 'success');
}

// ============================================================
// FILTER DONE TRADES
// ============================================================

function filterDoneTrades(status) {
  const filtered = status === 'all'
    ? App.doneTrades
    : App.doneTrades.filter(t => {
        if (status === 'tp') return t.status.includes('TP');
        if (status === 'sl') return t.status.includes('SL');
        if (status === 'invalid') return t.status === 'invalid';
        return true;
      });
  renderDoneTrades(filtered);
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function formatPrice(val) {
  if (!val && val !== 0) return '—';
  const num = typeof val === 'number' ? val : parseFloat(val);
  if (isNaN(num)) return val;
  return num.toLocaleString('id-ID');
}

function formatDate(val) {
  if (!val) return '—';
  if (val instanceof Date) {
    return val.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  // Handle Google Sheets date serial or string
  if (typeof val === 'string') return val;
  if (typeof val === 'number' && val > 25000) {
    // Excel/Sheets date serial
    const date = new Date((val - 25569) * 86400 * 1000);
    return date.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  return val.toString();
}

function parsePnl(val) {
  if (!val) return 0;
  const str = val.toString().replace('%', '').replace(',', '.').trim();
  return parseFloat(str) || 0;
}

function getBadgeClass(status) {
  if (!status) return 'badge-invalid';
  const s = status.toLowerCase();
  if (s.includes('tp 2') || s.includes('tp2')) return 'badge-tp2';
  if (s.includes('tp 1') || s.includes('tp1') || s.includes('gap up')) return 'badge-tp1';
  if (s.includes('sl')) return 'badge-sl';
  if (s === 'running') return 'badge-running';
  if (s === 'invalid') return 'badge-invalid';
  return 'badge-invalid';
}

function updateTabBadge(tab, count) {
  const badge = document.querySelector(`.nav-tab[data-tab="${tab}"] .tab-badge`);
  if (badge) badge.textContent = count;
}

function setConnectionStatus(online) {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  if (dot) dot.className = 'status-dot' + (online ? '' : ' offline');
  if (text) text.textContent = online ? 'Connected' : 'Offline';
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  toast.innerHTML = `<span>${icons[type] || ''}</span> ${message}`;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'toast-out 300ms ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ============================================================
// LOCAL STORAGE CACHE
// ============================================================

function cacheData(key, data) {
  try {
    localStorage.setItem(`sc_cache_${key}`, JSON.stringify({
      data,
      timestamp: Date.now()
    }));
  } catch (e) { /* ignore quota errors */ }
}

function getCachedData(key) {
  try {
    const raw = localStorage.getItem(`sc_cache_${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Cache valid for 30 minutes
    if (Date.now() - parsed.timestamp > 30 * 60 * 1000) return null;
    return parsed.data;
  } catch (e) { return null; }
}

function loadCachedData() {
  const dashboard = getCachedData('dashboard');
  if (dashboard) {
    App.dashboardData = dashboard;
    renderDashboard(dashboard);
  }

  const running = getCachedData('running');
  if (running) {
    App.runningTrades = running.trades || [];
    renderRunningTrades(App.runningTrades);
    updateTabBadge('running', App.runningTrades.length);
  }

  const done = getCachedData('done');
  if (done) {
    App.doneTrades = done.trades || [];
    renderDoneTrades(App.doneTrades, done);
    updateTabBadge('done', App.doneTrades.length);
  }
}
