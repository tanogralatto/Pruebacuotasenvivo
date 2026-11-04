/**
 * TANOapp — hándicap asiático (partido completo).
 *
 * Parte pura (sin navegador), probada con Node en tests/asiaticos.test.js:
 *  - diffDist: probabilidad de cada diferencia de goles (local − visitante) con dos Poisson independientes.
 *  - lineProbs: para una línea y un lado, probabilidad de ganar, ganar la mitad, devolver, perder la mitad y perder.
 *  - parseOdds: lee las cuotas «Asian Handicap» de /odds de API-Football (todas las casas y líneas).
 *  - view: arma la escalera de líneas con cuota justa, mejor cuota, precio del mercado sin margen, EV y stake.
 *
 * Convención: la línea siempre es la del LOCAL. Local −0,5 = el local tiene que ganar; el visitante juega +0,5.
 * En líneas de cuarto (±0,25, ±0,75…) la apuesta se divide en dos mitades (p. ej. −0,25 = mitad a 0 y mitad a −0,5).
 */
(function (root) {
  'use strict';

  const isNum = n => typeof n === 'number' && Number.isFinite(n);
  const EPS = 1e-9;

  function poissonPmf(k, l) {
    let p = Math.exp(-l);
    for (let i = 1; i <= k; i++) p *= l / i;
    return p;
  }

  // Distribución de la diferencia de goles. Devuelve { min, p: [..] } con p[d - min] = P(local − visitante = d).
  function diffDist(lh, la, maxG) {
    const G = maxG || 12;
    if (!(lh >= 0) || !(la >= 0)) return null;
    const ph = [], pa = [];
    for (let k = 0; k <= G; k++) { ph.push(poissonPmf(k, lh)); pa.push(poissonPmf(k, la)); }
    const p = new Array(2 * G + 1).fill(0);
    let tot = 0;
    for (let i = 0; i <= G; i++) for (let j = 0; j <= G; j++) { const q = ph[i] * pa[j]; p[i - j + G] += q; tot += q; }
    for (let k = 0; k < p.length; k++) p[k] /= tot; // lo que queda fuera de 0..G se reparte (es despreciable)
    return { min: -G, p };
  }

  // Partes de una línea: las de cuarto se dividen en dos mitades.
  function lineParts(line) {
    const frac = Math.abs(line * 4) % 2;
    return Math.abs(frac - 1) < EPS ? [line - 0.25, line + 0.25] : [line];
  }

  // Resultado por unidad para una diferencia d (desde el lado apostado) y una línea: 1, 0,5, 0, −0,5 o −1.
  function outcome(d, line) {
    const parts = lineParts(line);
    let r = 0;
    for (const x of parts) { const a = d + x; r += a > EPS ? 1 : a < -EPS ? -1 : 0; }
    return r / parts.length;
  }

  // side: 'home' (la línea se aplica al local) o 'away' (al visitante se le aplica −line).
  function lineProbs(dist, line, side) {
    const out = { win: 0, halfWin: 0, push: 0, halfLose: 0, lose: 0 };
    if (!dist) return null;
    for (let k = 0; k < dist.p.length; k++) {
      const dHome = dist.min + k, p = dist.p[k];
      const r = side === 'away' ? outcome(-dHome, -line) : outcome(dHome, line);
      if (r > 0.75) out.win += p; else if (r > 0.25) out.halfWin += p; else if (r > -0.25) out.push += p; else if (r > -0.75) out.halfLose += p; else out.lose += p;
    }
    out.W = out.win + out.halfWin / 2;   // lo que «se gana» contando medias
    out.L = out.lose + out.halfLose / 2; // lo que «se pierde» contando medias
    out.pCond = out.W + out.L > 0 ? out.W / (out.W + out.L) : null; // probabilidad de ganar sin contar devoluciones
    out.fair = out.pCond > 0 ? 1 / out.pCond : null;                // cuota justa
    return out;
  }

  /* ---------------------------- cuotas ---------------------------- */
  const HALF = /(half|1st|2nd|first|second|tiempo|parte|period|\bht\b)/i;
  const isAhBet = name => /asian\s*handicap|h[aá]ndicap\s*asi[aá]tico/i.test(name) && !HALF.test(name) && !/corner|card|tarjeta|booking/i.test(name);
  const num = s => Number(String(s).replace(',', '.'));
  function parseValue(value) {
    const v = String(value.value ?? value.name ?? '').trim();
    const m = v.match(/^(home|away|local|visitante|1|2)\s*([+-]?\d+(?:[.,]\d+)?)(?:\s*[,/]\s*([+-]?\d+(?:[.,]\d+)?))?$/i);
    let side = null, line = null;
    if (m) {
      side = /^(home|local|1)$/i.test(m[1]) ? 'home' : 'away';
      line = m[3] != null ? (num(m[2]) + num(m[3])) / 2 : num(m[2]);
    } else if (/^(home|away|local|visitante|1|2)$/i.test(v) && value.handicap != null) {
      side = /^(home|local|1)$/i.test(v) ? 'home' : 'away';
      line = num(value.handicap);
    }
    const price = Number(value.odd ?? value.price);
    if (!side || !isNum(line) || !(price > 1)) return null;
    return { side, line: Math.round(line * 4) / 4, price };
  }

  // Devuelve { books: Map(casa -> Map(líneaLocal -> {home, away})), raw: [ejemplos de texto], betNames: [...] }.
  // Las casas escriben la línea del visitante de dos maneras: con su propio signo («Away +0.5» cuando el local
  // juega −0,5) o repitiendo la del local («Away -0.5»). Se detecta cuál usa cada casa.
  function parseOdds(response) {
    const books = new Map(), raw = [], betNames = new Set();
    for (const item of response || []) {
      for (const bk of item.bookmakers || item.odds?.bookmakers || []) {
        const bkName = bk.name || bk.title || 'Casa no informada';
        for (const bet of bk.bets || bk.odds || []) {
          const name = String(bet.name || bet.bet || '');
          if (!isAhBet(name)) continue;
          betNames.add(name);
          const vals = [];
          for (const value of bet.values || []) {
            if (value.suspended === true) continue;
            if (raw.length < 16) raw.push(bkName + ' · ' + name + ' · ' + String(value.value ?? '') + (value.handicap != null ? ' (handicap ' + value.handicap + ')' : '') + ' @ ' + String(value.odd ?? ''));
            const pv = parseValue(value);
            if (pv) vals.push(pv);
          }
          if (!vals.length) continue;
          const homes = vals.filter(x => x.side === 'home'), aways = vals.filter(x => x.side === 'away');
          const has = (arr, l) => arr.some(x => Math.abs(x.line - l) < EPS);
          let own = 0, same = 0;
          for (const h of homes) if (Math.abs(h.line) > EPS) { if (has(aways, -h.line)) own++; if (has(aways, h.line)) same++; }
          const awayIsOwnLine = own >= same; // lo habitual: la línea del visitante con su propio signo
          const lines = books.get(bkName) || new Map();
          for (const h of homes) { const rec = lines.get(h.line) || {}; rec.home = h.price; lines.set(h.line, rec); }
          for (const a of aways) { const l = awayIsOwnLine ? -a.line : a.line; const rec = lines.get(l) || {}; rec.away = a.price; lines.set(l, rec); }
          books.set(bkName, lines);
        }
      }
    }
    return { books, raw, betNames: [...betNames] };
  }

  // Por línea: mejor cuota de cada lado y probabilidad sin margen (Pinnacle o mediana de las casas con los dos lados).
  function marketByLine(parsed) {
    const out = new Map();
    if (!parsed) return out;
    for (const [bk, lines] of parsed.books) {
      for (const [l, rec] of lines) {
        const o = out.get(l) || { line: l, bestHome: null, bestAway: null, pairs: [] };
        if (rec.home && (!o.bestHome || rec.home > o.bestHome.price)) o.bestHome = { price: rec.home, bookmaker: bk };
        if (rec.away && (!o.bestAway || rec.away > o.bestAway.price)) o.bestAway = { price: rec.away, bookmaker: bk };
        if (rec.home && rec.away) o.pairs.push({ bk, pHome: (1 / rec.home) / (1 / rec.home + 1 / rec.away), gap: Math.abs(rec.home - rec.away) });
        out.set(l, o);
      }
    }
    for (const o of out.values()) {
      const pin = o.pairs.find(x => /pinnacle/i.test(x.bk));
      if (pin) { o.mktHome = pin.pHome; o.mktRef = 'Pinnacle, sin margen'; }
      else if (o.pairs.length) {
        const ps = o.pairs.map(x => x.pHome).sort((a, b) => a - b), n = ps.length;
        o.mktHome = n % 2 ? ps[(n - 1) / 2] : (ps[n / 2 - 1] + ps[n / 2]) / 2;
        o.mktRef = 'mediana de ' + n + ' casa' + (n > 1 ? 's' : '') + ', sin margen';
      }
    }
    return out;
  }

  // Línea principal: la de cuotas más parejas en Pinnacle (o en la casa con más líneas).
  function mainLine(parsed, byLine) {
    let ref = null;
    for (const [bk, lines] of parsed ? parsed.books : []) {
      if (/pinnacle/i.test(bk)) { ref = lines; break; }
      if (!ref || lines.size > ref.size) ref = lines;
    }
    let best = null;
    for (const [l, rec] of ref || []) if (rec.home && rec.away) { const g = Math.abs(rec.home - rec.away); if (!best || g < best.g) best = { l, g }; }
    if (best) return best.l;
    let any = null;
    for (const o of byLine.values()) if (o.pairs.length) { const g = Math.min(...o.pairs.map(x => x.gap)); if (!any || g < any.g) any = { l: o.line, g }; }
    return any ? any.l : null;
  }

  // Escalera completa. lambdas FT del modelo; T = modelo (para kellyStake). opts.maxGap = diferencia máxima con el mercado.
  function view(inp, T, opts) {
    const o = Object.assign({ from: -3, to: 3, maxGap: 0.12, validated: false }, opts || {});
    const lh = inp && inp.lambdaHome, la = inp && inp.lambdaAway;
    const parsed = inp && inp.odds;
    if (!(lh > 0) || !(la > 0)) return { ok: false, reason: 'Sin goles esperados del partido completo: no se puede calcular el hándicap.' };
    const dist = diffDist(lh, la);
    const byLine = marketByLine(parsed);
    const main = mainLine(parsed, byLine);
    const side = (line, s, mk) => {
      const pr = lineProbs(dist, line, s);
      const best = mk ? (s === 'home' ? mk.bestHome : mk.bestAway) : null;
      const mkt = mk && isNum(mk.mktHome) ? (s === 'home' ? mk.mktHome : 1 - mk.mktHome) : null;
      const odds = best ? best.price : null;
      const ev = odds && isNum(pr.pCond) ? pr.pCond * odds - 1 : null;
      const evMkt = odds && isNum(mkt) ? mkt * odds - 1 : null;
      const gap = isNum(mkt) && isNum(pr.pCond) ? pr.pCond - mkt : null;
      const suspicious = isNum(gap) && Math.abs(gap) > o.maxGap;
      const kel = odds && T && T.kellyStake ? T.kellyStake({ p: pr.pCond, odds, marketProb: isNum(mkt) ? mkt : undefined, validated: o.validated }) : null;
      return Object.assign({}, pr, { best, odds, mkt, ev, evMkt, gap, suspicious, kelly: kel });
    };
    const lines = [];
    for (let l = o.from; l <= o.to + EPS; l += 0.25) {
      const line = Math.round(l * 4) / 4, mk = byLine.get(line) || null;
      lines.push({ line, home: side(line, 'home', mk), away: side(line, 'away', mk), mktRef: mk ? mk.mktRef || null : null, hasOdds: !!(mk && (mk.bestHome || mk.bestAway)) });
    }
    // Líneas con cuota fuera del rango mostrado (partidos muy desparejos).
    for (const [line, mk] of byLine) if (line < o.from - EPS || line > o.to + EPS) lines.push({ line, home: side(line, 'home', mk), away: side(line, 'away', mk), mktRef: mk.mktRef || null, hasOdds: true });
    lines.sort((a, b) => a.line - b.line);
    // Sin cuotas: la línea principal es la que el modelo ve más pareja.
    const modelMain = lines.reduce((b, x) => (!b || Math.abs(x.home.pCond - 0.5) < Math.abs(b.home.pCond - 0.5) ? x : b), null);
    const mainRow = lines.find(x => main != null && Math.abs(x.line - main) < EPS) || modelMain;
    return { ok: true, lambdaHome: lh, lambdaAway: la, main: mainRow, mainFromOdds: main != null, lines, books: parsed ? parsed.books.size : 0, raw: parsed ? parsed.raw : [], betNames: parsed ? parsed.betNames : [] };
  }

  const api = { diffDist, lineParts, outcome, lineProbs, parseOdds, marketByLine, mainLine, view };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TanoAsian = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
