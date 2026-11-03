/**
 * TANOapp — backtest cronológico del Poisson de Over 0,5 goles 1T.
 * Entrada: partidos finalizados con fixtureId, date ISO, leagueId, season,
 * homeTeamId, awayTeamId, homeHT, awayHT y opcional oddsOver05HT.
 * Solo usa partidos anteriores al evaluado. No hace llamadas a API.
 */
'use strict';
const poisson = require('./modelo-poisson.js');

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

function buildPrediction(match, history, options = {}) {
  const leagueMatches = history.filter(m =>
    String(m.leagueId) === String(match.leagueId) &&
    String(m.season) === String(match.season) &&
    dateMs(m) < dateMs(match));
  if (leagueMatches.length < (options.minLeagueMatches || 20)) return null;

  const homeHistory = history.filter(m => dateMs(m) < dateMs(match) &&
    String(m.leagueId) === String(match.leagueId) &&
    String(m.season) === String(match.season) &&
    (String(m.homeTeamId) === String(match.homeTeamId) ||
     String(m.awayTeamId) === String(match.homeTeamId)))
    .map(m => String(m.homeTeamId) === String(match.homeTeamId)
      ? {scoredHT:m.homeHT, concededHT:m.awayHT}
      : {scoredHT:m.awayHT, concededHT:m.homeHT})
    .slice(-20);
  const awayHistory = history.filter(m => dateMs(m) < dateMs(match) &&
    String(m.leagueId) === String(match.leagueId) &&
    String(m.season) === String(match.season) &&
    (String(m.homeTeamId) === String(match.awayTeamId) ||
     String(m.awayTeamId) === String(match.awayTeamId)))
    .map(m => String(m.homeTeamId) === String(match.awayTeamId)
      ? {scoredHT:m.homeHT, concededHT:m.awayHT}
      : {scoredHT:m.awayHT, concededHT:m.homeHT})
    .slice(-20);
  if (homeHistory.length < (options.minTeamMatches || 5) ||
      awayHistory.length < (options.minTeamMatches || 5)) return null;

  const leagueHome = leagueMatches.reduce((s,m)=>s+m.homeHT,0)/leagueMatches.length;
  const leagueAway = leagueMatches.reduce((s,m)=>s+m.awayHT,0)/leagueMatches.length;
  const result = poisson.calculate({
    homeHistory, awayHistory,
    leagueHomeGoalsHT: leagueHome,
    leagueAwayGoalsHT: leagueAway,
    marketOdds: match.oddsOver05HT
  });
  return result.ok ? result : null;
}

function scorePredictions(rows) {
  const n = rows.length;
  if (!n) return {count:0, brierScore:null, accuracy:null, calibration:[], oddsCount:0, roi:null, profitUnits:null};
  const brier = rows.reduce((s,r)=>s+(r.probability-r.outcome)**2,0)/n;
  const accuracy = rows.filter(r=>(r.probability>=0.5) === (r.outcome===1)).length/n;
  const bands = [{min:0,max:.5},{min:.5,max:.6},{min:.6,max:.7},{min:.8,max:.9},{min:.9,max:1.000001}];
  const calibration = bands.map(b => {
    const xs = rows.filter(r=>r.probability>=b.min && r.probability<b.max);
    return {range:`${Math.round(b.min*100)}-${Math.min(100,Math.round(b.max*100))}%`,
      count:xs.length, predictedMean:xs.length?xs.reduce((s,r)=>s+r.probability,0)/xs.length:null,
      observedRate:xs.length?xs.reduce((s,r)=>s+r.outcome,0)/xs.length:null};
  }).filter(b=>b.count);
  const priced = rows.filter(r=>Number.isFinite(r.odds) && r.odds>1);
  const profitUnits = priced.reduce((s,r)=>s+(r.outcome===1?r.odds-1:-1),0);
  return {count:n,brierScore:brier,accuracy,calibration,oddsCount:priced.length,
    profitUnits:priced.length?profitUnits:null,roi:priced.length?profitUnits/priced.length:null};
}

function runBacktest(matches, options = {}) {
  const ordered = uniqueChronological(matches);
  const scored = [];
  const skipped = {invalidOrDuplicate: (Array.isArray(matches)?matches.length:0)-ordered.length, insufficientHistory:0};
  for (let i=0;i<ordered.length;i++) {
    const target = ordered[i];
    const prior = ordered.slice(0,i).filter(m=>dateMs(m)<dateMs(target));
    const prediction = buildPrediction(target, prior, options);
    if (!prediction) { skipped.insufficientHistory++; continue; }
    scored.push({fixtureId:target.fixtureId,date:target.date,leagueId:target.leagueId,
      probability:prediction.probability,outcome:(target.homeHT+target.awayHT)>0?1:0,
      odds:Number.isFinite(target.oddsOver05HT)&&target.oddsOver05HT>1?target.oddsOver05HT:null});
  }
  return {method:'rolling-origin: solo partidos anteriores; mismo torneo y temporada; goles al descanso',
    scored:scored.length,skipped,metrics:scorePredictions(scored),predictions:scored};
}

module.exports = {runBacktest, scorePredictions, uniqueChronological};
