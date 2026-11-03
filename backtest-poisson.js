/**
 * TANOapp — backtest cronológico del Poisson de Over 0,5 goles 1T para datasets exportados.
 *
 * Usa EXACTAMENTE el mismo pipeline que la app (modelo-poisson.js → rollingBacktest):
 * ajuste de la liga completa, solo partidos anteriores, mismo torneo, goles al descanso.
 * No hace llamadas a API.
 *
 * Entrada: partidos finalizados con fixtureId, date ISO, leagueId, season, homeTeamId,
 * awayTeamId, homeHT, awayHT y opcional oddsOver05HT (cuota real capturada ANTES del inicio).
 *
 * Uso por consola:  node backtest-poisson.js partidos.json
 */
'use strict';
const model = require('./modelo-poisson.js');

const validGoals = n => Number.isInteger(n) && n >= 0;
const dateMs = m => Date.parse(m.date);

function validMatch(m) {
  return m && m.fixtureId != null && Number.isFinite(dateMs(m)) &&
    m.leagueId != null && m.season != null &&
    m.homeTeamId != null && m.awayTeamId != null &&
    validGoals(m.homeHT) && validGoals(m.awayHT);
}

function uniqueChronological(matches) {
  const seen = new Set();
  return (Array.isArray(matches) ? matches : [])
    .filter(validMatch)
    .filter(m => {
      const id = String(m.fixtureId);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => dateMs(a) - dateMs(b));
}

// rows: [{probability, outcome (0/1), odds|null}]
function scorePredictions(rows) {
  const base = model.scoreRows((rows || []).map((r, i) => ({ ts: i, p: r.probability, y: r.outcome })));
  const priced = (rows || []).filter(r => Number.isFinite(r.odds) && r.odds > 1);
  const profitUnits = priced.reduce((s, r) => s + (r.outcome === 1 ? r.odds - 1 : -1), 0);
  return {
    count: base.count,
    brierScore: base.brier,
    baselineBrier: base.baselineBrier,
    skill: base.skill,
    calibration: base.calibration,
    oddsCount: priced.length,
    profitUnits: priced.length ? profitUnits : null,
    roi: priced.length ? profitUnits / priced.length : null
  };
}

function runBacktest(matches, options) {
  const opts = Object.assign({}, options || {});
  if (opts.minLeagueMatches != null && opts.minFitMatches == null) opts.minFitMatches = opts.minLeagueMatches;
  const ordered = uniqueChronological(matches);
  const oddsById = new Map();
  const games = ordered.map(m => {
    if (Number.isFinite(m.oddsOver05HT) && m.oddsOver05HT > 1) oddsById.set(String(m.fixtureId), m.oddsOver05HT);
    return {
      id: m.fixtureId, ts: dateMs(m) / 1000, h: m.homeTeamId, a: m.awayTeamId,
      hg: m.homeHT, ag: m.awayHT, season: m.season, leagueId: m.leagueId
    };
  });
  const bt = model.rollingBacktest(games, opts);
  const predictions = bt.rows.map(r => ({
    fixtureId: r.id, ts: r.ts, leagueId: r.leagueId, probability: r.p, outcome: r.y,
    odds: oddsById.get(String(r.id)) || null
  }));
  return {
    method: 'rolling-origin: solo partidos anteriores; misma liga; goles al descanso; ajuste de liga completo',
    scored: predictions.length,
    skipped: {
      invalidOrDuplicate: (Array.isArray(matches) ? matches.length : 0) - ordered.length,
      insufficientHistory: bt.skipped.insufficient
    },
    metrics: scorePredictions(predictions),
    predictions
  };
}

module.exports = { runBacktest, scorePredictions, uniqueChronological };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('Uso: node backtest-poisson.js partidos.json'); process.exit(1); }
  const data = JSON.parse(require('fs').readFileSync(file, 'utf8'));
  const res = runBacktest(data);
  console.log(JSON.stringify({ scored: res.scored, skipped: res.skipped, metrics: res.metrics }, null, 2));
}
