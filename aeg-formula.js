/**
 * TANOapp — Estrategia AEG (Over 0,5 1T), cálculo estilo BetPractice.
 *
 * Parte pura (sin navegador), probada con Node en tests/aeg-formula.test.js.
 *
 * Hipótesis principal (sale de los tres ejemplos de la clase):
 *   cuota real = 1 / (partidos con gol en el 1T / partidos de la muestra)
 *   Rangers 105/131 → 1,25 · candidato 75/88 → 1,17 · River 8/9 → 1,13.
 *   Y las temporadas se suman partido a partido: 18/22 + 56/65 = 74/87.
 *
 * Como no se sabe qué partidos entran en la muestra de BetPractice, cada «variante»
 * combina cuatro decisiones y la calibración con el historial VIP AEG elige la que
 * mejor reproduce los picks:
 *   scope   'all'    todas las competiciones del equipo · 'league' solo la liga del partido
 *   seasons 'cp'     temporada actual + anterior          · 'c' solo la actual
 *   venue   'both'   local y visitante (Home as Both)      · 'split' local en casa, visitante fuera
 *   pool    'pooled' suma de los dos equipos (Versus)      · 'avg' promedio de los dos % · 'min' el peor de los dos
 *
 * Partido comprimido (formato de compact() en index-v2.html):
 *   { i:id, d:timestamp en segundos, h:id local, a:id visitante, fh:goles 1T, fs:[l,v], s:temporada, l:liga }
 * Partido a evaluar: { id, iso, lid, season, hid, aid }
 */
