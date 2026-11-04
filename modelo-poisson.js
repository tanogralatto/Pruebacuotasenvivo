/**
 * TANOapp — modelo Poisson v2 para goles al descanso (Over 0,5 1T).
 *
 * Módulo puro: no hace llamadas a API ni toca la interfaz.
 *
 * Qué hace (de punta a punta):
 *  1. buildFitMatches  → arma los partidos de entrenamiento con peso por antigüedad
 *                        (y descuento a la temporada anterior). Opcionalmente mezcla xG.
 *  2. fitLeague        → estima ataque y defensa de CADA equipo de la liga a la vez,
 *                        ajustando por la calidad del rival y con regresión a la media
 *                        (prior Gamma). Ya no mezcla partidos de local y visitante.
 *  3. predictMatch     → λ local, λ visitante, P(Over 0,5 1T) y su incertidumbre.
 *  4. fitCalibration   → corrige la probabilidad con regresión logística (solo se usa
 *                        si el backtest fuera de muestra demuestra que mejora).
 *  5. rollingBacktest  → backtest cronológico (solo datos previos) con el MISMO
 *                        pipeline que usa la app en producción.
 *  6. evDecision       → regla estricta de EV (edge mínimo, incertidumbre, mercado).
 *  7. liveRemainingLambda / liveMarket → probabilidad y EV durante el 1T.
 *
 * Formato de partido normalizado (entrada de las funciones de ajuste):
 *   { id, ts (segundos), h, a, hg, ag, season, leagueId?, fth?, fta?, xh?, xa? }
 *   hg/ag = goles AL DESCANSO. fth/fta = goles finales. xh/xa = xG del partido completo.
 */
