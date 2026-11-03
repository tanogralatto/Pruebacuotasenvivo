/**
 * TANOapp — backtest cronológico del Poisson Over 0,5 goles 1T.
 * Entrada: fixtures finalizados, HT explícito y validado. No consulta APIs.
 * Cada predicción usa exclusivamente partidos anteriores al kickoff.
 */
'use strict';
const poisson = require('./modelo-poisson.js');
const validGoals = n => Number.isInteger(n) && n >= 0;
const dateMs = m => Date.parse(m.date);

function validMatch(m) {
  return m && m.fixtureId != null && Number.isFinite(dateMs(m)) &&
    m.leagueId != null && m.season != null &&
    m.homeTeamId != null && m.awayTeamId != null &&
    String(m.homeTeamId) !== String(m.awayTeamId) &&
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
    .sort((a, b) => dateMs(a) - dateMs(b) || String(a.fixtureId).localeCompare(String(b.fixtureId)));
}

function historiesForTeam(teamId, leagueMatches, limit = 20) {
  return leagueMatches
    .filter(m => String(m.homeTeamId) === String(teamId) || String(m.awayTeamId) === String(teamId))
    .map(m => String(m.homeTeamId) === String(teamId)
      ? {scoredHT:m.homeHT, concededHT:m.awayHT}
      : {scoredHT:m.awayHT, concededHT:m.homeHT})
    .slice(-limit);
}

function buildPrediction(match, history, options = {}) {
  const minLeague = options.minLeagueMatches ?? 20;
  const minTeam = options.minTeamMatches ?? 5;
  const leagueMatches = history.filter(m =>
    String(m.leagueId) === String(match.leagueId) &&
    String(m.season) === String(match.season) &&
    dateMs(m) < dateMs(match));
  if (leagueMatches.length < minLeague) return null;

  const leagueHome = leagueMatches.reduce((s,m)=>s+m.homeHT,0)/leagueMatches.length;
  const leagueAway = leagueMatches.reduce((s,m)=>s+m.awayHT,0)/leagueMatches.length;
  if (!(leagueHome > 0 && leagueAway > 0)) return null;

  const homeHistory = historiesForTeam(match.homeTeamId, leagueMatches, options.teamHistoryLimit ?? 20);
  const awayHistory = historiesForTeam(match.awayTeamId, leagueMatches, options.teamHistoryLimit ?? 20);
  if (homeHistory.length < minTeam || awayHistory.length < minTeam) return null;

  const result = poisson.calculate({
    homeHistory, awayHistory,
    leagueHomeGoalsHT: leagueHome,
    leagueAwayGoalsHT: leagueAway
  });
  if (!result.ok) return null;

  // Baseline: Poisson league-only, without team-specific attack/defence adjustments.
  const baselineLambda = leagueHome + leagueAway;
  const baselineProbability = 1 - Math.exp(-baselineLambda);
  return {
    probability: result.probability,
    baselineProbability,
    leagueMatches: leagueMatches.length,
    homeMatches: homeHistory.length,
    awayMatches: awayHistory.length
  };
}

function scorePredictions(rows, probabilityKey = 'probability') {
  const n = rows.length;
  if (!n) return {count:0, brierScore:null, logLoss:null, accuracy:null, hitRate:null, meanPredicted:null, observedRate:null, calibration:[], oddsCount:0, roi:null, profitUnits:null};
  const eps = 1e-15;
  const brier = rows.reduce((s,r)=>s+(r[probabilityKey]-r.outcome)**2,0)/n;
  const logLoss = -rows.reduce((s,r)=>{
    const p=Math.min(1-eps,Math.max(eps,r[probabilityKey]));
    return s+(r.outcome*Math.log(p)+(1-r.outcome)*Math.log(1-p));
  },0)/n;
  const hits=rows.reduce((s,r)=>s+r.outcome,0);
  const bands = [
    {min:0,max:.5},{min:.5,max:.6},{min:.6,max:.7},{min:.7,max:.8},
    {min:.8,max:.9},{min:.9,max:1.000001}
  ];
  const calibration = bands.map(b => {
    const xs = rows.filter(r=>r[probabilityKey]>=b.min && r[probabilityKey]<b.max);
    return {range:`${Math.round(b.min*100)}-${Math.min(100,Math.round(b.max*100))}%`,
      count:xs.length, predictedMean:xs.length?xs.reduce((s,r)=>s+r[probabilityKey],0)/xs.length:null,
      observedRate:xs.length?xs.reduce((s,r)=>s+r.outcome,0)/xs.length:null};
  }).filter(b => b.count);
  const priced = rows.filter(r=>Number.isFinite(r.odds) && r.odds>1);
  const profitUnits = priced.reduce((s,r)=>s+(r.outcome===1?r.odds-1:-1),0);
  return {
    count:n, brierScore:brier, logLoss, accuracy:rows.filter(r=>(r[probabilityKey]>=.5)===(r.outcome===1)).length/n,
    hitRate:hits/n, meanPredicted:rows.reduce((s,r)=>s+r[probabilityKey],0)/n,
    observedRate:hits/n, calibration, oddsCount:priced.length,
    profitUnits:priced.length?profitUnits:null, roi:priced.length?profitUnits/priced.length:null
  };
}

function runBacktest(matches, options = {}) {
  const ordered = uniqueChronological(matches);
  const scored = [];
  const skipped = {invalidOrDuplicate:(Array.isArray(matches)?matches.length:0)-ordered.length, insufficientHistory:0};
  for (let i=0;i<ordered.length;i++) {
    const target=ordered[i];
    // Strict cutoff prevents same-timestamp fixtures from leaking into one another.
    const prior=ordered.slice(0,i).filter(m=>dateMs(m)<dateMs(target));
    const prediction=buildPrediction(target,prior,options);
    if (!prediction) { skipped.insufficientHistory++; continue; }
    scored.push({
      fixtureId:target.fixtureId,date:target.date,leagueId:target.leagueId,
      probability:prediction.probability,baselineProbability:prediction.baselineProbability,
      outcome:(target.homeHT+target.awayHT)>0?1:0,
      odds:Number.isFinite(target.oddsOver05HT)&&target.oddsOver05HT>1?target.oddsOver05HT:null,
      sample:{league:prediction.leagueMatches,home:prediction.homeMatches,away:prediction.awayMatches}
    });
  }
  return {
    method:'rolling-origin cronológico: solo fixtures anteriores; misma liga y temporada; HT explícito validado',
    inputMatches:Array.isArray(matches)?matches.length:0,
    scored:scored.length,skipped,
    metrics:{
      poisson:scorePredictions(scored,'probability'),
      baselineLiga:scorePredictions(scored,'baselineProbability')
    },
    predictions:scored
  };
}

module.exports = {runBacktest, scorePredictions, uniqueChronological, buildPrediction};