(function (root) {
  'use strict';

  const SCOPES = { all: 'Todas las competiciones', league: 'Solo la liga del partido' };
  const SEASONS = { cp: 'Temporada actual + anterior', c: 'Solo temporada actual' };
  const VENUES = { both: 'Local y visitante (Both)', split: 'Local en casa / visitante fuera' };
  const POOLS = { pooled: 'Suma de los dos equipos', avg: 'Promedio de los dos %', min: 'El peor de los dos %' };

  const VARIANTS = [];
  for (const pool of Object.keys(POOLS))
    for (const scope of Object.keys(SCOPES))
      for (const seasons of Object.keys(SEASONS))
        for (const venue of Object.keys(VENUES))
          VARIANTS.push({ id: [pool, scope, seasons, venue].join('|'), pool, scope, seasons, venue });
  const DEFAULT_VARIANT = 'pooled|all|cp|both';

  // Reglas de la clase. Los conjuntos crecen de a una regla para ver cuál aporta.
  const DEFAULT_RULES = { maxFair: 1.25, minFair: 1.0, minSample: 30, avgHigh: 3.0, avgLow: 2.8, overStreak: 8, underMin: 2, underMax: 3, minEv: 0,
    seasonTol: 0.01, seasonMinN: 10, breakMin: 0.75, strongSample: 40 };
  const RULE_SETS = {
    core: { label: 'Cuota real + muestra', avg: false, streak: false, ev: false },
    avg: { label: 'Cuota real + muestra + promedios', avg: true, streak: false, ev: false },
    full: { label: 'Cuota real + muestra + promedios + rachas', avg: true, streak: true, ev: false },
    coreEv: { label: 'Cuota real + muestra + EV', avg: false, streak: false, ev: true },
    avgEv: { label: 'Cuota real + muestra + promedios + EV', avg: true, streak: false, ev: true },
    fullEv: { label: 'Cuota real + muestra + promedios + rachas + EV', avg: true, streak: true, ev: true },
    // Todas las reglas de la clase, sin saltear ninguna (ver evaluate).
    video: { label: 'Como la clase (todas las reglas)', video: true, ev: false },
    videoEv: { label: 'Como la clase (todas las reglas) + EV', video: true, ev: true }
  };
  const BASE_SETS = ['core', 'avg', 'full', 'video'], EV_SETS = ['coreEv', 'avgEv', 'fullEv', 'videoEv'];
  const MIN_FAIRS = [1.0, 1.10];
  const QUOTES = { best: 'mejor cuota entre casas', median: 'cuota mediana de las casas' };
  const DEFAULT_THRESHOLDS = [1.25, 1.30, 1.35, 1.40];

  function variantById(id) { return VARIANTS.find(v => v.id === id) || VARIANTS.find(v => v.id === DEFAULT_VARIANT); }
  function variantLabel(v) {
    v = typeof v === 'string' ? variantById(v) : v;
    return POOLS[v.pool] + ' · ' + SCOPES[v.scope] + ' · ' + SEASONS[v.seasons] + ' · ' + VENUES[v.venue];
  }

  const hasHt = g => Number.isInteger(g.fh) && g.fh >= 0;
  const hasFt = g => Array.isArray(g.fs) && g.fs.length === 2 && g.fs.every(Number.isInteger);

  /** Partidos de un equipo que entran en la muestra, del más reciente al más viejo. */
  function teamSample(games, fx, side, variant) {
    const teamId = side === 'home' ? fx.hid : fx.aid;
    const cutoff = Math.floor(new Date(fx.iso).getTime() / 1000);
    const cur = Number(fx.season);
    const allowed = variant.seasons === 'c' ? [cur] : [cur, cur - 1];
    return (games || []).filter(g => {
      if (g.i === fx.id || !(g.d < cutoff)) return false;
      if (!allowed.includes(Number(g.s))) return false;
      if (variant.scope === 'league' && Number(g.l) !== Number(fx.lid)) return false;
      if (variant.venue === 'split') return side === 'home' ? g.h === teamId : g.a === teamId;
      return g.h === teamId || g.a === teamId || (g.h == null && g.a == null);
    }).sort((x, y) => y.d - x.d);
  }

  /** Muestra, aciertos, %, promedio de goles totales y rachas actuales de un equipo. */
  function teamStats(sample, season) {
    const ht = sample.filter(hasHt), ft = sample.filter(hasFt);
    const hits = ht.filter(g => g.fh >= 1).length;
    const bySeason = s => { const x = ht.filter(g => Number(g.s) === s), h = x.filter(g => g.fh >= 1).length; return { n: x.length, hits: h, rate: x.length ? h / x.length : null }; };
    const streak = target => { let n = 0; for (const g of ht) { if ((g.fh >= 1) === target) n++; else break; } return n; };
    // Revisión manual de la clase: en el historial, ¿las rachas de 2 (o 3) sin gol se cortaron en el partido siguiente?
    const underPattern = { b2: 0, e2: 0, b3: 0, e3: 0 };
    let run = 0;
    for (const g of ht.slice().reverse()) {
      if (g.fh >= 1) {
        if (run === 2) underPattern.b2++; else if (run > 2) underPattern.e2++;
        if (run === 3) underPattern.b3++; else if (run > 3) underPattern.e3++;
        run = 0;
      } else run++;
    }
    return {
      underPattern,
      n: ht.length, hits, rate: ht.length ? hits / ht.length : null,
      avg: ft.length ? ft.reduce((t, g) => t + g.fs[0] + g.fs[1], 0) / ft.length : null,
      over: streak(true), under: streak(false),
      current: bySeason(Number(season)), previous: bySeason(Number(season) - 1)
    };
  }

  /** Números del partido para una variante (lo que mostraría BetPractice). */
  function matchStats(gamesHome, gamesAway, fx, variant) {
    variant = typeof variant === 'string' ? variantById(variant) : variant;
    const sampleA = teamSample(gamesHome, fx, 'home', variant), sampleB = teamSample(gamesAway, fx, 'away', variant);
    const a = teamStats(sampleA, fx.season), b = teamStats(sampleB, fx.season);
    const n = a.n + b.n, hits = a.hits + b.hits;
    let rate = null;
    if (a.rate !== null && b.rate !== null) {
      if (variant.pool === 'pooled') rate = n ? hits / n : null;
      else if (variant.pool === 'avg') rate = (a.rate + b.rate) / 2;
      else rate = Math.min(a.rate, b.rate);
    }
    const fair = rate ? 1 / rate : null;
    const season = k => { const x = { n: a[k].n + b[k].n, hits: a[k].hits + b[k].hits }; x.rate = x.n ? x.hits / x.n : null; return x; };
    return { a, b, n, hits, rate, fair, current: season('current'), previous: season('previous'), variant: variant.id, sampleA, sampleB };
  }

  /** Aplica las reglas. Devuelve si pasa y, si no, qué reglas fallaron (en orden de la clase).
   *  quote: cuota de la casa (solo la usan los juegos de reglas con EV). */
  function evaluate(ms, ruleSet, rules, quote) {
    const set = RULE_SETS[ruleSet] || RULE_SETS.full;
    const r = { ...DEFAULT_RULES, ...(rules || {}) };
    if (set.video) return evaluateVideo(ms, set, r, quote);
    const fails = [];
    if (!(ms.n >= r.minSample) || !(ms.a.n > 0) || !(ms.b.n > 0)) fails.push('muestra');
    if (!(ms.fair !== null && ms.fair <= r.maxFair + 1e-9)) fails.push('cuota real');
    if (set.avg) {
      const hi = Math.max(ms.a.avg ?? -1, ms.b.avg ?? -1), lo = Math.min(ms.a.avg ?? -1, ms.b.avg ?? -1);
      if (!(hi >= r.avgHigh && lo >= r.avgLow)) fails.push('promedios');
    }
    let streakVia = null;
    if (set.streak) {
      const maxUnder = Math.max(ms.a.under, ms.b.under);
      const overOk = Math.max(ms.a.over, ms.b.over) >= r.overStreak || ms.a.over + ms.b.over >= r.overStreak;
      if (maxUnder > r.underMax) fails.push('racha Under larga');
      else if (overOk) streakVia = 'over';
      else if (maxUnder >= r.underMin) streakVia = 'under';
      else fails.push('rachas');
    }
    return finishEv({ fails, streakVia }, ms, set, r, quote);
  }

  function finishEv(res, ms, set, r, quote) {
    let ev = null;
    if (quote > 1 && ms.fair) ev = quote / ms.fair - 1;
    if (set.ev) {
      if (ev === null) res.fails.push('sin cuota');
      else if (ev < r.minEv - 1e-9) res.fails.push('EV');
    }
    return { pass: res.fails.length === 0, fails: res.fails, streakVia: res.streakVia, ev, notes: res.notes || [] };
  }

  /**
   * Reglas de la clase, todas (documento «Análisis método Over 0,5 HT – Clase 2»):
   *  1. Muestra ≥ 30 partidos (los dos equipos, como en Versus); 3/3 o 9 partidos no alcanzan.
   *  2. Cuota real dentro del rango: ≤ máximo (1,25 = 80%) y ≥ mínimo (el rango de ejemplo arranca en 1,10).
   *  3. % de gol en el 1T ≈ 80% o más en la temporada actual, en la anterior y en las dos juntas
   *     (con la tolerancia del ejemplo de Rangers: 79,1%). Una temporada con muy pocos partidos no cuenta.
   *  4. Racha que apoye: Over de 8–10+ en un equipo o sumando los dos; si no, Under de 2 (o 3) que en el
   *     historial casi siempre se cortó en el partido siguiente. Under de 4 o más: afuera.
   *  5. Promedios: uno ≥ 3,0 y el otro ≥ 2,8. Si son bajos, se descarta solo si además no hay racha
   *     convincente ni buena muestra.
   *  6. EV positivo (o neutro) si el juego de reglas lo pide.
   */
  function evaluateVideo(ms, set, r, quote) {
    const fails = [], notes = [];
    const minRate = 1 / r.maxFair - r.seasonTol;
    if (!(ms.n >= r.minSample) || !(ms.a.n > 0) || !(ms.b.n > 0)) fails.push('muestra');
    if (!(ms.fair !== null && ms.fair <= r.maxFair + 1e-9)) fails.push('cuota real');
    else if (ms.fair < r.minFair - 1e-9) fails.push('cuota real baja');
    for (const [k, name] of [['current', 'temporada actual'], ['previous', 'temporada anterior']]) {
      const x = ms[k];
      if (x && x.n >= r.seasonMinN && x.rate < minRate) fails.push(name);
      else if (x && x.n > 0 && x.n < r.seasonMinN) notes.push(name + ' con pocos partidos (' + x.hits + '/' + x.n + '): no cuenta');
    }
    const maxUnder = Math.max(ms.a.under, ms.b.under);
    const overStrong = Math.max(ms.a.over, ms.b.over) >= r.overStreak || ms.a.over + ms.b.over >= r.overStreak;
    let streakVia = null;
    if (maxUnder > r.underMax) fails.push('racha Under larga');
    else if (overStrong) streakVia = 'over';
    else if (maxUnder >= r.underMin) {
      // Para cada equipo en racha Under: ¿en su historial esa racha se cortó en el partido siguiente?
      let ok = true;
      for (const t of [ms.a, ms.b]) {
        if (t.under < r.underMin) continue;
        const p = t.underPattern || {}, broke = t.under === 2 ? p.b2 : p.b3, cont = t.under === 2 ? p.e2 : p.e3;
        const cases = (broke || 0) + (cont || 0);
        if (!cases) notes.push('racha Under de ' + t.under + ' sin antecedentes en la muestra');
        else if (broke / cases < r.breakMin) ok = false;
        else notes.push('racha Under de ' + t.under + ': se cortó ' + broke + ' de ' + cases + ' veces');
      }
      if (ok) streakVia = 'under'; else fails.push('racha Under que suele seguir');
    } else fails.push('rachas');
    const hi = Math.max(ms.a.avg ?? -1, ms.b.avg ?? -1), lo = Math.min(ms.a.avg ?? -1, ms.b.avg ?? -1);
    const avgOk = hi >= r.avgHigh && lo >= r.avgLow;
    if (!avgOk) {
      if (overStrong && ms.n >= r.strongSample) notes.push('promedios bajos, compensados por racha y muestra');
      else fails.push('promedios');
    }
    return finishEv({ fails, streakVia, notes }, ms, set, r, quote);
  }

  // Órdenes de la lista diaria. Cada uno recibe { ms, ev } y devuelve un número: menor = más arriba.
  const SORTS = {
    ev: { label: 'mayor EV', key: c => -(c.ev ?? -9) * 1000 + (c.ms.fair || 9) },
    fair: { label: 'menor cuota real', key: c => (c.ms.fair || 9) * 1000 - (c.ev ?? -9) },
    sample: { label: 'muestra más grande', key: c => -c.ms.n * 1000 + (c.ms.fair || 9) },
    streak: { label: 'racha Over más larga', key: c => -(c.ms.a.over + c.ms.b.over) * 1000 + (c.ms.fair || 9) }
  };
  const MIN_EVS = [0, -0.03, -0.05];

  /** Ordena candidatos ({ ms, ev, ... }) según un orden de SORTS. */
  function sortCandidates(list, sort) {
    const k = (SORTS[sort] || SORTS.fair).key;
    return list.slice().sort((x, y) => k(x) - k(y));
  }

  /**
   * Calibración. picks: Set de ids (string) de los partidos VIP AEG.
   * days: [{ date, fixtures:[fx...] }] con TODOS los partidos de esas fechas en las ligas de los picks.
   * histories: Map(teamId → partidos comprimidos).
   * opts.thresholds: cuotas reales máximas. opts.ruleSets: juegos de reglas.
   * opts.odds: Map(id → { best, median }); opts.quotes: ['best','median'] para las reglas con EV.
   * opts.minEvs: EV mínimos a probar (con tolerancia negativa). opts.sorts: órdenes de la lista.
   * Además de cuántos picks pasan, mide en qué puesto quedan: «topK» = picks que quedan entre los
   * primeros K del día, con K = cantidad de picks de ese día; «top10» = entre los primeros 10.
   */
  function calibrate(picks, days, histories, rules, opts) {
    opts = opts || {};
    const variants = opts.variants || VARIANTS;
    const ruleSets = opts.ruleSets || BASE_SETS;
    const thresholds = opts.thresholds || [((rules && rules.maxFair) || DEFAULT_RULES.maxFair)];
    const sorts = opts.sorts || ['fair'];
    const odds = opts.odds || new Map();
    const combos = [];
    for (const rs of ruleSets) for (const t of thresholds) {
      const isEv = RULE_SETS[rs].ev;
      for (const q of (isEv ? (opts.quotes || ['best']) : [null]))
        for (const me of (isEv ? (opts.minEvs || [0]) : [null]))
          for (const mf of (RULE_SETS[rs].video ? (opts.minFairs || [DEFAULT_RULES.minFair]) : [null]))
            for (const so of sorts) combos.push({ rs, t, q, me, mf, so });
    }
    const rows = [];
    for (const v of variants) for (const c of combos) rows.push({ variant: v.id, ruleSet: c.rs, maxFair: c.t, quote: c.q, minEv: c.me, minFair: c.mf, sort: c.so, found: 0, picks: 0, candidates: 0, days: 0, topK: 0, top10: 0, missed: [] });
    for (const day of days) {
      const usable = day.fixtures.filter(fx => histories.has(fx.hid) && histories.has(fx.aid));
      if (!usable.length) continue;
      const dayPicks = usable.filter(fx => picks.has(String(fx.id))).length;
      let k = 0;
      for (const v of variants) {
        const stats = usable.map(fx => matchStats(histories.get(fx.hid), histories.get(fx.aid), fx, v));
        for (const c of combos) {
          const row = rows[k++], r = { ...(rules || {}), maxFair: c.t, minEv: c.me ?? 0, ...(c.mf != null ? { minFair: c.mf } : {}) };
          row.days++;
          const passing = [];
          usable.forEach((fx, i) => {
            const o = odds.get(String(fx.id)), quote = o ? o[c.q || 'best'] : null;
            const ev = evaluate(stats[i], c.rs, r, quote);
            const isPick = picks.has(String(fx.id));
            if (ev.pass) passing.push({ fx, ms: stats[i], ev: ev.ev, isPick });
            if (isPick) { row.picks++; if (ev.pass) row.found++; else row.missed.push(fx.id); }
          });
          row.candidates += passing.length;
          sortCandidates(passing, c.so).forEach((x, pos) => {
            if (!x.isPick) return;
            if (pos < dayPicks) row.topK++;
            if (pos < 10) row.top10++;
          });
        }
      }
    }
    for (const row of rows) {
      row.recall = row.picks ? row.found / row.picks : 0;
      row.recallK = row.picks ? row.topK / row.picks : 0;
      row.recall10 = row.picks ? row.top10 / row.picks : 0;
      row.perDay = row.days ? row.candidates / row.days : 0;
      row.precision = row.candidates ? row.found / row.candidates : 0;
    }
    rows.sort((x, y) => y.recallK - x.recallK || y.recall10 - x.recall10 || y.recall - x.recall || x.perDay - y.perDay);
    return rows;
  }

  /** Probabilidad justa de gol en lo que queda del 1T con 0-0 (Poisson de ritmo parejo). */
  function liveFair(pPre, minute) {
    if (!(pPre > 0 && pPre < 1) || !(minute >= 0 && minute < 45)) return null;
    const lam = -Math.log(1 - pPre) * (45 - minute) / 45;
    const p = 1 - Math.exp(-lam);
    return { p, odd: 1 / p };
  }

  const api = { MIN_FAIRS, SORTS, MIN_EVS, sortCandidates, VARIANTS, DEFAULT_VARIANT, DEFAULT_RULES, RULE_SETS, BASE_SETS, EV_SETS, QUOTES, DEFAULT_THRESHOLDS, SCOPES, SEASONS, VENUES, POOLS, variantById, variantLabel, teamSample, teamStats, matchStats, evaluate, calibrate, liveFair };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TanoAeg = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
