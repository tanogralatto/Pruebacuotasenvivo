/**
 * TanoApp Goles — mercados del partido completo (1X2, doble oportunidad, totales, ambos marcan, hándicap asiático).
 *
 * Parte pura (sin navegador), probada con Node en tests/modelo-ft.test.js:
 *  - scoreMatrix / summarize: matriz de marcadores con dos Poisson y lo que sale de ella (1X2, goles, diferencia).
 *  - betProbs / evaluate: para cualquier apuesta, probabilidad de ganar, ganar la mitad, devolver, perder la mitad
 *    y perder; cuota justa, EV y score (0-100).
 *  - parseOdds: lee las cuotas de /odds de API-Football (todas las casas) y arma, por apuesta, la mejor cuota y el
 *    precio sin margen de las casas (Pinnacle o mediana).
 *  - matchMarkets / matchEdge: todas las apuestas del partido agrupadas como en la pantalla y el edge (0-100).
 *  - rps / goalsRps / ece / backtestLeague: métricas de la pestaña Precisión.
 */
(function (root) {
  'use strict';

  const isNum = n => typeof n === 'number' && Number.isFinite(n);
  const EPS = 1e-9;
  const G = 10; // goles máximos por equipo en la matriz (lo que queda afuera es despreciable y se renormaliza)

  function poissonPmf(k, l) {
    let p = Math.exp(-l);
    for (let i = 1; i <= k; i++) p *= l / i;
    return p;
  }

  /* ------------------------------------------------------------------ */
  /* 1. Matriz de marcadores                                             */
  /* ------------------------------------------------------------------ */
  // Corrección Dixon-Coles: con rho < 0 sube un poco el 0-0 y el 1-1 y baja el 1-0 y el 0-1.
  // La suma de la matriz no cambia (la corrección se compensa sola entre esos cuatro marcadores).
  function dcTau(i, j, lh, la, rho) {
    if (!rho) return 1;
    if (i === 0 && j === 0) return 1 - lh * la * rho;
    if (i === 0 && j === 1) return 1 + lh * rho;
    if (i === 1 && j === 0) return 1 + la * rho;
    if (i === 1 && j === 1) return 1 - rho;
    return 1;
  }
  function scoreMatrix(lh, la, rho) {
    if (!(lh >= 0) || !(la >= 0)) return null;
    const r = isNum(rho) ? rho : 0;
    const ph = [], pa = [];
    for (let k = 0; k <= G; k++) { ph.push(poissonPmf(k, lh)); pa.push(poissonPmf(k, la)); }
    const m = [];
    let tot = 0;
    for (let i = 0; i <= G; i++) { m.push([]); for (let j = 0; j <= G; j++) { const q = ph[i] * pa[j] * Math.max(0, dcTau(i, j, lh, la, r)); m[i].push(q); tot += q; } }
    for (let i = 0; i <= G; i++) for (let j = 0; j <= G; j++) m[i][j] /= tot;
    return m;
  }

  // 1X2, ambos marcan y distribución del total de goles (0..5 y «6 o más» en el último lugar).
  function summarize(m) {
    let home = 0, draw = 0, away = 0, btts = 0;
    const totals = new Array(7).fill(0);
    for (let i = 0; i <= G; i++) for (let j = 0; j <= G; j++) {
      const q = m[i][j];
      if (i > j) home += q; else if (i === j) draw += q; else away += q;
      if (i > 0 && j > 0) btts += q;
      totals[Math.min(6, i + j)] += q;
    }
    let exp = 0;
    for (let i = 0; i <= G; i++) for (let j = 0; j <= G; j++) exp += m[i][j] * (i + j);
    return { home, draw, away, btts, totals, expGoals: exp };
  }

  /* ------------------------------------------------------------------ */
  /* 2. Apuestas                                                         */
  /* ------------------------------------------------------------------ */
  // Las líneas de cuarto (±0,25, ±0,75…) se dividen en dos mitades.
  function lineParts(line) {
    const frac = Math.abs(line * 4) % 2;
    return Math.abs(frac - 1) < EPS ? [line - 0.25, line + 0.25] : [line];
  }
  // Resultado por unidad (1, 0,5, 0, −0,5, −1) de un margen x (positivo = gana la apuesta) contra una línea.
  function lineResult(x, line) {
    const parts = lineParts(line);
    let r = 0;
    for (const l of parts) { const a = x + l; r += a > EPS ? 1 : a < -EPS ? -1 : 0; }
    return r / parts.length;
  }

  // Resultado por unidad de una apuesta para un marcador i-j.
  // bet: {type:'1x2', pick:'home'|'draw'|'away'} · {type:'dc', pick:'1X'|'12'|'X2'} · {type:'btts', pick:'yes'|'no'}
  //      {type:'total', side:'over'|'under', line} · {type:'ah', side:'home'|'away', line} (line = la del lado apostado)
  function betResult(bet, i, j) {
    switch (bet.type) {
      case '1x2': return (bet.pick === 'home' ? i > j : bet.pick === 'away' ? i < j : i === j) ? 1 : -1;
      case 'dc': return (bet.pick === '1X' ? i >= j : bet.pick === 'X2' ? i <= j : i !== j) ? 1 : -1;
      case 'btts': return ((i > 0 && j > 0) === (bet.pick === 'yes')) ? 1 : -1;
      case 'total': return bet.side === 'over' ? lineResult(i + j, -bet.line) : lineResult(-(i + j), bet.line);
      case 'ah': return bet.side === 'home' ? lineResult(i - j, bet.line) : lineResult(j - i, bet.line);
      default: return null;
    }
  }

  function betProbs(bet, m) {
    const o = { win: 0, halfWin: 0, push: 0, halfLose: 0, lose: 0 };
    for (let i = 0; i <= G; i++) for (let j = 0; j <= G; j++) {
      const r = betResult(bet, i, j), q = m[i][j];
      if (r > 0.75) o.win += q; else if (r > 0.25) o.halfWin += q; else if (r > -0.25) o.push += q; else if (r > -0.75) o.halfLose += q; else o.lose += q;
    }
    o.W = o.win + o.halfWin / 2;
    o.L = o.lose + o.halfLose / 2;
    o.p = o.W + o.L > 0 ? o.W / (o.W + o.L) : null; // probabilidad de ganar sin contar devoluciones
    o.fair = o.p > 0 ? 1 / o.p : null;
    return o;
  }

  // Score 0-100: crece con el EV (se satura cerca de +15%) y pesa más las apuestas probables (cuotas bajas).
  // Una cuota de 1,40 con valor es más confiable que una de 4,00 con el mismo EV: el error del modelo pesa menos.
  function betScore(ev, p) {
    if (!isNum(ev) || !isNum(p) || ev <= 0) return 0;
    return Math.round(100 * Math.sqrt(Math.tanh(ev / 0.08)) * Math.pow(p, 1.2));
  }

  function evaluate(probs, price) {
    if (!probs || !isNum(probs.p) || !(price > 1)) return null;
    const ev = probs.W * (price - 1) - probs.L; // por unidad apostada (las devoluciones no ganan ni pierden)
    const stakeBase = probs.W + probs.L;          // EV sobre lo que realmente se juega
    const evPct = stakeBase > 0 ? ev / stakeBase : ev;
    return { ev: evPct, fair: probs.fair, p: probs.p, score: betScore(evPct, probs.p) };
  }

  /* ------------------------------------------------------------------ */
  /* 3. Cuotas de API-Football                                           */
  /* ------------------------------------------------------------------ */
  const HALF = /(half|1st|2nd|first|second|tiempo|parte|period|\bht\b)/i;
  const NOT_GOALS = /(corner|card|tarjeta|booking|home|away|team|equipo|exact|minute|minuto|odd|even|&|\band\b|result|double|draw|win|margin|both halves|race|first|last|asian)/i;
  const num = s => Number(String(s).replace(',', '.'));
  const q4 = x => Math.round(x * 4) / 4;

  function betKind(name) {
    const n = String(name || '');
    if (HALF.test(n) || /corner|card|tarjeta|booking/i.test(n)) return null;
    if (/^(match winner|1x2|resultado( final)?|full ?time result)$/i.test(n.trim())) return '1x2';
    if (/^double chance$|^doble oportunidad$/i.test(n.trim())) return 'dc';
    if (/^(both teams (to )?score|ambos (equipos )?marcan|btts)$/i.test(n.trim())) return 'btts';
    if (/asian\s*handicap|h[aá]ndicap\s*asi[aá]tico/i.test(n) && !/alternative/i.test(n)) return 'ah';
    if (/(goals?\s*over\s*\/?\s*under|over\s*\/\s*under|total\s*goals?|^goles$)/i.test(n) && !NOT_GOALS.test(n.replace(/over\s*\/?\s*under/i, ''))) return 'total';
    return null;
  }

  // Lee un valor y devuelve [clave de la apuesta, objeto bet] o null.
  function readValue(kind, value, ahOwnSign) {
    const v = String(value.value ?? value.name ?? '').trim();
    const lv = v.toLowerCase();
    if (kind === '1x2') {
      const pick = /^(home|1|local)$/.test(lv) ? 'home' : /^(draw|x|empate)$/.test(lv) ? 'draw' : /^(away|2|visitante)$/.test(lv) ? 'away' : null;
      return pick ? ['1x2:' + pick, { type: '1x2', pick }] : null;
    }
    if (kind === 'dc') {
      const s = lv.replace(/\s/g, '');
      const pick = /^(home\/draw|1x|draw\/home)$/.test(s) ? '1X' : /^(draw\/away|x2|away\/draw)$/.test(s) ? 'X2' : /^(home\/away|12|away\/home)$/.test(s) ? '12' : null;
      return pick ? ['dc:' + pick, { type: 'dc', pick }] : null;
    }
    if (kind === 'btts') {
      const pick = /^(yes|sí|si)$/.test(lv) ? 'yes' : /^no$/.test(lv) ? 'no' : null;
      return pick ? ['btts:' + pick, { type: 'btts', pick }] : null;
    }
    if (kind === 'total') {
      const m = lv.match(/^(over|under|más de|mas de|menos de)\s*([0-9]+(?:[.,][0-9]+)?)$/);
      if (!m) return null;
      const side = /^(over|más de|mas de)/.test(m[1]) ? 'over' : 'under', line = q4(num(m[2]));
      if (!(line >= 0.5 && line <= 8)) return null;
      return ['total:' + side + ':' + line, { type: 'total', side, line }];
    }
    if (kind === 'ah') {
      const m = v.match(/^(home|away|local|visitante|1|2)\s*([+-]?\d+(?:[.,]\d+)?)(?:\s*[,/]\s*([+-]?\d+(?:[.,]\d+)?))?$/i);
      let side = null, line = null;
      if (m) { side = /^(home|local|1)$/i.test(m[1]) ? 'home' : 'away'; line = m[3] != null ? (num(m[2]) + num(m[3])) / 2 : num(m[2]); }
      else if (/^(home|away|local|visitante|1|2)$/i.test(v) && value.handicap != null) { side = /^(home|local|1)$/i.test(v) ? 'home' : 'away'; line = num(value.handicap); }
      if (!side || !isNum(line)) return null;
      line = q4(line);
      // La línea del visitante: algunas casas la escriben con su propio signo y otras repiten la del local.
      if (side === 'away' && !ahOwnSign) line = -line;
      if (Math.abs(line) > 4) return null;
      return ['ah:' + side + ':' + line, { type: 'ah', side, line }];
    }
    return null;
  }

  // Grupos de apuestas que se reparten el 100% (para sacar el margen de cada casa).
  function marketGroup(key) {
    const [t, a, b] = key.split(':');
    if (t === '1x2') return '1x2';
    if (t === 'btts') return 'btts';
    if (t === 'total') return 'total:' + b;
    if (t === 'ah') return 'ah:' + (a === 'home' ? Number(b) : -Number(b));
    return null; // doble oportunidad: se saca del 1X2
  }

  const MAX_GAP = 0.10; // una casa que se aleja más de 10 puntos del precio de referencia casi siempre tiene una cuota vieja

  // Devuelve Map(clave -> {key, bet, best:{price,bookmaker}, mkt (probabilidad sin margen), books})
  function parseOdds(response) {
    const perBook = new Map(); // casa -> Map(clave -> {bet, price})
    for (const item of response || []) {
      for (const bk of item.bookmakers || item.odds?.bookmakers || []) {
        const bkName = bk.name || bk.title || 'Casa';
        const rec = perBook.get(bkName) || new Map();
        for (const betObj of bk.bets || bk.odds || []) {
          const kind = betKind(betObj.name || betObj.bet);
          if (!kind) continue;
          const vals = (betObj.values || []).filter(x => x && x.suspended !== true && Number(x.odd ?? x.price) > 1);
          const read = own => {
            const out = new Map();
            for (const value of vals) {
              const r = readValue(kind, value, own);
              if (r && !out.has(r[0])) out.set(r[0], { bet: r[1], price: Number(value.odd ?? value.price) });
            }
            return out;
          };
          let got = read(true);
          if (kind === 'ah') {
            // Se prueban las dos lecturas del visitante y se queda la que arma pares coherentes (margen 0-20%).
            const pairs = m => { let ok = 0; for (const [k, x] of m) if (x.bet.side === 'home') { const y = m.get('ah:away:' + (-x.bet.line)); if (y) { const s = 1 / x.price + 1 / y.price; if (s >= 0.98 && s <= 1.2) ok++; } } return ok; };
            const alt = read(false);
            if (pairs(alt) > pairs(got)) got = alt;
          }
          for (const [k, x] of got) if (!rec.has(k)) rec.set(k, x);
        }
        if (rec.size) perBook.set(bkName, rec);
      }
    }
    // Probabilidad sin margen por casa y por grupo.
    const fairBy = new Map(); // clave -> [{bk, p, price}]
    for (const [bk, rec] of perBook) {
      const groups = new Map();
      for (const [k, x] of rec) { const g = marketGroup(k); if (!g) continue; if (!groups.has(g)) groups.set(g, []); groups.get(g).push([k, x]); }
      for (const [g, list] of groups) {
        const need = g === '1x2' ? 3 : 2;
        if (list.length !== need) continue;
        const s = list.reduce((a, [, x]) => a + 1 / x.price, 0);
        if (!(s >= 0.98 && s <= 1.25)) continue;
        for (const [k, x] of list) { if (!fairBy.has(k)) fairBy.set(k, []); fairBy.get(k).push({ bk, p: (1 / x.price) / s, price: x.price }); }
      }
    }
    const out = new Map();
    const median = xs => { const s = xs.slice().sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
    for (const [k, list] of fairBy) {
      const pin = list.find(x => /pinnacle/i.test(x.bk));
      const med = median(list.map(x => x.p));
      const ref = pin && (list.length < 3 || Math.abs(pin.p - med) <= MAX_GAP) ? pin.p : med;
      let best = null;
      for (const x of list) if (Math.abs(x.p - ref) <= MAX_GAP && (!best || x.price > best.price)) best = { price: x.price, bookmaker: x.bk };
      const bet = perBook.get(list[0].bk).get(k).bet;
      if (best) out.set(k, { key: k, bet, best, mkt: ref, books: list.length });
    }
    // Doble oportunidad: precio sin margen sacado del 1X2; mejor cuota de las casas que la ofrecen.
    const h = out.get('1x2:home'), d = out.get('1x2:draw'), a = out.get('1x2:away');
    if (h && d && a) {
      const tot = h.mkt + d.mkt + a.mkt;
      const ref = { '1X': (h.mkt + d.mkt) / tot, 'X2': (d.mkt + a.mkt) / tot, '12': (h.mkt + a.mkt) / tot };
      for (const pick of ['1X', 'X2', '12']) {
        const k = 'dc:' + pick;
        let best = null, n = 0;
        for (const [bk, rec] of perBook) {
          const x = rec.get(k);
          if (!x) continue;
          n++;
          if (1 / x.price > ref[pick] + MAX_GAP || 1 / x.price < ref[pick] - MAX_GAP - 0.1) continue;
          if (!best || x.price > best.price) best = { price: x.price, bookmaker: bk };
        }
        if (best) out.set(k, { key: k, bet: { type: 'dc', pick }, best, mkt: ref[pick], books: n });
      }
    }
    return out;
  }

  // Probabilidades 1X2 sin margen de las casas (para comparar el modelo con el mercado).
  function market1x2(odds) {
    const h = odds && odds.get('1x2:home'), d = odds && odds.get('1x2:draw'), a = odds && odds.get('1x2:away');
    if (!h || !d || !a) return null;
    const t = h.mkt + d.mkt + a.mkt;
    return [h.mkt / t, d.mkt / t, a.mkt / t];
  }

  /* ------------------------------------------------------------------ */
  /* 4. Mercados del partido, agrupados como en la pantalla              */
  /* ------------------------------------------------------------------ */
  const GROUPS = [
    { id: 'high', title: 'Muchos goles', kind: 'goals' },
    { id: 'low', title: 'Pocos goles', kind: 'goals' },
    { id: 'home', title: 'Gana {home}', kind: 'result' },
    { id: 'away', title: 'Gana {away}', kind: 'result' },
    { id: 'other', title: 'Otros', kind: 'result' }
  ];
  function groupOf(bet) {
    if (bet.type === 'total') return bet.side === 'over' ? 'high' : 'low';
    if (bet.type === 'btts') return bet.pick === 'yes' ? 'high' : 'low';
    if (bet.type === '1x2') return bet.pick === 'draw' ? 'other' : bet.pick;
    if (bet.type === 'dc') return bet.pick === '1X' ? 'home' : bet.pick === 'X2' ? 'away' : 'other';
    if (bet.type === 'ah') return bet.side;
    return 'other';
  }
  const fmtLine = l => (l > 0 ? '+' : l < 0 ? '−' : '') + String(Math.abs(l)).replace('.', ',');
  function betLabel(bet, hn, an) {
    switch (bet.type) {
      case '1x2': return bet.pick === 'draw' ? 'Empate' : '1X2 ' + (bet.pick === 'home' ? hn : an);
      case 'dc': return 'Doble oportunidad ' + (bet.pick === '1X' ? hn + ' o empate' : bet.pick === 'X2' ? 'empate o ' + an : hn + ' o ' + an);
      case 'btts': return 'Ambos marcan ' + (bet.pick === 'yes' ? 'Sí' : 'No');
      case 'total': return (bet.side === 'over' ? 'Más de ' : 'Menos de ') + String(bet.line).replace('.', ',');
      case 'ah': return 'Hándicap ' + (bet.side === 'home' ? hn : an) + ' ' + fmtLine(bet.line);
      default: return '';
    }
  }

  // lam = {home, away}; odds = salida de parseOdds. Devuelve las filas con cuota, cuota justa, EV y score.
  function matchMarkets(lam, odds, names) {
    const m = scoreMatrix(lam.home, lam.away, lam.rho);
    const rows = [];
    if (!m || !odds) return { rows, matrix: m };
    for (const o of odds.values()) {
      const probs = betProbs(o.bet, m);
      const e = evaluate(probs, o.best.price);
      if (!e) continue;
      rows.push({ key: o.key, bet: o.bet, group: groupOf(o.bet), label: betLabel(o.bet, names && names.home || 'Local', names && names.away || 'Visitante'),
        price: o.best.price, bookmaker: o.best.bookmaker, fair: e.fair, p: e.p, ev: e.ev, score: e.score, mkt: o.mkt,
        evMkt: o.mkt > 0 ? o.mkt * o.best.price - 1 : null });
    }
    rows.sort((a, b) => b.score - a.score || b.ev - a.ev);
    return { rows, matrix: m };
  }

  // Edge del partido (0-100): combina los dos grupos con mejor score (si dos grupos distintos tienen valor, suma).
  function matchEdge(rows, allowedGroups) {
    const best = new Map();
    for (const r of rows || []) {
      if (allowedGroups && !allowedGroups.has(r.group)) continue;
      if (r.score > (best.get(r.group) || 0)) best.set(r.group, r.score);
    }
    const top = [...best.values()].sort((a, b) => b - a).slice(0, 2);
    if (!top.length) return 0;
    return Math.round(100 * (1 - top.reduce((acc, s) => acc * (1 - s / 100), 1)));
  }

  /* ------------------------------------------------------------------ */
  /* 5. Métricas de precisión                                            */
  /* ------------------------------------------------------------------ */
  // RPS (más bajo = mejor) de un pronóstico ordenado (1X2: local, empate, visitante) contra el resultado (índice).
  function rps(probs, outcome) {
    let cp = 0, co = 0, s = 0;
    for (let k = 0; k < probs.length - 1; k++) { cp += probs[k]; co += k === outcome ? 1 : 0; s += (cp - co) ** 2; }
    return s / (probs.length - 1);
  }
  const outcome1x2 = (hg, ag) => hg > ag ? 0 : hg === ag ? 1 : 2;
  const goalsRps = (dist, total) => rps(dist, Math.min(dist.length - 1, total));

  // Error de calibración (ECE) del 1X2: cada probabilidad dada (local, empate, visitante) contra si pasó.
  function ece(rows) {
    const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
    let n = 0;
    for (const r of rows || []) {
      if (!r || !r.p1x2 || !isNum(r.hg) || !isNum(r.ag)) continue;
      const o = outcome1x2(r.hg, r.ag);
      r.p1x2.forEach((p, k) => { const b = bins[Math.min(9, Math.floor(p * 10))]; b.n++; b.p += p; b.y += k === o ? 1 : 0; n++; });
    }
    if (!n) return { ece: null, bins: [] };
    let e = 0;
    const out = [];
    for (const b of bins) if (b.n) { e += (b.n / n) * Math.abs(b.p / b.n - b.y / b.n); out.push({ n: b.n, predicted: b.p / b.n, observed: b.y / b.n }); }
    return { ece: e, bins: out };
  }

  // Backtest honesto de una liga: cada partido se pronostica con el modelo ajustado SOLO con partidos anteriores
  // (se reajusta una vez por semana). T = modelo-poisson.js. games = partidos con goles finales en hg/ag
  // (y xG en xh/xa si hay). Devuelve los goles esperados de cada partido; withProbs arma las probabilidades.
  function backtestLeague(games, T, opts) {
    const o = Object.assign({ batchDays: 7, minHistory: 40, xgWeight: 0 }, opts || {});
    const list = (games || []).filter(g => g && isNum(g.ts) && g.h != null && g.a != null && isNum(g.hg) && isNum(g.ag)).slice().sort((a, b) => a.ts - b.ts);
    const rows = [];
    if (list.length <= o.minHistory) return rows;
    let fit = null, fitAt = -Infinity;
    for (let idx = o.minHistory; idx < list.length; idx++) {
      const g = list[idx];
      if (g.ts - fitAt >= o.batchDays * 86400 || !fit) {
        const fm = T.buildFitMatches(list, { cutoffTs: g.ts, currentSeason: g.season, goals: 'ft', halfLifeDays: o.halfLifeDays || 240, xgWeight: o.xgWeight });
        fit = T.fitLeague(fm, { priorMatches: o.priorMatches || 14 });
        fitAt = g.ts;
      }
      if (!fit || !fit.ok) continue;
      const pr = T.predictMatch(fit, g.h, g.a, {});
      if (!pr.ok) continue;
      rows.push({ id: g.id, ts: g.ts, hg: g.hg, ag: g.ag, lh: pr.lambdaHome, la: pr.lambdaAway, muH: fit.muH, muA: fit.muA });
    }
    return rows;
  }
  // Probabilidades de cada fila del backtest con una corrección rho dada.
  function withProbs(rows, rho) {
    return (rows || []).map(r => {
      const s = summarize(scoreMatrix(r.lh, r.la, rho));
      const base = summarize(scoreMatrix(r.muH, r.muA, rho)); // «decir siempre el promedio de goles de la liga»
      return Object.assign({}, r, { p1x2: [s.home, s.draw, s.away], goals: s.totals, baseGoals: base.totals, expGoals: s.expGoals });
    });
  }
  // rho de Dixon-Coles por máxima verosimilitud (solo cuentan los marcadores 0-0, 1-0, 0-1 y 1-1).
  // Con pocos partidos se acerca al valor típico (−0,06).
  const RHO_PRIOR = -0.06, RHO_WEIGHT = 300;
  function fitRho(rows) {
    let best = 0, bestLL = -Infinity, n = 0;
    for (const r of rows || []) if (isNum(r.lh) && isNum(r.la) && isNum(r.hg) && isNum(r.ag)) n++;
    if (!n) return { rho: RHO_PRIOR, raw: null, n: 0 };
    for (let k = -30; k <= 15; k++) {
      const rho = k / 100;
      let ll = 0;
      for (const r of rows) {
        if (!isNum(r.lh) || r.hg > 1 || r.ag > 1) continue;
        ll += Math.log(Math.max(1e-9, dcTau(r.hg, r.ag, r.lh, r.la, rho)));
      }
      if (ll > bestLL) { bestLL = ll; best = rho; }
    }
    return { rho: (n * best + RHO_WEIGHT * RHO_PRIOR) / (n + RHO_WEIGHT), raw: best, n };
  }
  // Error total de un backtest (goles + 1X2): sirve para elegir si una liga usa xG y corrección.
  function backtestError(rows) {
    let e = 0, n = 0;
    for (const r of rows || []) { const t = r.hg + r.ag; e += goalsRps(r.goals, t) + rps(r.p1x2, outcome1x2(r.hg, r.ag)); n++; }
    return n ? e / n : null;
  }

  /* ------------------------------------------------------------------ */
  /* 6. xG                                                               */
  /* ------------------------------------------------------------------ */
  // Lee las estadísticas de un partido (/fixtures?ids=… o /fixtures/statistics): xG de la API si viene, y tiros.
  const statNum = v => { if (v == null) return null; const n = Number(String(v).replace('%', '').replace(',', '.')); return Number.isFinite(n) && n >= 0 ? n : null; };
  function readStats(statistics, homeId, awayId) {
    const out = {};
    for (const block of statistics || []) {
      const id = block && block.team && block.team.id;
      const side = String(id) === String(homeId) ? 'home' : String(id) === String(awayId) ? 'away' : null;
      if (!side) continue;
      const t = {};
      for (const st of block.statistics || []) {
        const type = String(st && st.type || '').toLowerCase().trim();
        const v = statNum(st && st.value);
        if (/^(expected[_ ]goals?|xg|goles esperados)$/.test(type)) t.xg = v;
        else if (type === 'shots on goal') t.sot = v;
        else if (type === 'shots insidebox') t.sib = v;
        else if (type === 'shots outsidebox') t.sob = v;
        else if (type === 'total shots') t.shots = v;
      }
      out[side] = t;
    }
    return out.home && out.away ? out : null;
  }
  // xG aproximado con los tiros: a·tiros dentro del área + b·tiros fuera del área + c·tiros al arco.
  const XG_DEFAULT = { a: 0.07, b: 0.02, c: 0.17 };
  function proxyXg(t, coef) {
    const k = coef || XG_DEFAULT;
    if (!t) return null;
    let sib = t.sib, sob = t.sob;
    if (!isNum(sib) && !isNum(sob) && isNum(t.shots)) { sib = t.shots * 0.6; sob = t.shots * 0.4; }
    if (!isNum(sib) || !isNum(sob) || !isNum(t.sot)) return null;
    return k.a * sib + k.b * sob + k.c * t.sot;
  }
  // Ajusta a, b, c con partidos que tienen tiros y goles (mínimos cuadrados, sin coeficientes negativos).
  function fitProxy(samples) {
    const xs = (samples || []).filter(x => x && isNum(x.sib) && isNum(x.sob) && isNum(x.sot) && isNum(x.goals));
    if (xs.length < 300) return Object.assign({ n: xs.length, fitted: false }, XG_DEFAULT);
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], y = [0, 0, 0];
    for (const x of xs) { const v = [x.sib, x.sob, x.sot]; for (let i = 0; i < 3; i++) { y[i] += v[i] * x.goals; for (let j = 0; j < 3; j++) A[i][j] += v[i] * v[j]; } }
    for (let i = 0; i < 3; i++) A[i][i] += 1e-6 + xs.length * 0.01; // un poco de regularización
    // Resolver 3x3 (Cramer).
    const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det(A);
    if (!(Math.abs(D) > 1e-12)) return Object.assign({ n: xs.length, fitted: false }, XG_DEFAULT);
    const col = k => det(A.map((row, i) => row.map((v, j) => j === k ? y[i] : v))) / D;
    const a = Math.max(0, col(0)), b = Math.max(0, col(1)), c = Math.max(0, col(2));
    return { a, b, c, n: xs.length, fitted: true };
  }

  // Resumen de goles de un conjunto de filas del backtest.
  function goalsSkill(rows) {
    let m = 0, b = 0, n = 0, exp = 0, real = 0;
    const dist = new Array(7).fill(0), realDist = new Array(7).fill(0);
    for (const r of rows || []) {
      if (!r || !r.goals || !r.baseGoals) continue;
      const t = r.hg + r.ag;
      m += goalsRps(r.goals, t); b += goalsRps(r.baseGoals, t); n++;
      exp += r.expGoals; real += t;
      r.goals.forEach((p, k) => { dist[k] += p; }); realDist[Math.min(6, t)]++;
    }
    if (!n) return { n: 0, skill: null };
    return { n, skill: 1 - m / b, rpsModel: m / n, rpsBase: b / n, expGoals: exp / n, realGoals: real / n, dist: dist.map(x => x / n), realDist: realDist.map(x => x / n) };
  }

  // Habilidad 1X2 contra el mercado: filas con p1x2 (modelo), m1x2 (casas sin margen) y resultado.
  function marketSkill(rows) {
    let m = 0, k = 0, n = 0;
    for (const r of rows || []) {
      if (!r || !r.p1x2 || !r.m1x2 || !isNum(r.hg) || !isNum(r.ag)) continue;
      const o = outcome1x2(r.hg, r.ag);
      m += rps(r.p1x2, o); k += rps(r.m1x2, o); n++;
    }
    if (!n) return { n: 0, skill: null };
    return { n, skill: 1 - m / k, rpsModel: m / n, rpsMarket: k / n };
  }

  const api = {
    dcTau, withProbs, fitRho, backtestError, readStats, proxyXg, fitProxy, XG_DEFAULT,
    poissonPmf, scoreMatrix, summarize, lineParts, lineResult, betResult, betProbs, betScore, evaluate,
    betKind, parseOdds, market1x2, GROUPS, groupOf, betLabel, matchMarkets, matchEdge,
    rps, outcome1x2, goalsRps, ece, backtestLeague, goalsSkill, marketSkill
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TanoFT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
