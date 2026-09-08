// ============================================================
// SahamCompress — Google Apps Script Backend
// Deploy sebagai Web App: Publish → Deploy as Web App
// URL akan dipakai oleh frontend sebagai API endpoint
// ============================================================

const SPREADSHEET_ID = '1fp5r3tFS1He7FJuZUqgK-eGppcyeuFX9vY3U5TbkFlQ';
const SHEET_RUNNING = 'Running';
const SHEET_DONE = 'DONE TP SL';
const SHEET_TICKERS = 'Ticker List';
const SHEET_SCREENER = 'Screener Results';

// ============================================================
// WEB APP ENTRY POINTS
// ============================================================

function doGet(e) {
  return processRequest(e.parameter.action || 'ping', e.parameter);
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: 'Invalid JSON body' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return processRequest(body.action || '', body);
}

function processRequest(action, params) {
  let result;
  try {
    switch (action) {
      case 'ping':
        result = { status: 'ok', message: 'SahamCompress API is running' };
        break;
      case 'scan':
        const tickers = params.tickers ? params.tickers.split(',') : null;
        const threshold = parseFloat(params.threshold) || 5;
        result = scanStocks(tickers, threshold);
        break;
      case 'getPrice':
        result = getStockData(params.ticker, parseInt(params.days) || 60);
        break;
      case 'getRunning':
        result = getRunningTrades();
        break;
      case 'getDone':
        result = getDoneTrades();
        break;
      case 'checkTrades':
        result = checkAndUpdateTrades();
        break;
      case 'getDashboard':
        result = getDashboardStats();
        break;
      case 'setupAutoPilot':
        result = setupAutoPilot();
        break;
      case 'getCorpActions':
        result = getCorpActions();
        break;
      case 'scrapeCorpActions':
        result = scrapeCorpActions();
        break;
      case 'scrapeTickers':
        const fallbackList = params.fallbackTickers ? params.fallbackTickers.split(',') : null;
        result = scrapeIDXTickers(fallbackList);
        break;
      case 'getTickerList':
        result = getTickerListFromSheet();
        break;
      case 'scanAuto':
        const autoThreshold = parseFloat(params.threshold) || 5;
        result = scanFromSheet(autoThreshold);
        break;
      case 'scan':
        const scanTickers = params.tickers ? params.tickers.split(',') : [];
        const scanThreshold = parseFloat(params.threshold) || 5;
        result = scanStocks(scanTickers, scanThreshold);
        break;
      case 'addTrade':
        result = addTrade(params);
        break;
      case 'updateStatus':
        result = updateTradeStatus(params.ticker, params.status);
        break;
      case 'saveScreenerResults':
        const jsonResults = params.results ? JSON.parse(params.results) : [];
        result = saveScreenerResults(jsonResults);
        break;
      default:
        result = { error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { error: err.message, stack: err.stack };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// YAHOO FINANCE DATA FETCHING
// ============================================================

/**
 * Fetch historical OHLCV data from Yahoo Finance
 * @param {string} ticker - e.g. "BBCA" (auto-appends .JK)
 * @param {number} days - lookback period
 * @returns {Object} { ticker, data: [{date, open, high, low, close, volume}], current }
 */
function getStockData(ticker, days) {
  if (!ticker) return { error: 'Ticker is required' };

  const symbol = ticker.includes('.JK') ? ticker : ticker + '.JK';
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - (days * 86400);

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=1d`;

  try {
    const response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const json = JSON.parse(response.getContentText());

    if (json.chart.error) {
      return { error: json.chart.error.description, ticker: ticker };
    }

    const result = json.chart.result[0];
    const timestamps = result.timestamp || [];
    const quotes = result.indicators.quote[0];
    const adjClose = result.indicators.adjclose ? result.indicators.adjclose[0].adjclose : quotes.close;

    const data = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (quotes.close[i] !== null && quotes.close[i] !== undefined) {
        data.push({
          date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
          open: quotes.open[i],
          high: quotes.high[i],
          low: quotes.low[i],
          close: quotes.close[i],
          volume: quotes.volume[i]
        });
      }
    }

    return {
      ticker: ticker,
      symbol: symbol,
      current: data.length > 0 ? data[data.length - 1].close : null,
      data: data
    };
  } catch (err) {
    return { error: err.message, ticker: ticker };
  }
}

// ============================================================
// TECHNICAL INDICATORS
// ============================================================

/**
 * Calculate Simple Moving Average
 */
function calcSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(closes.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Calculate RSI (Relative Strength Index)
 */
function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;

  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Calculate MACD
 */
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  if (ema12 === null || ema26 === null) return { macd: null, signal: null, histogram: null };

  const macdLine = ema12 - ema26;

  // Simplified signal (would need full EMA series for accurate signal line)
  return {
    macd: macdLine,
    signal: null,
    histogram: macdLine // simplified
  };
}

/**
 * Calculate Average Volume
 */
function calcAvgVolume(volumes, period) {
  if (volumes.length < period) return null;
  const slice = volumes.slice(volumes.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Find Swing High and Swing Low (for Fibonacci calculation)
 */
function findSwingPoints(data, lookback) {
  if (data.length < lookback) return { swingHigh: null, swingLow: null };

  const recent = data.slice(data.length - lookback);
  let swingHigh = -Infinity, swingLow = Infinity;
  let swingHighIdx = 0, swingLowIdx = 0;

  for (let i = 0; i < recent.length; i++) {
    if (recent[i].high > swingHigh) {
      swingHigh = recent[i].high;
      swingHighIdx = i;
    }
    if (recent[i].low < swingLow) {
      swingLow = recent[i].low;
      swingLowIdx = i;
    }
  }

  return { swingHigh, swingLow, swingHighIdx, swingLowIdx };
}

/**
 * Calculate Fibonacci TP1, TP2, SL
 */
function calcFibonacci(swingHigh, swingLow, direction) {
  const range = swingHigh - swingLow;

  if (direction === 'bullish') {
    return {
      tp1: Math.round(swingHigh + range * 0.618),   // Fib Extension 1.618
      tp2: Math.round(swingHigh + range * 1.618),   // Fib Extension 2.618
      sl: Math.round(swingHigh - range * 0.214),    // Fib Retracement 0.786
      slFloor: Math.round(swingLow)                 // Safety floor
    };
  } else {
    return {
      tp1: Math.round(swingLow - range * 0.618),
      tp2: Math.round(swingLow - range * 1.618),
      sl: Math.round(swingLow + range * 0.214),
      slFloor: Math.round(swingHigh)
    };
  }
}

/**
 * Calculate Standard Deviation
 */
function calcStdDev(closes, period, sma) {
  if (closes.length < period) return null;
  const slice = closes.slice(closes.length - period);
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / period;
  return Math.sqrt(variance);
}

/**
 * Calculate Bollinger Bands
 */
function calcBollingerBands(closes, period, multiplier) {
  const sma = calcSMA(closes, period);
  if (sma === null) return null;
  const stdDev = calcStdDev(closes, period, sma);
  if (stdDev === null) return null;
  
  const upper = sma + (multiplier * stdDev);
  const lower = sma - (multiplier * stdDev);
  const bandWidth = (upper - lower) / sma;
  
  return { middle: sma, upper, lower, bandWidth };
}

/**
 * Calculate Average True Range (ATR)
 */
function calcATR(data, period) {
  if (data.length < period + 1) return null;
  
  let trueRanges = [];
  // Calculate TR for the last `period` days
  for (let i = data.length - period; i < data.length; i++) {
    const high = data[i].high;
    const low = data[i].low;
    const prevClose = data[i - 1].close;
    
    const tr1 = high - low;
    const tr2 = Math.abs(high - prevClose);
    const tr3 = Math.abs(low - prevClose);
    
    trueRanges.push(Math.max(tr1, tr2, tr3));
  }
  
  // Simple Moving Average of TR (SMA is sufficient for our SL logic)
  return trueRanges.reduce((a, b) => a + b, 0) / period;
}

// ============================================================
// COMPRESSION & BREAKOUT DETECTION
// ============================================================

/**
 * Analyze a single stock for compression and breakout
 */
function analyzeStock(ticker) {
  const stockData = getStockData(ticker, 60);
  if (stockData.error || !stockData.data || stockData.data.length < 20) {
    return { ticker, error: stockData.error || 'Insufficient data', skip: true };
  }

  const data = stockData.data;
  const closes = data.map(d => d.close);
  const volumes = data.map(d => d.volume);
  const lastCandle = data[data.length - 1];

  // Calculate MAs
  const ma5 = calcSMA(closes, 5);
  const ma10 = calcSMA(closes, 10);
  const ma20 = calcSMA(closes, 20);

  if (ma5 === null || ma10 === null || ma20 === null) {
    return { ticker, error: 'Not enough data for MA calculation', skip: true };
  }

  // SUSPEND / ILLIQUID FILTER
  // 1. Check if price hasn't moved at all in the last 20 days
  const recentCloses = closes.slice(-20);
  const maxClose = Math.max(...recentCloses);
  const minClose = Math.min(...recentCloses);
  if (maxClose === minClose) {
    return { ticker, error: 'Suspended or no price movement in 20 days', skip: true };
  }

  // 2. Check if average volume is basically 0 or too illiquid
  const avgVolume20 = calcAvgVolume(volumes.slice(0, -1), 20); // exclude today
  if (avgVolume20 === null || avgVolume20 === 0) {
    return { ticker, error: 'No trading volume in last 20 days', skip: true };
  }
  
  // Perkiraan rata-rata nilai transaksi harian (Rupiah)
  // Yahoo Finance mencatat volume dalam satuan lembar saham (bukan lot)
  const avgValue20 = avgVolume20 * lastCandle.close;
  if (avgValue20 < 200000000) { // Rp 200.000.000
    return { ticker, error: 'Low liquidity (< Rp 200 Juta/hari)', skip: true };
  }

  // 3. SIDEWAYS / CONSOLIDATION FILTER
  // Pastikan pergerakan harga 20 hari terakhir benar-benar sideways (tidak volatile)
  // Range antara harga tertinggi dan terendah selama 20 hari maksimal 30%
  const recentData = data.slice(-20);
  const maxHigh20 = Math.max(...recentData.map(d => d.high));
  const minLow20 = Math.min(...recentData.map(d => d.low));
  const priceRangePct = ((maxHigh20 - minLow20) / lastCandle.close) * 100;
  
  if (priceRangePct > 30) {
    return { ticker, error: 'Too volatile (>30% range), not sideways', skip: true };
  }

  // 4. BOLLINGER BANDS SQUEEZE FILTER
  const bb = calcBollingerBands(closes, 20, 2);
  if (!bb || bb.bandWidth > 0.20) { // Bandwidth > 20% means not a squeeze
    return { ticker, error: 'Bollinger Bands not squeezing (>20%)', skip: true };
  }

  // Compression ratio
  const maMax = Math.max(ma5, ma10, ma20);
  const maMin = Math.min(ma5, ma10, ma20);
  const compressionRatio = ((maMax - maMin) / lastCandle.close) * 100;

  // Compression level
  let compressionLevel = 'normal';
  if (compressionRatio < 2) compressionLevel = 'strong';
  else if (compressionRatio <= 5) compressionLevel = 'compressed';

  // Volume analysis
  const currentVolume = lastCandle.volume;
  const volumeRatio = avgVolume20 > 0 ? currentVolume / avgVolume20 : 0;

  // Breakout detection
  let breakoutSignal = 'none';
  let breakoutDirection = 'none';

  if (compressionLevel !== 'normal') {
    const closeAboveAllMA = lastCandle.close > ma5 && lastCandle.close > ma10 && lastCandle.close > ma20;
    const closeBelowAllMA = lastCandle.close < ma5 && lastCandle.close < ma10 && lastCandle.close < ma20;
    const volumeSpike = volumeRatio >= 1.5;

    // MA Alignment
    const bullishAlignment = ma5 > ma10 && ma10 > ma20;
    const bearishAlignment = ma5 < ma10 && ma10 < ma20;

    if (closeAboveAllMA && volumeSpike && bullishAlignment) {
      breakoutSignal = 'confirmed';
      breakoutDirection = 'bullish';
    } else if (closeBelowAllMA && volumeSpike && bearishAlignment) {
      breakoutSignal = 'confirmed';
      breakoutDirection = 'bearish';
    } else if (closeAboveAllMA && (volumeSpike || bullishAlignment)) {
      breakoutSignal = 'potential';
      breakoutDirection = 'bullish';
    } else if (closeBelowAllMA && (volumeSpike || bearishAlignment)) {
      breakoutSignal = 'potential';
      breakoutDirection = 'bearish';
    }
  }

  // RSI & MACD (informational only)
  const rsi = calcRSI(closes, 14);
  const macd = calcMACD(closes);

  // ATR & Trading Targets (if breakout detected)
  const atr = calcATR(data, 14);
  let targets = null;
  if (breakoutSignal !== 'none' && breakoutDirection === 'bullish' && atr !== null) {
    targets = {
      tp1: Math.round(lastCandle.close + (2 * atr)),
      tp2: Math.round(lastCandle.close + (3 * atr)),
      sl: Math.round(lastCandle.close - (1.5 * atr)),
    };
    targets.tp1Pct = ((targets.tp1 - lastCandle.close) / lastCandle.close * 100).toFixed(2);
    targets.tp2Pct = ((targets.tp2 - lastCandle.close) / lastCandle.close * 100).toFixed(2);
    targets.slPct = ((targets.sl - lastCandle.close) / lastCandle.close * 100).toFixed(2);
  }

  return {
    ticker,
    close: lastCandle.close,
    date: lastCandle.date,
    ma5: Math.round(ma5 * 100) / 100,
    ma10: Math.round(ma10 * 100) / 100,
    ma20: Math.round(ma20 * 100) / 100,
    compressionRatio: Math.round(compressionRatio * 100) / 100,
    compressionLevel,
    volume: currentVolume,
    avgVolume20: Math.round(avgVolume20),
    volumeRatio: Math.round(volumeRatio * 100) / 100,
    breakoutSignal,
    breakoutDirection,
    rsi: rsi ? Math.round(rsi * 100) / 100 : null,
    macdHistogram: macd.histogram ? Math.round(macd.histogram * 100) / 100 : null,
    bbBandwidth: Math.round(bb.bandWidth * 10000) / 100, // as percentage
    atr: atr ? Math.round(atr * 100) / 100 : null,
    targets,
    skip: false
  };
}

/**
 * Scan multiple stocks for compression
 */
function scanStocks(tickers, threshold) {
  if (!tickers || tickers.length === 0) {
    return { error: 'No tickers provided' };
  }

  const results = [];
  const errors = [];

  // Load Corp Actions for warnings
  const corpActionsData = getCorpActions().actions;
  const corpActionsMap = {};
  corpActionsData.forEach(a => {
    if (!corpActionsMap[a.ticker]) corpActionsMap[a.ticker] = [];
    corpActionsMap[a.ticker].push(a);
  });

  const now = new Date();

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i].trim().toUpperCase();
    if (!ticker) continue;

    try {
      const analysis = analyzeStock(ticker);
      if (analysis.skip) {
        errors.push({ ticker, error: analysis.error });
      } else if (analysis.compressionRatio <= threshold) {
        // Check for Corp Actions
        if (corpActionsMap[ticker]) {
          const upcoming = corpActionsMap[ticker].filter(a => new Date(a.exDate) > now);
          if (upcoming.length > 0) {
            analysis.corpActionWarning = `⚠️ Dividend Ex-Date: ${upcoming[0].exDate}`;
          }
        }
        results.push(analysis);
      }

      // Rate limiting: small delay every 5 requests
      if (i > 0 && i % 5 === 0) {
        Utilities.sleep(500);
      }
    } catch (err) {
      errors.push({ ticker, error: err.message });
    }
  }

  // Sort by compression ratio (tightest first)
  results.sort((a, b) => a.compressionRatio - b.compressionRatio);

  return {
    total: tickers.length,
    found: results.length,
    errorCount: errors.length,
    results,
    errors: errors.slice(0, 20) // limit error list
  };
}

// ============================================================
// GOOGLE SHEETS INTEGRATION
// ============================================================

/**
 * Read running trades from spreadsheet
 */
function getRunningTrades() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_RUNNING);
  const data = sheet.getDataRange().getValues();

  // Skip header rows (row 1 & 2)
  const trades = [];
  for (let i = 2; i < data.length; i++) {
    const row = data[i];
    if (!row[1] || row[1].toString().trim() === '') continue; // skip empty rows

    trades.push({
      no: row[0],
      ticker: row[1].toString().trim(),
      recomDate: row[2],
      buyPrice: parseNumber(row[3]),
      tp1: parseNumber(row[5]),
      tp2: parseNumber(row[6]),
      cl: parseNumber(row[7]),
      potentialTP1: row[8],
      potentialTP2: row[9],
      potentialCL: row[10],
      status: row[11],
      currentPrice: parseNumber(row[12]),
      floatingPnl: row[13],
      rowIndex: i + 1 // 1-indexed for Sheets
    });
  }

  return { trades, count: trades.length };
}

/**
 * Read done trades from spreadsheet
 */
function getDoneTrades() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_DONE);
  const data = sheet.getDataRange().getValues();

  const trades = [];
  for (let i = 2; i < data.length; i++) {
    const row = data[i];
    if (!row[1] || row[1].toString().trim() === '') continue;

    trades.push({
      no: row[0],
      ticker: row[1].toString().trim(),
      recomDate: row[2],
      buyPrice: parseNumber(row[3]),
      tp1: parseNumber(row[5]),
      tp2: parseNumber(row[6]),
      cl: parseNumber(row[7]),
      potentialTP1: row[8],
      potentialTP2: row[9],
      potentialCL: row[10],
      status: row[11].toString().trim(),
      currentPrice: parseNumber(row[12]),
      exitStatus: row[13] ? row[13].toString().trim() : row[11].toString().trim()
    });
  }

  // Count stats
  const hitTP = trades.filter(t => t.status.includes('TP')).length;
  const hitSL = trades.filter(t => t.status.includes('SL')).length;
  const invalid = trades.filter(t => t.status === 'invalid').length;

  return { trades, count: trades.length, hitTP, hitSL, invalid };
}

/**
 * Add new trade to Running sheet
 */
function addTrade(params) {
  // Support both flat params (from GET) and nested trade object (from POST)
  const trade = params.trade || params;
  if (!trade || !trade.ticker) return { error: 'Trade data with ticker is required' };
  
  // Parse numbers (GET params come as strings)
  trade.buyPrice = parseNumber(trade.buyPrice);
  trade.tp1 = parseNumber(trade.tp1);
  trade.tp2 = parseNumber(trade.tp2);
  trade.cl = parseNumber(trade.cl);

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_RUNNING);
  const data = sheet.getDataRange().getValues();

  // Check for duplicate ticker in Running sheet
  for (let i = 2; i < data.length; i++) {
    const existingTicker = data[i][1] ? data[i][1].toString().trim().toUpperCase() : '';
    if (existingTicker === trade.ticker.trim().toUpperCase()) {
      return { error: `${trade.ticker} sudah ada di Running trades. Tidak boleh duplikat.`, duplicate: true };
    }
  }

  // Find next row number
  const nextNo = data.length - 1; // subtract header rows
  const today = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'dd/MM/yyyy');

  const tp1Pct = ((trade.tp1 - trade.buyPrice) / trade.buyPrice * 100).toFixed(2) + '%';
  const tp2Pct = ((trade.tp2 - trade.buyPrice) / trade.buyPrice * 100).toFixed(2) + '%';
  const clPct = ((trade.cl - trade.buyPrice) / trade.buyPrice * 100).toFixed(2) + '%';

  const newRow = [
    nextNo,           // NO
    trade.ticker,     // TICKER
    today,            // RECOM DATE
    trade.buyPrice,   // BUY PRICE
    '',               // empty column
    trade.tp1,        // TP 1
    trade.tp2,        // TP 2
    trade.cl,         // CL
    tp1Pct,           // POTENTIAL TP1
    tp2Pct,           // POTENTIAL TP2
    clPct,            // POTENTIAL CL
    'Running',        // STATUS
    trade.buyPrice,   // CURRENT PRICE (initially = buy price)
    '0,00%'           // FLOATING PNL
  ];

  sheet.appendRow(newRow);

  return { success: true, trade: { no: nextNo, ...trade } };
}

/**
 * Check all running trades and auto-update status
 */
function checkAndUpdateTrades() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const runningSheet = ss.getSheetByName(SHEET_RUNNING);
  const doneSheet = ss.getSheetByName(SHEET_DONE);
  const data = runningSheet.getDataRange().getValues();

  const updated = [];
  const rowsToDelete = []; // rows to move to Done

  for (let i = 2; i < data.length; i++) {
    const row = data[i];
    const ticker = row[1] ? row[1].toString().trim() : '';
    if (!ticker) continue;

    // Fetch current price
    const stockData = getStockData(ticker, 5);
    if (stockData.error || !stockData.current) continue;

    const currentPrice = stockData.current;
    const buyPrice = parseNumber(row[3]);
    const tp1 = parseNumber(row[5]);
    const tp2 = parseNumber(row[6]);
    const cl = parseNumber(row[7]);

    // Determine new status
    let newStatus = 'Running';
    if (currentPrice >= tp2) {
      newStatus = 'HIT TP 2';
    } else if (currentPrice >= tp1) {
      newStatus = 'HIT TP 1';
    } else if (currentPrice <= cl) {
      newStatus = 'HIT SL';
    }

    // Update current price & floating PNL
    const floatingPnl = ((currentPrice - buyPrice) / buyPrice * 100).toFixed(2) + '%';
    const sheetRow = i + 1;

    runningSheet.getRange(sheetRow, 13).setValue(currentPrice); // Column M = Current Price
    runningSheet.getRange(sheetRow, 14).setValue(floatingPnl);  // Column N = Floating PNL

    if (newStatus !== 'Running') {
      // Update status in Running sheet
      runningSheet.getRange(sheetRow, 12).setValue(newStatus); // Column L = Status

      // Prepare row for Done sheet
      const doneRow = [...row];
      doneRow[11] = newStatus;
      doneRow[12] = currentPrice;

      // Append to Done sheet
      doneSheet.appendRow(doneRow.slice(0, 14));

      rowsToDelete.push(sheetRow);
      updated.push({ ticker, newStatus, currentPrice, buyPrice });
    } else {
      updated.push({ ticker, newStatus: 'Running', currentPrice, buyPrice, floatingPnl });
    }

    // Rate limiting
    Utilities.sleep(300);
  }

  // Delete moved rows from Running (bottom to top to avoid index shifting)
  rowsToDelete.sort((a, b) => b - a);
  for (const rowIdx of rowsToDelete) {
    runningSheet.deleteRow(rowIdx);
  }

  return { updated, movedToDone: rowsToDelete.length };
}

/**
 * Get dashboard statistics
 */
function getDashboardStats() {
  const running = getRunningTrades();
  const done = getDoneTrades();

  // Calculate win rate
  const totalClosed = done.hitTP + done.hitSL;
  const winRate = totalClosed > 0 ? ((done.hitTP / totalClosed) * 100).toFixed(1) : 0;

  // Calculate total realized P/L
  let totalProfitPct = 0;
  let bestTrade = null, worstTrade = null;
  let bestPnl = -Infinity, worstPnl = Infinity;
  let totalHoldingDays = 0;
  let countWithDates = 0;

  // Separate TP1 and TP2 counts
  const tp1Count = done.trades.filter(t => t.status === 'HIT TP 1' || t.status === 'GAP UP TP 1').length;
  const tp2Count = done.trades.filter(t => t.status.includes('TP 2') || t.status.includes('GAP UP TP 2')).length;

  for (const trade of done.trades) {
    if (trade.status === 'invalid') continue;

    const pnl = trade.buyPrice > 0 ? ((trade.currentPrice - trade.buyPrice) / trade.buyPrice * 100) : 0;
    totalProfitPct += pnl;

    if (pnl > bestPnl) {
      bestPnl = pnl;
      bestTrade = { ticker: trade.ticker, pnl: pnl.toFixed(2) + '%' };
    }
    if (pnl < worstPnl) {
      worstPnl = pnl;
      worstTrade = { ticker: trade.ticker, pnl: pnl.toFixed(2) + '%' };
    }
  }

  // Running trades: floating P/L summary
  let totalFloating = 0;
  let floatingPositive = 0, floatingNegative = 0;
  for (const trade of running.trades) {
    if (trade.buyPrice > 0 && trade.currentPrice > 0) {
      const pnl = ((trade.currentPrice - trade.buyPrice) / trade.buyPrice * 100);
      totalFloating += pnl;
      if (pnl >= 0) floatingPositive++;
      else floatingNegative++;
    }
  }

  return {
    running: {
      count: running.count,
      totalFloatingPct: totalFloating.toFixed(2),
      positive: floatingPositive,
      negative: floatingNegative
    },
    done: {
      count: done.count,
      hitTP: done.hitTP,
      hitTP1: tp1Count,
      hitTP2: tp2Count,
      hitSL: done.hitSL,
      invalid: done.invalid,
      winRate: parseFloat(winRate),
      totalRealizedPct: totalProfitPct.toFixed(2),
      bestTrade,
      worstTrade
    }
  };
}

// ============================================================
// UTILITY
// ============================================================

function parseNumber(val) {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  // Handle Indonesian number format (comma as decimal, dot as thousands)
  return parseFloat(val.toString().replace(/\./g, '').replace(',', '.')) || 0;
}

// ============================================================
// SCHEDULED TRIGGER (optional: auto-check every hour during market hours)
// ============================================================

/**
 * Endpoint called from frontend to enable all automation triggers
 */
function setupAutoPilot() {
  const triggers = ScriptApp.getProjectTriggers();
  
  // Delete all existing triggers to avoid duplicates
  for (const trigger of triggers) {
    ScriptApp.deleteTrigger(trigger);
  }

  // 1. Hourly check for TP/SL (runs every 1 hour)
  ScriptApp.newTrigger('autoCheckDuringMarket')
    .timeBased()
    .everyHours(1)
    .create();

  // 2. Daily Auto-Screener (runs every day at 16:30 approx)
  ScriptApp.newTrigger('autoScreenerDaily')
    .timeBased()
    .everyDays(1)
    .atHour(16) // Triggers between 16:00 and 17:00
    .create();

  // 3. Monthly Ticker Scrape (runs 1st of every month at midnight)
  ScriptApp.newTrigger('autoUpdateTickers')
    .timeBased()
    .onMonthDay(1)
    .atHour(0)
    .create();

  // 4. Daily Corporate Actions Scrape (runs every day at 01:00)
  ScriptApp.newTrigger('scrapeCorpActions')
    .timeBased()
    .everyDays(1)
    .atHour(1)
    .create();

  return { success: true, message: 'Auto-Pilot has been activated successfully!' };
}

function autoCheckDuringMarket() {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay();

  // Only run Mon-Fri, 9:00 - 16:00 WIB
  if (day === 0 || day === 6) return; // weekend
  if (hour < 9 || hour > 16) return;  // outside market hours

  checkAndUpdateTrades();
}

/**
 * Initializes the daily recursive scan of 900 stocks
 */
function autoScreenerDaily() {
  const now = new Date();
  const day = now.getDay();
  // Only run on weekdays
  if (day === 0 || day === 6) return;

  // Clear previous Screener results
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Screener Results');
  if (!sheet) return;
  
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
  }

  // Get all tickers from Ticker List
  const listSheet = ss.getSheetByName('Ticker List');
  if (!listSheet) return;
  
  const tickerData = listSheet.getRange(2, 1, listSheet.getLastRow() - 1, 1).getValues();
  const allTickers = tickerData.map(r => r[0]).filter(t => t);
  
  if (allTickers.length === 0) return;

  const props = PropertiesService.getScriptProperties();
  props.setProperty('SCAN_TICKERS', JSON.stringify(allTickers));
  props.setProperty('SCAN_INDEX', '0');

  // Trigger the first batch
  continueScan();
}

/**
 * Recursive handler to scan stocks in batches
 */
function continueScan() {
  const props = PropertiesService.getScriptProperties();
  const tickersStr = props.getProperty('SCAN_TICKERS');
  let currentIndex = parseInt(props.getProperty('SCAN_INDEX') || '0', 10);
  
  if (!tickersStr) return; // Nothing to scan
  
  const allTickers = JSON.parse(tickersStr);
  const BATCH_SIZE = 50;
  
  // Slice the current batch
  const batch = allTickers.slice(currentIndex, currentIndex + BATCH_SIZE);
  
  if (batch.length > 0) {
    // Process batch (fetch from API and save to sheet)
    const result = scanStocks(batch, 5); // Default threshold 5%
    
    // Write results immediately to the Screener sheet
    if (result.results && result.results.length > 0) {
      saveScreenerResults(result.results);
    }
    
    // Update index
    currentIndex += BATCH_SIZE;
    props.setProperty('SCAN_INDEX', currentIndex.toString());
  }

  // Clean up any previous "after" triggers that might have accumulated
  // Not strictly necessary as Google deletes them, but good practice
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'continueScan' && trigger.getEventType() === ScriptApp.EventType.CLOCK) {
      ScriptApp.deleteTrigger(trigger);
    }
  }

  // Check if we still have tickers left
  if (currentIndex < allTickers.length) {
    // Spawn a new trigger to run this function again 1 minute later
    ScriptApp.newTrigger('continueScan')
      .timeBased()
      .after(60 * 1000) // 1 minute
      .create();
  } else {
    // Finished scanning! Clean up properties
    props.deleteProperty('SCAN_TICKERS');
    props.deleteProperty('SCAN_INDEX');
  }
}

function autoUpdateTickers() {
  // Fallback to empty list so it fetches via API
  scrapeIDXTickers('');
}

// ============================================================
// IDX TICKER SCRAPING & TICKER LIST MANAGEMENT
// ============================================================

/**
 * Scrape all IDX stock tickers from IDX website API
 * Saves results to "Ticker List" sheet
 * @returns {Object} { count, tickers }
 */
function scrapeIDXTickers(fallbackList) {
  const tickers = [];

  // Method 1: IDX API (primary)
  try {
    // IDX provides a JSON endpoint for listed stocks
    const url = 'https://www.idx.co.id/primary/StockData/GetSecuritiesStock?start=0&length=2000&code=&sector=&board=&language=id-id';
    const response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.idx.co.id/id/data-pasar/data-saham/daftar-saham/'
      }
    });

    if (response.getResponseCode() === 200) {
      const json = JSON.parse(response.getContentText());
      const data = json.data || json.Data || json;

      if (Array.isArray(data)) {
        for (const item of data) {
          const code = item.Code || item.code || item.StockCode || '';
          const name = item.Name || item.name || item.StockName || '';
          const board = item.Board || item.board || '';
          const sector = item.Sector || item.sector || item.SectorName || '';
          if (code) {
            tickers.push({ code: code.trim(), name, board, sector });
          }
        }
      }
    }
  } catch (e) {
    // Method 1 failed, try method 2
  }

  // Method 2: Fallback — scrape from IDX listed companies page
  if (tickers.length === 0) {
    try {
      const url2 = 'https://www.idx.co.id/primary/ListedCompany/GetCompanyProfiles?start=0&length=2000&language=id-id';
      const response2 = UrlFetchApp.fetch(url2, {
        muteHttpExceptions: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Referer': 'https://www.idx.co.id/id/perusahaan-tercatat/profil-perusahaan-tercatat/'
        }
      });

      if (response2.getResponseCode() === 200) {
        const json2 = JSON.parse(response2.getContentText());
        const data2 = json2.data || json2.Data || json2;

        if (Array.isArray(data2)) {
          for (const item of data2) {
            const code = item.KodeEmiten || item.Code || '';
            const name = item.NamaEmiten || item.Name || '';
            if (code) {
              tickers.push({ code: code.trim(), name, board: '', sector: '' });
            }
          }
        }
      }
    } catch (e2) {
      // Method 2 also failed
    }
  }

  // Method 3: Final fallback — Yahoo Finance IDX component list
  if (tickers.length === 0) {
    try {
      // Try fetching from Yahoo Finance screener for IDX stocks
      const url3 = 'https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=ID&scrIds=most_actives_id&count=250';
      const response3 = UrlFetchApp.fetch(url3, {
        muteHttpExceptions: true,
        headers: {
          'User-Agent': 'Mozilla/5.0'
        }
      });

      if (response3.getResponseCode() === 200) {
        const json3 = JSON.parse(response3.getContentText());
        const quotes = json3.finance?.result?.[0]?.quotes || [];
        for (const q of quotes) {
          const symbol = q.symbol || '';
          if (symbol.endsWith('.JK')) {
            tickers.push({
              code: symbol.replace('.JK', ''),
              name: q.shortName || q.longName || '',
              board: '',
              sector: ''
            });
          }
        }
      }
    } catch (e3) {
      // All methods failed
    }
  }

  // Method 4: Use fallback list from payload if all else fails
  if (tickers.length === 0 && fallbackList && Array.isArray(fallbackList) && fallbackList.length > 0) {
    for (const t of fallbackList) {
      tickers.push({
        code: t.trim(),
        name: t.trim(),
        board: 'Fallback',
        sector: 'Fallback'
      });
    }
  }

  if (tickers.length === 0) {
    return { error: 'Gagal scrape ticker IDX. Coba lagi nanti atau tambahkan manual.', count: 0 };
  }

  // Sort alphabetically
  tickers.sort((a, b) => a.code.localeCompare(b.code));

  // Remove duplicates
  const unique = [];
  const seen = new Set();
  for (const t of tickers) {
    if (!seen.has(t.code)) {
      seen.add(t.code);
      unique.push(t);
    }
  }

  // Write to "Ticker List" sheet
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(SHEET_TICKERS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_TICKERS);
  }

  // Clear existing data
  sheet.clear();

  // Write headers
  const headers = [['NO', 'TICKER', 'NAMA', 'BOARD', 'SECTOR', 'LAST UPDATED']];
  sheet.getRange(1, 1, 1, 6).setValues(headers);

  // Write ticker data
  const now = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'dd/MM/yyyy HH:mm');
  const rows = unique.map((t, i) => [i + 1, t.code, t.name, t.board, t.sector, now]);

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 6).setValues(rows);
  }

  return {
    success: true,
    count: unique.length,
    source: tickers.length > 0 ? 'IDX API' : 'fallback',
    tickers: unique.map(t => t.code)
  };
}

/**
 * Read ticker list from spreadsheet
 * @returns {Object} { tickers: string[], count }
 */
function getTickerListFromSheet() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_TICKERS);

  if (!sheet || sheet.getLastRow() <= 1) {
    return { tickers: [], count: 0, message: 'Ticker list kosong. Jalankan "Scrape Tickers" dulu.' };
  }

  const data = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues();
  const tickers = data.map(row => row[0].toString().trim()).filter(t => t.length > 0);

  return { tickers, count: tickers.length };
}

/**
 * Scan using tickers from the spreadsheet (auto mode)
 * Results are automatically saved to "Screener Results" sheet
 */
function scanFromSheet(threshold) {
  // Read tickers from sheet
  const tickerData = getTickerListFromSheet();
  if (tickerData.count === 0) {
    return { error: 'Ticker list kosong. Scrape dulu via action=scrapeTickers' };
  }

  // Run scan
  const result = scanStocks(tickerData.tickers, threshold);

  // Auto-save results to Screener Results sheet
  if (result.results && result.results.length > 0) {
    saveScreenerResults(result.results);
  }

  return result;
}

/**
 * Save screener results to "Screener Results" sheet
 */
function saveScreenerResults(results) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(SHEET_SCREENER);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_SCREENER);
  }

  // Clear existing data
  sheet.clear();

  // Headers
  const headers = [[
    'NO', 'TICKER', 'CLOSE', 'MA5', 'MA10', 'MA20',
    'COMPRESSION %', 'LEVEL', 'VOLUME', 'AVG VOL 20',
    'VOL RATIO', 'BREAKOUT SIGNAL', 'DIRECTION',
    'RSI', 'MACD', 'FIB TP1', 'FIB TP2', 'FIB SL',
    'TP1 %', 'TP2 %', 'SL %', 'SCAN DATE', 'CORP ACTION'
  ]];
  sheet.getRange(1, 1, 1, 23).setValues(headers);

  // Data rows
  const now = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'dd/MM/yyyy HH:mm');
  const rows = results.map((r, i) => [
    i + 1,
    r.ticker,
    r.close,
    r.ma5,
    r.ma10,
    r.ma20,
    r.compressionRatio,
    r.compressionLevel,
    r.volume,
    r.avgVolume20,
    r.volumeRatio,
    r.breakoutSignal,
    r.breakoutDirection,
    r.rsi,
    r.macdHistogram,
    r.fibonacci ? r.fibonacci.tp1 : '',
    r.fibonacci ? r.fibonacci.tp2 : '',
    r.fibonacci ? r.fibonacci.sl : '',
    r.fibonacci ? r.fibonacci.tp1Pct : '',
    r.fibonacci ? r.fibonacci.tp2Pct : '',
    r.fibonacci ? r.fibonacci.slPct : '',
    now,
    r.corpActionWarning || ''
  ]);

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 23).setValues(rows);
  }

  return { success: true, saved: rows.length };
}

// ============================================================
// CORPORATE ACTIONS (DIVIDENDS)
// ============================================================

/**
 * Scrape Corporate Actions (Dividends) from IDX API
 * We use corsproxy.io to bypass any geo-blocks or 403s on Google's IPs
 */
function scrapeCorpActions() {
  let actions = [];
  
  try {
    const url = 'https://corsproxy.io/?' + encodeURIComponent('https://www.idx.co.id/primary/CorporateAction/GetDividend?start=0&length=100');
    
    const response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });

    if (response.getResponseCode() === 200) {
      const data = JSON.parse(response.getContentText());
      if (data && data.data) {
        actions = data.data.map(item => ({
          ticker: item.StockCode,
          type: 'Cash Dividend',
          amount: item.DividendPerShare,
          cumDate: item.CumDate,
          exDate: item.ExDate,
          recordingDate: item.RecordingDate,
          paymentDate: item.PaymentDate
        }));
      }
    }
  } catch (err) {
    console.error('Failed to fetch from IDX:', err);
  }

  // Save to sheet
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName('Corp Actions');
  if (!sheet) {
    sheet = ss.insertSheet('Corp Actions');
    sheet.appendRow(['Ticker', 'Type', 'Amount', 'CumDate', 'ExDate', 'RecordingDate', 'PaymentDate']);
    sheet.getRange("1:1").setFontWeight("bold");
    sheet.setFrozenRows(1);
  } else {
    // Clear old data
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
    }
  }

  if (actions.length > 0) {
    // Filter out old dividends (ExDate already passed by more than 7 days)
    const now = new Date();
    const validActions = actions.filter(a => {
      if (!a.exDate) return false;
      const ex = new Date(a.exDate);
      return (ex.getTime() > now.getTime() - (7 * 24 * 60 * 60 * 1000));
    });

    const rows = validActions.map(a => [
      a.ticker, a.type, a.amount, 
      formatDateStr(a.cumDate), formatDateStr(a.exDate), 
      formatDateStr(a.recordingDate), formatDateStr(a.paymentDate)
    ]);
    
    if (rows.length > 0) {
      sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
    }
  }
  
  return { count: actions.length, actions: actions };
}

function formatDateStr(dateStr) {
  if (!dateStr) return '';
  return dateStr.split('T')[0];
}

function getCorpActions() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName('Corp Actions');
  if (!sheet) return { actions: [] };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { actions: [] };

  const data = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
  const actions = data.map(row => ({
    ticker: row[0],
    type: row[1],
    amount: row[2],
    cumDate: formatDateStr(row[3] ? row[3].toString() : ''),
    exDate: formatDateStr(row[4] ? row[4].toString() : ''),
    recordingDate: formatDateStr(row[5] ? row[5].toString() : ''),
    paymentDate: formatDateStr(row[6] ? row[6].toString() : '')
  }));

  // Sort by ExDate ascending
  actions.sort((a, b) => new Date(a.exDate) - new Date(b.exDate));

  return { actions };
}
