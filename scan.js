export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // 1. 빗썸 전체 코인 티커 한번에 가져오기
    const allRes = await fetch('https://api.bithumb.com/public/ticker/ALL_KRW');
    const allData = await allRes.json();

    if (allData.status !== '0000') {
      return res.status(500).json({ error: '빗썸 API 오류' });
    }

    const coins = Object.entries(allData.data)
      .filter(([k]) => k !== 'date')
      .map(([symbol, t]) => {
        const price     = parseFloat(t.closing_price) || 0;
        const prevClose = parseFloat(t.prev_closing_price) || price;
        const open      = parseFloat(t.opening_price) || price;
        const high      = parseFloat(t.max_price) || price;
        const low       = parseFloat(t.min_price) || price;
        const vol24     = parseFloat(t.units_traded_24H) || 0;
        const tradeVal  = parseFloat(t.acc_trade_value_24H) || 0;
        const changePct = prevClose > 0 ? (price - prevClose) / prevClose * 100 : 0;

        return { symbol, price, prevClose, open, high, low, vol24, tradeVal, changePct };
      })
      .filter(c => c.tradeVal > 500000000); // 거래대금 5억 이상만

    // 2. 각 코인 캔들 데이터 병렬 수집 (상위 거래대금 기준 최대 200개)
    const sorted = coins.sort((a, b) => b.tradeVal - a.tradeVal).slice(0, 200);

    // 30개씩 배치 처리
    const BATCH = 30;
    const results = [];

    for (let i = 0; i < sorted.length; i += BATCH) {
      const batch = sorted.slice(i, i + BATCH);
      const batchResults = await Promise.allSettled(
        batch.map(c => fetchCandle(c))
      );
      batchResults.forEach(r => {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      });
    }

    // 3. 점수 기준 정렬
    const scored = results
      .sort((a, b) => b.score - a.score)
      .slice(0, 50); // 상위 50개 반환

    return res.status(200).json({
      total: coins.length,
      scanned: results.length,
      results: scored,
      updatedAt: new Date().toISOString()
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

async function fetchCandle(coinData) {
  const { symbol, price, prevClose, open, high, low, vol24, tradeVal, changePct } = coinData;
  try {
    const r = await fetch(`https://api.bithumb.com/public/candlestick/${symbol}_KRW/1h`);
    const d = await r.json();

    let closes = [], highs = [], lows = [], vols = [];
    if (d.status === '0000' && d.data) {
      d.data.slice(-120).forEach(c => {
        closes.push(parseFloat(c[2]));
        highs.push(parseFloat(c[3]));
        lows.push(parseFloat(c[4]));
        vols.push(parseFloat(c[5]));
      });
    }
    if (closes.length < 5) {
      closes = [price]; highs = [high]; lows = [low]; vols = [vol24];
    }

    const n = closes.length;
    const ma5   = avg(closes.slice(-5));
    const ma10  = avg(closes.slice(-10));
    const ma20  = avg(closes.slice(-Math.min(20, n)));
    const ma50  = avg(closes.slice(-Math.min(50, n)));
    const ma200 = avg(closes.slice(-Math.min(200, n)));
    const rsiVal = calcRSI(closes, Math.min(14, n-1));
    const bb    = calcBB(closes, Math.min(20, n), 2);
    const stoch = calcStoch(closes, highs, lows, Math.min(14, n));
    const volAvg = avg(vols.slice(-Math.min(20, vols.length)));
    const volRatio = volAvg > 0 ? (vols[vols.length-1] || 0) / volAvg : 1;

    // ── 전문 트레이더 스코어링 ──
    let score = 50;

    // 추세 (30점)
    if (price > ma200) score += 8;  else score -= 8;
    if (price > ma50)  score += 7;  else score -= 7;
    if (price > ma20)  score += 6;  else score -= 6;
    if (ma5 > ma20)    score += 5;  else score -= 5;
    if (price > open)  score += 4;  else score -= 4;

    // 모멘텀 RSI (20점)
    if (rsiVal < 25)       score += 15;
    else if (rsiVal < 35)  score += 9;
    else if (rsiVal < 45)  score += 4;
    else if (rsiVal > 75)  score -= 12;
    else if (rsiVal > 65)  score -= 6;
    else if (rsiVal > 55)  score -= 2;

    // 스토캐스틱 (10점)
    if (stoch < 20)      score += 8;
    else if (stoch > 80) score -= 8;
    else if (stoch < 40) score += 3;

    // 볼린저밴드 (15점)
    if (bb) {
      if (price < bb.lower)       score += 12;
      else if (price < bb.mid)    score += 4;
      else if (price > bb.upper)  score -= 12;
      else                        score -= 2;
    }

    // 거래량 (15점)
    if (volRatio > 3.0)      score += 12;
    else if (volRatio > 2.0) score += 8;
    else if (volRatio > 1.5) score += 5;
    else if (volRatio > 1.0) score += 2;
    else if (volRatio < 0.5) score -= 8;
    else if (volRatio < 0.7) score -= 4;

    // 당일 변동 (10점)
    if (changePct > 5 && volRatio > 1.5)  score += 7;
    else if (changePct > 3)               score += 4;
    else if (changePct > 0)               score += 1;
    else if (changePct < -10)             score -= 10;
    else if (changePct < -5)              score -= 6;

    // 거래대금 신뢰도
    if (tradeVal > 1e11)      score += 5;
    else if (tradeVal > 1e10) score += 3;
    else if (tradeVal < 1e9)  score -= 8;

    score = Math.max(0, Math.min(100, Math.round(score)));

    let signal = 'HOLD';
    if (score >= 72)      signal = 'BUY';
    else if (score >= 58) signal = 'WATCH';
    else if (score <= 28) signal = 'SELL';

    // 이유 태그
    const tags = [];
    if (rsiVal < 35)                  tags.push({ t: 'RSI과매도', c: 'buy' });
    if (price > ma200 && ma5 > ma20)  tags.push({ t: '골든크로스', c: 'buy' });
    else if (ma5 > ma20)              tags.push({ t: '단기상승', c: 'buy' });
    if (bb && price < bb.lower)       tags.push({ t: 'BB하단', c: 'buy' });
    if (volRatio > 2)                 tags.push({ t: `거래량${volRatio.toFixed(1)}x`, c: 'vol' });
    if (changePct > 5)                tags.push({ t: `+${changePct.toFixed(1)}%`, c: 'up' });
    if (rsiVal > 65)                  tags.push({ t: 'RSI과매수', c: 'sell' });
    if (ma5 < ma20)                   tags.push({ t: '데드크로스', c: 'sell' });
    if (changePct < -5)               tags.push({ t: `${changePct.toFixed(1)}%`, c: 'sell' });

    return {
      symbol, price, changePct, score, signal,
      rsi: Math.round(rsiVal * 10) / 10,
      volRatio: Math.round(volRatio * 100) / 100,
      tradeVal, ma20, ma50, ma200,
      bbLower: bb ? Math.round(bb.lower) : null,
      bbUpper: bb ? Math.round(bb.upper) : null,
      tags: tags.slice(0, 4)
    };
  } catch {
    return null;
  }
}

function avg(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function calcRSI(arr, n) {
  if (arr.length < n + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = arr.length - n; i < arr.length; i++) {
    const d = arr[i] - arr[i-1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs = losses === 0 ? 100 : gains / losses;
  return 100 - 100 / (1 + rs);
}

function calcBB(arr, n, mult) {
  if (arr.length < n) return null;
  const sl = arr.slice(-n);
  const mid = sl.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(sl.reduce((a, b) => a + (b - mid) ** 2, 0) / n);
  return { upper: mid + mult * std, mid, lower: mid - mult * std };
}

function calcStoch(closes, highs, lows, n) {
  if (closes.length < n) return 50;
  const c = closes[closes.length - 1];
  const h = Math.max(...highs.slice(-n));
  const l = Math.min(...lows.slice(-n));
  return h === l ? 50 : (c - l) / (h - l) * 100;
}