(function (root) {
  'use strict';

  const DAY = 86400;
  const DEFAULTS = Object.freeze({
    priorMatches: 14,       // regresión a la media, en "partidos equivalentes"
    iterations: 80,         // iteraciones del ajuste de fuerzas
    halfLifeDays: 240,      // vida media del peso por antigüedad
    prevSeasonWeight: 0.6,  // descuento a la temporada anterior
    minFitMatches: 30,      // mínimo de partidos de la liga para ajustar
    minTeamEffective: 5,    // mínimo de partidos efectivos (suma de pesos) por equipo
    minWeight: 0.02,        // se descartan partidos con peso menor
    xgWeight: 0,            // 0 = solo goles; 0..1 = mezcla con xG escalado al 1T
    zLow: 1,                // desvíos para el límite inferior conservador
    batchDays: 7            // el backtest reajusta cada semana
  });

  const isNum = n => typeof n === 'number' && Number.isFinite(n);
  const validGoals = n => isNum(n) && n >= 0;
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const sigmoid = x => 1 / (1 + Math.exp(-x));
  const logit = p => Math.log(p / (1 - p));

  function round(n, digits) {
    const p = 10 ** digits;
    return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * p) / p : null;
  }

  function poissonPmf(k, lambda) {
    if (!(lambda >= 0) || k < 0) return 0;
    if (lambda === 0) return k === 0 ? 1 : 0;
    let logp = -lambda + k * Math.log(lambda);
    for (let i = 2; i <= k; i++) logp -= Math.log(i);
    return Math.exp(logp);
  }

  /* ------------------------------------------------------------------ */
  /* 1. Partidos de entrenamiento                                        */
  /* ------------------------------------------------------------------ */
  function buildFitMatches(games, ctx) {
    const o = Object.assign({}, DEFAULTS, ctx || {});
    const cutoff = o.cutoffTs;
    if (!isNum(cutoff) || !Array.isArray(games)) return [];

    // Proporción de goles que caen en el 1T (solo con partidos que tienen HT y final).
    let ht = 0, ft = 0;
    for (const g of games) {
      if (g && g.ts < cutoff && validGoals(g.hg) && validGoals(g.ag) && validGoals(g.fth) && validGoals(g.fta)) {
        ht += g.hg + g.ag;
        ft += g.fth + g.fta;
      }
    }
    // Con goles del partido completo (o.goals === 'ft') el xG se usa tal cual, sin escalar al 1T.
    const htShare = o.goals === 'ft' ? 1 : ft >= 100 ? clamp(ht / ft, 0.3, 0.6) : 0.45;

    const out = [];
    for (const g of games) {
      if (!g || !isNum(g.ts) || g.ts >= cutoff) continue;
      if (g.h == null || g.a == null || !validGoals(g.hg) || !validGoals(g.ag)) continue;
      let w = Math.pow(0.5, (cutoff - g.ts) / DAY / o.halfLifeDays);
      if (o.currentSeason != null && String(g.season) !== String(o.currentSeason)) w *= o.prevSeasonWeight;
      if (w < o.minWeight) continue;
      let hg = g.hg, ag = g.ag, usedXg = false;
      if (o.xgWeight > 0 && validGoals(g.xh) && validGoals(g.xa)) {
        hg = (1 - o.xgWeight) * hg + o.xgWeight * g.xh * htShare;
        ag = (1 - o.xgWeight) * ag + o.xgWeight * g.xa * htShare;
        usedXg = true;
      }
      out.push({ h: String(g.h), a: String(g.a), hg, ag, w, usedXg });
    }
    out.htShare = htShare;
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 2. Ajuste de fuerzas de toda la liga                                */
  /* ------------------------------------------------------------------ */
  function fitLeague(matches, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const ms = (matches || []).filter(m => m && m.w > 0 && validGoals(m.hg) && validGoals(m.ag));
    if (ms.length < o.minFitMatches) {
      return { ok: false, reason: `Muestra insuficiente: ${ms.length} partidos con HT válido de la liga (mínimo ${o.minFitMatches}).`, matches: ms.length };
    }

    let sw = 0, sh = 0, sa = 0;
    for (const m of ms) { sw += m.w; sh += m.w * m.hg; sa += m.w * m.ag; }
    const muH = sh / sw, muA = sa / sw;
    if (!(muH > 0 && muA > 0)) return { ok: false, reason: 'Los promedios de goles HT de la liga no son válidos.', matches: ms.length };

    // Prior Gamma con media 1: equivale a `priorMatches` partidos de un equipo promedio.
    const kappa = Math.max(0.01, o.priorMatches * (muH + muA) / 2);

    const index = new Map(), ids = [];
    const ix = id => {
      if (!index.has(id)) { index.set(id, ids.length); ids.push(id); }
      return index.get(id);
    };
    const hi = new Array(ms.length), ai = new Array(ms.length);
    ms.forEach((m, k) => { hi[k] = ix(m.h); ai[k] = ix(m.a); });
    const n = ids.length;

    const Sa = new Float64Array(n), Sd = new Float64Array(n), W = new Float64Array(n), N = new Float64Array(n);
    ms.forEach((m, k) => {
      const i = hi[k], j = ai[k];
      Sa[i] += m.w * m.hg; Sa[j] += m.w * m.ag;
      Sd[i] += m.w * m.ag; Sd[j] += m.w * m.hg;
      W[i] += m.w; W[j] += m.w; N[i]++; N[j]++;
    });

    const att = new Float64Array(n).fill(1), def = new Float64Array(n).fill(1);
    const Ea = new Float64Array(n), Ed = new Float64Array(n);
    let iterations = 0;
    for (let it = 0; it < o.iterations; it++) {
      iterations = it + 1;
      Ea.fill(0);
      ms.forEach((m, k) => {
        const i = hi[k], j = ai[k];
        Ea[i] += m.w * muH * def[j];
        Ea[j] += m.w * muA * def[i];
      });
      let change = 0;
      for (let t = 0; t < n; t++) {
        const v = (kappa + Sa[t]) / (kappa + Ea[t]);
        change = Math.max(change, Math.abs(v - att[t]));
        att[t] = v;
      }
      Ed.fill(0);
      ms.forEach((m, k) => {
        const i = hi[k], j = ai[k];
        Ed[i] += m.w * muA * att[j];
        Ed[j] += m.w * muH * att[i];
      });
      for (let t = 0; t < n; t++) {
        const v = (kappa + Sd[t]) / (kappa + Ed[t]);
        change = Math.max(change, Math.abs(v - def[t]));
        def[t] = v;
      }
      if (change < 1e-7) break;
    }

    const teams = {};
    ids.forEach((id, t) => {
      teams[id] = { attack: att[t], defence: def[t], nEff: W[t], n: N[t], sA: Sa[t], sD: Sd[t] };
    });
    return { ok: true, muH, muA, kappa, teams, matches: ms.length, teamCount: n, iterations, htShare: matches.htShare };
  }

  /* ------------------------------------------------------------------ */
  /* 3. Predicción de un partido                                         */
  /* ------------------------------------------------------------------ */
  function predictMatch(fit, homeId, awayId, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    if (!fit || !fit.ok) return { ok: false, reason: (fit && fit.reason) || 'El modelo no pudo ajustarse.' };
    const H = fit.teams[String(homeId)], A = fit.teams[String(awayId)];
    if (!H || !A) return { ok: false, reason: `${!H ? 'El local' : 'El visitante'} no tiene partidos previos en esta competición (temporada actual y anterior).` };
    if (H.nEff < o.minTeamEffective || A.nEff < o.minTeamEffective) {
      return {
        ok: false,
        reason: `Muestra efectiva insuficiente: local ${H.nEff.toFixed(1)}, visitante ${A.nEff.toFixed(1)} partidos ponderados (mínimo ${o.minTeamEffective}).`,
        nEffHome: round(H.nEff, 1), nEffAway: round(A.nEff, 1)
      };
    }
    const lamH = fit.muH * H.attack * A.defence;
    const lamA = fit.muA * A.attack * H.defence;
    const lam = lamH + lamA;
    const k = fit.kappa;
    const relH = 1 / (k + H.sA) + 1 / (k + A.sD);
    const relA = 1 / (k + A.sA) + 1 / (k + H.sD);
    const seLam = Math.sqrt(lamH * lamH * relH + lamA * lamA * relA);
    const p = 1 - Math.exp(-lam);
    const pLow = clamp(1 - Math.exp(-Math.max(0, lam - o.zLow * seLam)), 0, 1);
    const pHigh = clamp(1 - Math.exp(-(lam + o.zLow * seLam)), 0, 1);
    const seH = lamH * Math.sqrt(relH), seA = lamA * Math.sqrt(relA);
    return {
      ok: true,
      lambdaHome: lamH, lambdaAway: lamA, lambdaTotal: lam, seLambda: seLam, seHome: seH, seAway: seA,
      pOver05: p, pLow, pHigh,
      pOver10: 1 - Math.exp(-lam) * (1 + lam),
      nEffHome: H.nEff, nEffAway: A.nEff, nHome: H.n, nAway: A.n,
      strengths: { homeAttack: H.attack, homeDefence: H.defence, awayAttack: A.attack, awayDefence: A.defence },
      league: { muH: fit.muH, muA: fit.muA, matches: fit.matches, teams: fit.teamCount }
    };
  }

  /* ------------------------------------------------------------------ */
  /* 3b. Mercados: +0,5 1T, Ambos marcan y +2,5 goles                    */
  /* ------------------------------------------------------------------ */
  // Para 'btts' y 'over25' el ajuste se hace con goles del PARTIDO COMPLETO (ver ftGames).
  const MARKETS = ['ht05', 'btts', 'over25'];
  const pOver25 = l => 1 - Math.exp(-l) * (1 + l + l * l / 2);
  const pBtts = (lh, la) => (1 - Math.exp(-lh)) * (1 - Math.exp(-la));
  // Probabilidad del mercado con su rango (±zLow desvíos de λ). pr = resultado de predictMatch.
  function marketProbs(pr, market, opts) {
    const z = opts && isNum(opts.zLow) ? opts.zLow : DEFAULTS.zLow;
    if (!pr || !pr.ok) return null;
    if (market === 'over25') {
      const l = pr.lambdaTotal, se = pr.seLambda;
      return { p: pOver25(l), pLow: pOver25(Math.max(0, l - z * se)), pHigh: pOver25(l + z * se) };
    }
    if (market === 'btts') {
      const lh = pr.lambdaHome, la = pr.lambdaAway, sh = pr.seHome || 0, sa = pr.seAway || 0;
      return { p: pBtts(lh, la), pLow: pBtts(Math.max(0, lh - z * sh), Math.max(0, la - z * sa)), pHigh: pBtts(lh + z * sh, la + z * sa) };
    }
    return { p: pr.pOver05, pLow: pr.pLow, pHigh: pr.pHigh };
  }
  // Resultado real (1 = se cumplió) de un partido normalizado. Para btts/over25 usa goles finales.
  function marketOutcome(g, market) {
    if (market === 'btts') return validGoals(g.fth) && validGoals(g.fta) ? (g.fth > 0 && g.fta > 0 ? 1 : 0) : null;
    if (market === 'over25') return validGoals(g.fth) && validGoals(g.fta) ? (g.fth + g.fta >= 3 ? 1 : 0) : null;
    return validGoals(g.hg) && validGoals(g.ag) ? (g.hg + g.ag > 0 ? 1 : 0) : null;
  }
  // Partidos con goles del partido completo en hg/ag (para ajustar mercados de 90 minutos).
  function ftGames(games) {
    return (games || []).filter(g => g && validGoals(g.fth) && validGoals(g.fta)).map(g => Object.assign({}, g, { hg: g.fth, ag: g.fta }));
  }

  /* ------------------------------------------------------------------ */
  /* 4. Calibración logística                                            */
  /* ------------------------------------------------------------------ */
  function fitCalibration(rows, opts) {
    const ridge = opts && isNum(opts.ridge) ? opts.ridge : 1;
    const pts = (rows || []).filter(r => r && isNum(r.p) && (r.y === 0 || r.y === 1));
    if (pts.length < 20) return null;
    const xs = pts.map(r => logit(clamp(r.p, 0.01, 0.99)));
    let a = 0, b = 1;
    for (let it = 0; it < 60; it++) {
      let ga = ridge * a, gb = ridge * (b - 1), haa = ridge, hab = 0, hbb = ridge;
      for (let i = 0; i < pts.length; i++) {
        const s = sigmoid(a + b * xs[i]), w = s * (1 - s), e = s - pts[i].y;
        ga += e; gb += e * xs[i];
        haa += w; hab += w * xs[i]; hbb += w * xs[i] * xs[i];
      }
      const det = haa * hbb - hab * hab;
      if (!(Math.abs(det) > 1e-12)) break;
      const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
      a -= da; b -= db;
      if (Math.abs(da) + Math.abs(db) < 1e-9) break;
    }
    return { a, b, n: pts.length };
  }

  function applyCalibration(cal, p) {
    if (!cal || !isNum(cal.a) || !isNum(cal.b) || !isNum(p)) return p;
    return sigmoid(cal.a + cal.b * logit(clamp(p, 0.01, 0.99)));
  }

  /* ------------------------------------------------------------------ */
  /* 5. Métricas y backtest                                              */
  /* ------------------------------------------------------------------ */
  const BANDS = [[0, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.000001]];

  function scoreRows(rows, pick) {
    const get = pick || (r => r.p);
    const list = (rows || []).filter(r => r && isNum(get(r)) && (r.y === 0 || r.y === 1)).slice().sort((x, y) => (x.ts || 0) - (y.ts || 0));
    const n = list.length;
    if (!n) return { count: 0, brier: null, baselineBrier: null, skill: null, skillSe: null, logloss: null, meanP: null, observed: null, calibration: [] };
    let brier = 0, base = 0, ll = 0, sumP = 0, sumY = 0, seen = 0, ones = 0, sumD = 0, sumD2 = 0;
    for (const r of list) {
      const p = clamp(get(r), 1e-6, 1 - 1e-6);
      const b0 = seen >= 10 ? (ones + 0.7 * 10) / (seen + 10) : 0.7; // tasa base previa (sin mirar el futuro)
      const bm = (p - r.y) ** 2, bb = (b0 - r.y) ** 2;
      brier += bm;
      base += bb;
      sumD += bb - bm; sumD2 += (bb - bm) ** 2; // ganancia del modelo sobre la base, partido por partido
      ll += -(r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p));
      sumP += p; sumY += r.y;
      seen++; ones += r.y;
    }
    const calibration = BANDS.map(([lo, hi]) => {
      const xs = list.filter(r => get(r) >= lo && get(r) < hi);
      if (!xs.length) return null;
      return {
        range: `${Math.round(lo * 100)}-${Math.min(100, Math.round(hi * 100))}%`,
        count: xs.length,
        predicted: xs.reduce((s, r) => s + get(r), 0) / xs.length,
        observed: xs.reduce((s, r) => s + r.y, 0) / xs.length
      };
    }).filter(Boolean);
    // Error estándar de la mejora (skill): cuánto podría variar solo por azar con esta cantidad de partidos.
    const meanD = sumD / n, varD = n > 1 ? Math.max(0, (sumD2 - n * meanD * meanD) / (n - 1)) : 0;
    const skillSe = base > 0 ? Math.sqrt(varD / n) / (base / n) : null;
    return {
      count: n, brier: brier / n, baselineBrier: base / n, skill: 1 - brier / base, skillSe,
      logloss: ll / n, meanP: sumP / n, observed: sumY / n, calibration
    };
  }

  // opts.market: 'ht05' (por defecto), 'btts' u 'over25'. Para los dos últimos, games debe venir de ftGames().
  function rollingBacktest(games, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const market = o.market || 'ht05';
    if (market !== 'ht05') o.goals = 'ft';
    const byLeague = new Map();
    for (const g of (games || [])) {
      if (!g || !isNum(g.ts) || g.h == null || g.a == null || !validGoals(g.hg) || !validGoals(g.ag)) continue;
      const key = String(g.leagueId == null ? '0' : g.leagueId);
      if (!byLeague.has(key)) byLeague.set(key, []);
      byLeague.get(key).push(g);
    }
    const rows = [];
    const skipped = { insufficient: 0 };
    for (const [leagueId, list] of byLeague) {
      list.sort((x, y) => x.ts - y.ts);
      let i = 0;
      while (i < list.length) {
        const start = list[i].ts, end = start + o.batchDays * DAY;
        let j = i;
        while (j < list.length && list[j].ts < end) j++;
        const batch = list.slice(i, j).filter(g => g.isTarget !== false);
        if (batch.length) {
          const fm = buildFitMatches(list.slice(0, i), Object.assign({}, o, { cutoffTs: start, currentSeason: batch[0].season }));
          const fit = fitLeague(fm, o);
          for (const g of batch) {
            const pr = predictMatch(fit, g.h, g.a, o);
            if (!pr.ok) { skipped.insufficient++; continue; }
            const y = marketOutcome(g, market), mp = marketProbs(pr, market, o);
            if (y === null) continue;
            rows.push({ id: g.id, ts: g.ts, leagueId, p: mp.p, lam: pr.lambdaTotal, se: pr.seLambda, pLow: mp.pLow, y });
          }
        }
        i = j;
      }
    }
    rows.sort((x, y) => x.ts - y.ts);
    return { rows, skipped, metrics: scoreRows(rows) };
  }

  // Prueba una grilla de parámetros con el mismo backtest y devuelve las configuraciones
  // ordenadas por Brier (menor es mejor). La app elige la mejor con los datos reales.
  function tuneParams(games, grid, base) {
    const g = Object.assign({ halfLifeDays: [120, 240, 500], priorMatches: [8, 14, 25] }, grid || {});
    const results = [];
    for (const halfLifeDays of g.halfLifeDays) {
      for (const priorMatches of g.priorMatches) {
        const cfg = Object.assign({}, base || {}, { halfLifeDays, priorMatches });
        const bt = rollingBacktest(games, cfg);
        if (bt.metrics.count) results.push({ halfLifeDays, priorMatches, count: bt.metrics.count, brier: bt.metrics.brier, skill: bt.metrics.skill });
      }
    }
    results.sort((x, y) => x.brier - y.brier);
    return results;
  }

  // Calibra con las primeras 70% de predicciones (cronológicas) y mide en el 30% final.
  function validateCalibration(rows, opts) {
    const o = Object.assign({ trainFrac: 0.7, minTest: 100, minTotal: 300, minGain: 0.0005 }, opts || {});
    const list = (rows || []).slice().sort((x, y) => x.ts - y.ts);
    const out = { n: list.length, accepted: false, calibration: null, reason: null };
    if (list.length < o.minTotal) {
      out.reason = `Faltan partidos para validar: ${list.length} de ${o.minTotal} necesarios.`;
      return out;
    }
    const cut = Math.floor(list.length * o.trainFrac);
    const train = list.slice(0, cut), test = list.slice(cut);
    out.trainN = train.length; out.testN = test.length;
    const calTrain = fitCalibration(train);
    if (!calTrain || test.length < o.minTest) { out.reason = 'Muestra de prueba insuficiente.'; return out; }
    const raw = scoreRows(test), cal = scoreRows(test, r => applyCalibration(calTrain, r.p));
    out.testBrierRaw = raw.brier; out.testBrierCal = cal.brier; out.testBaseline = raw.baselineBrier;
    out.rawSkill = raw.skill; out.calSkill = cal.skill;
    const finalCal = fitCalibration(list);
    out.calibration = finalCal;
    if (cal.brier < raw.brier - o.minGain) {
      out.accepted = true;
    } else {
      out.reason = 'La calibración no mejora el Brier fuera de muestra; se usa la probabilidad del modelo sin ajustar.';
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 6. Regla de EV                                                      */
  /* ------------------------------------------------------------------ */
  function evDecision(inp) {
    const o = Object.assign({ minEdge: 0.05, maxGap: 0.12, validated: false }, inp || {});
    const reasons = [];
    const odds = Number(o.odds);
    if (!isNum(o.p) || !(odds > 1)) {
      return { signal: 'no_evaluable', label: 'No evaluable', ev: null, evLow: null, reasons: ['Falta una probabilidad válida o una cuota verificada.'] };
    }
    const ev = o.p * odds - 1;
    const evLow = isNum(o.pLow) ? o.pLow * odds - 1 : null;
    const breakEven = 1 / odds;
    let gap = null;
    if (isNum(o.marketProb)) {
      gap = o.p - o.marketProb;
      if (gap > o.maxGap) reasons.push(`El modelo se aleja ${Math.round(gap * 100)} pts de la probabilidad del mercado (límite ${Math.round(o.maxGap * 100)}): suele fallar el modelo, no el mercado.`);
    }
    if (ev < o.minEdge) reasons.push(`Ventaja estimada ${(ev * 100).toFixed(1)}% menor al mínimo ${(o.minEdge * 100).toFixed(0)}%.`);
    let signal = 'sin_ev', label = 'Sin EV';
    if (ev >= o.minEdge && !(gap !== null && gap > o.maxGap)) {
      if (evLow !== null && evLow > 0) { signal = 'ev_solido'; label = 'EV+ sólido'; }
      else { signal = 'ev_posible'; label = 'EV+ posible'; reasons.push('Con la incertidumbre de la muestra, el límite inferior no supera la cuota de equilibrio.'); }
    }
    if ((signal === 'ev_solido' || signal === 'ev_posible') && !o.validated) {
      reasons.push('Modelo aún sin validar fuera de muestra: tomalo como provisorio.');
    }
    return { signal, label, ev, evLow, breakEven, gap, validated: !!o.validated, reasons };
  }

  // Stake sugerido por Kelly fraccional, como parte de la banca (0,02 = 2%).
  // Kelly completo = (p·(cuota−1) − (1−p)) / (cuota−1): la parte de la banca que maximiza el
  // crecimiento SI p fuera exacta. Como p es una estimación, se usa con cuidado:
  //  - liga aprobada: p = promedio entre el modelo y el mercado sin margen (o el modelo si no hay mercado);
  //  - liga sin aprobar: el modelo todavía no demostró nada, así que p = SOLO el mercado sin margen
  //    (sin mercado, no se apuesta);
  //  - se apuesta solo una fracción (¼ por defecto; ⅛ si la liga no está aprobada);
  //  - nunca más del tope (3% por defecto).
  function kellyStake(inp) {
    const o = Object.assign({ fraction: 0.25, cap: 0.03, validated: true }, inp || {});
    const odds = Number(o.odds);
    if (!isNum(o.p) || !(odds > 1)) return { ok: false, stake: 0, reason: 'Falta una probabilidad válida o una cuota.' };
    const b = odds - 1;
    const hasMkt = isNum(o.marketProb);
    const fraction = o.validated ? o.fraction : o.fraction / 2;
    const source = o.validated ? (hasMkt ? 'mezcla' : 'modelo') : 'mercado';
    if (!o.validated && !hasMkt) return { ok: true, stake: 0, full: null, pUsed: null, fraction, source, capped: false, reason: 'Liga sin aprobar y sin precio del mercado: no apostar.' };
    const pUsed = clamp(source === 'mezcla' ? (o.p + o.marketProb) / 2 : source === 'mercado' ? o.marketProb : o.p, 0, 1);
    const full = (pUsed * b - (1 - pUsed)) / b;
    if (!(full > 0)) return { ok: true, stake: 0, full, pUsed, fraction, source, capped: false, reason: 'Sin ventaja con la probabilidad usada: Kelly dice no apostar.' };
    const raw = full * fraction;
    const capped = raw > o.cap;
    return { ok: true, stake: capped ? o.cap : raw, full, pUsed, fraction, source, capped, reason: null };
  }

  /* ------------------------------------------------------------------ */
  /* 7. En vivo                                                          */
  /* ------------------------------------------------------------------ */
  // Reparto por defecto de los goles del 1T en tramos de 15' (incluye adición). Es un supuesto.
  const DEFAULT_CURVE = [0.30, 0.33, 0.37];

  function elapsedShare(minute, curve) {
    const c = curve || DEFAULT_CURVE;
    const m = clamp(Number(minute) || 0, 0, 45);
    const seg = 15;
    let acc = 0;
    for (let i = 0; i < c.length; i++) {
      const lo = i * seg, hi = lo + seg;
      if (m >= hi) acc += c[i];
      else { acc += c[i] * (m - lo) / seg; break; }
    }
    return clamp(acc, 0, 1);
  }

  function liveRemainingLambda(inp) {
    const o = Object.assign({ tempoPrior: 10, minShare: 0.03 }, inp || {});
    const lam = Number(o.lambdaTotalHT);
    if (!(lam > 0)) return { ok: false, reason: 'Falta el λ prepartido del partido.' };
    const share = elapsedShare(o.minute, o.curve);
    const lamElapsed = lam * share;
    const g = Math.max(0, Number(o.goalsNow) || 0);
    // El ritmo observado actualiza el prior del partido (Gamma-Poisson), con efecto moderado.
    const tempo = clamp((o.tempoPrior + g) / (o.tempoPrior + lamElapsed), 0.6, 1.6);
    const remShare = Math.max(o.minShare, 1 - share);
    return { ok: true, lambdaRemaining: lam * remShare * tempo, elapsedShare: share, tempo };
  }

  function liveMarket(inp) {
    const { lambdaRemaining, goalsNow, line, odds } = inp || {};
    const L = Number(line), g = Number(goalsNow) || 0;
    if (!(lambdaRemaining >= 0) || !isNum(L)) return { ok: false };
    let win = 0, push = 0, lose = 0, mass = 0;
    for (let x = 0; x <= 25; x++) {
      const pr = poissonPmf(x, lambdaRemaining), total = g + x;
      mass += pr;
      if (total > L) win += pr; else if (total === L) push += pr; else lose += pr;
    }
    win += Math.max(0, 1 - mass);
    const price = Number(odds);
    const out = { ok: true, pWin: win, pPush: push, pLose: lose, fairOdds: win > 0 ? 1 + lose / win : null };
    if (price > 1) { out.ev = win * (price - 1) - lose; out.breakEvenOdds = out.fairOdds; }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Compatibilidad con la versión anterior                              */
  /* ------------------------------------------------------------------ */
  function average(values) {
    const xs = values.filter(validGoals);
    return xs.length ? xs.reduce((s, n) => s + n, 0) / xs.length : null;
  }
  function summarizeTeam(history, priorMean, priorMatches) {
    const pm = priorMatches == null ? 8 : priorMatches;
    if (!Array.isArray(history) || !validGoals(priorMean) || pm < 0) return null;
    const usable = history.filter(g => g && validGoals(g.scoredHT) && validGoals(g.concededHT));
    if (!usable.length) return null;
    const scored = average(usable.map(g => g.scoredHT)), conceded = average(usable.map(g => g.concededHT));
    const weight = usable.length / (usable.length + pm);
    return {
      matches: usable.length, scoredHT: scored, concededHT: conceded,
      adjustedScoredHT: weight * scored + (1 - weight) * priorMean,
      adjustedConcededHT: weight * conceded + (1 - weight) * priorMean,
      shrinkageWeight: weight
    };
  }
  // DEPRECADO: promedio simple sin ajuste por rival. Se conserva solo por compatibilidad.
  function calculate(input) {
    if (!input || !Array.isArray(input.homeHistory) || !Array.isArray(input.awayHistory)) return { ok: false, reason: 'Faltan historiales válidos de ambos equipos.' };
    const lh = input.leagueHomeGoalsHT, la = input.leagueAwayGoalsHT;
    if (!validGoals(lh) || !validGoals(la) || lh <= 0 || la <= 0) return { ok: false, reason: 'Faltan promedios fiables de goles HT de la liga.' };
    const pm = Number.isFinite(input.priorMatches) ? clamp(input.priorMatches, 0, 30) : 8;
    const home = summarizeTeam(input.homeHistory, lh, pm), away = summarizeTeam(input.awayHistory, la, pm);
    if (!home || !away) return { ok: false, reason: 'No hay muestra HT suficiente para ambos equipos.' };
    const lamH = lh * (home.adjustedScoredHT / lh) * (away.adjustedConcededHT / lh);
    const lamA = la * (away.adjustedScoredHT / la) * (home.adjustedConcededHT / la);
    const lam = lamH + lamA, p = 1 - Math.exp(-lam);
    const marketOdds = Number(input.marketOdds), hasOdds = Number.isFinite(marketOdds) && marketOdds > 1;
    const ev = hasOdds ? p * marketOdds - 1 : null;
    return {
      ok: true, market: 'Over 0,5 goles 1T', method: 'Poisson simple (deprecado)',
      sample: { homeMatches: home.matches, awayMatches: away.matches },
      lambdas: { homeHT: round(lamH, 4), awayHT: round(lamA, 4), totalHT: round(lam, 4) },
      probability: round(p, 6), probabilityPercent: round(p * 100, 2), fairOdds: round(1 / p, 3),
      marketOdds: hasOdds ? marketOdds : null, ev: hasOdds ? round(ev, 6) : null, evPercent: hasOdds ? round(ev * 100, 2) : null,
      status: hasOdds ? (ev > 0 ? 'EV positivo estimado' : 'Sin EV positivo estimado') : 'Cuota de mercado no disponible',
      warning: 'Estimación inicial no calibrada.', diagnostics: { home, away }
    };
  }

  const api = {
    DEFAULTS, buildFitMatches, fitLeague, predictMatch, fitCalibration, applyCalibration,
    scoreRows, rollingBacktest, tuneParams, validateCalibration, evDecision, kellyStake,
    MARKETS, marketProbs, marketOutcome, ftGames,
    liveRemainingLambda, liveMarket, elapsedShare, poissonPmf,
    calculate, summarizeTeam, DEFAULT_PRIOR_MATCHES: 8
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TanoPoissonModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
