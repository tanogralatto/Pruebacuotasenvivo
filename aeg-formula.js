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
  const DEFAULT_RULES = { maxFair: 1.25, minSample: 30, avgHigh: 3.0, avgLow: 2.8, overStreak: 8, underMin: 2, underMax: 3 };
  const RULE_SETS = {
    core: { label: 'Cuota real + muestra', avg: false, streak: false },
    avg: { label: 'Cuota real + muestra + promedios', avg: true, streak: false },
    full: { label: 'Cuota real + muestra + promedios + rachas', avg: true, streak: true }
  };

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
    return {
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

  /** Aplica las reglas. Devuelve si pasa y, si no, qué regla falló primero (en orden de la clase). */
  function evaluate(ms, ruleSet, rules) {
    const set = RULE_SETS[ruleSet] || RULE_SETS.full;
    const r = { ...DEFAULT_RULES, ...(rules || {}) };
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
    return { pass: fails.length === 0, fails, streakVia };
  }

  /**
   * Calibración. picks: Set de ids (string) de los partidos VIP AEG.
   * days: [{ date, fixtures:[fx...] }] con TODOS los partidos de esas fechas en las ligas de los picks.
   * histories: Map(teamId → partidos comprimidos).
   * Devuelve una fila por variante × conjunto de reglas, ordenadas por picks encontrados
   * y, a igualdad, por menos candidatos por día.
   */
  function calibrate(picks, days, histories, rules, opts) {
    const variants = (opts && opts.variants) || VARIANTS;
    const ruleSets = (opts && opts.ruleSets) || Object.keys(RULE_SETS);
    const rows = [];
    for (const v of variants) for (const rs of ruleSets) rows.push({ variant: v.id, ruleSet: rs, found: 0, picks: 0, candidates: 0, days: 0, missed: [] });
    for (const day of days) {
      const usable = day.fixtures.filter(fx => histories.has(fx.hid) && histories.has(fx.aid));
      if (!usable.length) continue;
      const stats = new Map();
      let k = 0;
      for (const v of variants) {
        for (const fx of usable) stats.set(fx.id, matchStats(histories.get(fx.hid), histories.get(fx.aid), fx, v));
        for (const rs of ruleSets) {
          const row = rows[k++];
          row.days++;
          for (const fx of usable) {
            const ok = evaluate(stats.get(fx.id), rs, rules).pass;
            if (ok) row.candidates++;
            if (picks.has(String(fx.id))) { row.picks++; if (ok) row.found++; else row.missed.push(fx.id); }
          }
        }
      }
    }
    for (const row of rows) {
      row.recall = row.picks ? row.found / row.picks : 0;
      row.perDay = row.days ? row.candidates / row.days : 0;
      row.precision = row.candidates ? row.found / row.candidates : 0;
    }
    rows.sort((x, y) => y.recall - x.recall || x.perDay - y.perDay);
    return rows;
  }

  /** Probabilidad justa de gol en lo que queda del 1T con 0-0 (Poisson de ritmo parejo). */
  function liveFair(pPre, minute) {
    if (!(pPre > 0 && pPre < 1) || !(minute >= 0 && minute < 45)) return null;
    const lam = -Math.log(1 - pPre) * (45 - minute) / 45;
    const p = 1 - Math.exp(-lam);
    return { p, odd: 1 / p };
  }

  const api = { VARIANTS, DEFAULT_VARIANT, DEFAULT_RULES, RULE_SETS, SCOPES, SEASONS, VENUES, POOLS, variantById, variantLabel, teamSample, teamStats, matchStats, evaluate, calibrate, liveFair };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TanoAeg = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
