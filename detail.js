export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { coin } = req.query;
  if (!coin) return res.status(400).json({ error: 'coin 파라미터 필요' });

  const symbol = coin.toUpperCase();

  try {
    const [tickerRes, candleRes, orderbookRes] = await Promise.all([
      fetch(`https://api.bithumb.com/public/ticker/${symbol}_KRW`),
      fetch(`https://api.bithumb.com/public/candlestick/${symbol}_KRW/1h`),
      fetch(`https://api.bithumb.com/public/orderbook/${symbol}_KRW?count=10`),
    ]);

    const [ticker, candle, orderbook] = await Promise.all([
      tickerRes.json(), candleRes.json(), orderbookRes.json()
    ]);

    if (ticker.status !== '0000') {
      return res.status(404).json({ error: `${symbol} 코인을 찾을 수 없어요` });
    }

    const t = ticker.data;
    const price     = parseFloat(t.closing_price);
    const open      = parseFloat(t.opening_price);
    const high      = parseFloat(t.max_price);
    const low       = parseFloat(t.min_price);
    const prevClose = parseFloat(t.prev_closing_price);
    const vol24     = parseFloat(t.units_traded_24H);
    const tradeVal  = parseFloat(t.acc_trade_value_24H);
    const changePct = (price - prevClose) / prevClose * 100;

    let closes = [], highs = [], lows = [], vols = [];
    if (candle.status === '0000' && candle.data) {
      candle.data.slice(-200).forEach(c => {
        closes.push(parseFloat(c[2]));
        highs.push(parseFloat(c[3]));
        lows.push(parseFloat(c[4]));
        vols.push(parseFloat(c[5]));
      });
    }
    if (closes.length === 0) closes = [price];

    const n = closes.length;
    const ma5   = avg(closes.slice(-5));
    const ma10  = avg(closes.slice(-10));
    const ma20  = avg(closes.slice(-Math.min(20, n)));
    const ma50  = avg(closes.slice(-Math.min(50, n)));
    const ma100 = avg(closes.slice(-Math.min(100, n)));
    const ma200 = avg(closes.slice(-Math.min(200, n)));
    const ema12 = calcEMA(closes, 12);
    const ema26 = calcEMA(closes, 26);
    const macdLine   = ema12 - ema26;
    const macdSignal = calcEMA(closes.map((_, i) => {
      const e12 = calcEMAUpTo(closes, 12, i);
      const e26 = calcEMAUpTo(closes, 26, i);
      return e12 - e26;
    }), 9);
    const rsiVal  = calcRSI(closes, Math.min(14, n - 1));
    const bb      = calcBB(closes, Math.min(20, n), 2);
    const stoch   = calcStoch(closes, highs.length ? highs : [high], lows.length ? lows : [low], Math.min(14, n));
    const volAvg  = avg(vols.slice(-Math.min(20, vols.length)));
    const volCurr = vols[vols.length - 1] || 0;
    const volRatio = volAvg > 0 ? volCurr / volAvg : 1;

    let bidTotal = 0, askTotal = 0;
    if (orderbook.status === '0000') {
      (orderbook.data.bids || []).forEach(b => bidTotal += parseFloat(b.quantity) * parseFloat(b.price));
      (orderbook.data.asks || []).forEach(a => askTotal += parseFloat(a.quantity) * parseFloat(a.price));
    }
    const bidRatio = bidTotal + askTotal > 0 ? bidTotal / (bidTotal + askTotal) * 100 : 50;

    // 신호 종합
    const signals = [];
    if (ma5 && ma20)  signals.push(price > ma5   ? 1 : -1);
    if (ma20 && ma50) signals.push(price > ma20  ? 1 : -1);
    if (ma50)         signals.push(price > ma50  ? 1 : -1);
    if (ma200)        signals.push(price > ma200 ? 1 : -1);
    if (ma5 && ma20)  signals.push(ma5 > ma20    ? 1 : -1);
    if (rsiVal < 30) signals.push(1);
    else if (rsiVal > 70) signals.push(-1);
    else signals.push(0);
    signals.push(macdLine > macdSignal ? 1 : -1);
    if (bb) {
      if (price < bb.lower) signals.push(1);
      else if (price > bb.upper) signals.push(-1);
      else signals.push(0);
    }
    if (stoch < 20) signals.push(1);
    else if (stoch > 80) signals.push(-1);
    else signals.push(0);
    signals.push(volRatio > 1.5 ? 1 : volRatio < 0.7 ? -1 : 0);
    signals.push(bidRatio > 55 ? 1 : bidRatio < 45 ? -1 : 0);

    const buyCount  = signals.filter(s => s > 0).length;
    const sellCount = signals.filter(s => s < 0).length;
    const score     = Math.round(buyCount / signals.length * 100);

    let signal = 'HOLD';
    if (score >= 70) signal = 'BUY';
    else if (score >= 55) signal = 'WATCH';
    else if (score <= 30) signal = 'SELL';

    return res.status(200).json({
      symbol, price, open, high, low, prevClose, vol24, tradeVal,
      changePct, score, signal, buyCount, sellCount,
      ma5, ma10, ma20, ma50, ma100, ma200,
      rsi: rsiVal, macdLine, macdSignal,
      bbUpper: bb?.upper, bbMid: bb?.mid, bbLower: bb?.lower,
      stoch, volRatio, bidRatio,
      updatedAt: new Date().toISOString()
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function avg(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function calcRSI(arr, n) {
  if (arr.length < n + 1) return 50;
  let g = 0, l = 0;
  for (let i = arr.length - n; i < arr.length; i++) {
    const d = arr[i] - arr[i-1]; if (d > 0) g += d; else l -= d;
  }
  return 100 - 100 / (1 + (l === 0 ? 100 : g / l));
}
function calcEMA(arr, n) {
  if (arr.length < n) return arr[arr.length - 1] || 0;
  const k = 2 / (n + 1);
  let e = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}
function calcEMAUpTo(arr, n, upTo) { return calcEMA(arr.slice(0, upTo + 1), n); }
function calcBB(arr, n, m) {
  if (arr.length < n) return null;
  const sl = arr.slice(-n);
  const mid = sl.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(sl.reduce((a, b) => a + (b - mid) ** 2, 0) / n);
  return { upper: mid + m * std, mid, lower: mid - m * std };
}
function calcStoch(closes, highs, lows, n) {
  if (closes.length < n) return 50;
  const c = closes[closes.length - 1];
  const h = Math.max(...highs.slice(-n));
  const l = Math.min(...lows.slice(-n));
  return h === l ? 50 : (c - l) / (h - l) * 100;
}
