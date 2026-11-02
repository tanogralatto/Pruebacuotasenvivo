/**
 * TANOapp — modelo propio Poisson para Over 0,5 goles al descanso.
 *
 * Módulo puro: no hace llamadas a API, no modifica el Escáner ni inventa cuotas.
 * Los datos de entrada deben ser goles AL DESCANSO, nunca goles finales.
 *
 * Cada historial de equipo: [{ scoredHT: number, concededHT: number }, ...]
 * Parámetros de liga: promedio de goles HT del local y visitante por partido.
 */
(function (root) {
  'use strict';

  const DEFAULT_PRIOR_MATCHES = 8;
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const validNumber = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;

  function average(values) {
    const xs = values.filter(validNumber);
    return xs.length ? xs.reduce((sum, n) => sum + n, 0) / xs.length : null;
  }

  function summarizeTeam(history, priorMean, priorMatches = DEFAULT_PRIOR_MATCHES) {
    if (!Array.isArray(history) || !validNumber(priorMean) || priorMatches < 0) return null;
    const usable = history.filter(g => g && validNumber(g.scoredHT) && validNumber(g.concededHT));
    if (!usable.length) return null;

    const scored = average(usable.map(g => g.scoredHT));
    const conceded = average(usable.map(g => g.concededHT));
    const weight = usable.length / (usable.length + priorMatches);
    return {
      matches: usable.length,
      scoredHT: scored,
      concededHT: conceded,
      // Shrinkage toward league mean avoids overreacting to tiny samples.
      adjustedScoredHT: weight * scored + (1 - weight) * priorMean,
      adjustedConcededHT: weight * conceded + (1 - weight) * priorMean,
      shrinkageWeight: weight
    };
  }

  function calculate(input) {
    if (!input || !Array.isArray(input.homeHistory) || !Array.isArray(input.awayHistory)) {
      return { ok: false, reason: 'Faltan historiales válidos de ambos equipos.' };
    }
    const leagueHome = input.leagueHomeGoalsHT;
    const leagueAway = input.leagueAwayGoalsHT;
    if (!validNumber(leagueHome) || !validNumber(leagueAway) || leagueHome <= 0 || leagueAway <= 0) {
      return { ok: false, reason: 'Faltan promedios fiables de goles HT de la liga.' };
    }

    const priorMatches = Number.isFinite(input.priorMatches)
      ? clamp(input.priorMatches, 0, 30)
      : DEFAULT_PRIOR_MATCHES;
    const home = summarizeTeam(input.homeHistory, leagueHome, priorMatches);
    const away = summarizeTeam(input.awayHistory, leagueAway, priorMatches);
    if (!home || !away) return { ok: false, reason: 'No hay muestra HT suficiente para ambos equipos.' };

    // Fuerza ofensiva y debilidad defensiva, relativas a la media de la liga.
    const homeAttack = home.adjustedScoredHT / leagueHome;
    const homeDefenceWeakness = home.adjustedConcededHT / leagueAway;
    const awayAttack = away.adjustedScoredHT / leagueAway;
    const awayDefenceWeakness = away.adjustedConcededHT / leagueHome;

    const lambdaHomeHT = leagueHome * homeAttack * awayDefenceWeakness;
    const lambdaAwayHT = leagueAway * awayAttack * homeDefenceWeakness;
    const lambdaTotalHT = lambdaHomeHT + lambdaAwayHT;
    const probabilityOver05HT = 1 - Math.exp(-lambdaTotalHT);
    const fairOdds = probabilityOver05HT > 0 ? 1 / probabilityOver05HT : null;

    const marketOdds = Number(input.marketOdds);
    const hasOdds = Number.isFinite(marketOdds) && marketOdds > 1;
    const ev = hasOdds ? probabilityOver05HT * marketOdds - 1 : null;

    return {
      ok: true,
      market: 'Over 0,5 goles 1T',
      method: 'Poisson independiente con ajuste por promedio de liga y regresión a la media',
      sample: { homeMatches: home.matches, awayMatches: away.matches },
      lambdas: {
        homeHT: round(lambdaHomeHT, 4),
        awayHT: round(lambdaAwayHT, 4),
        totalHT: round(lambdaTotalHT, 4)
      },
      probability: round(probabilityOver05HT, 6),
      probabilityPercent: round(probabilityOver05HT * 100, 2),
      fairOdds: round(fairOdds, 3),
      marketOdds: hasOdds ? marketOdds : null,
      ev: hasOdds ? round(ev, 6) : null,
      evPercent: hasOdds ? round(ev * 100, 2) : null,
      status: hasOdds ? (ev > 0 ? 'EV positivo estimado' : 'Sin EV positivo estimado') : 'Cuota de mercado no disponible',
      warning: 'Estimación inicial no calibrada. Validar fuera de muestra antes de usar para apostar.',
      diagnostics: { home, away, leagueHomeGoalsHT: leagueHome, leagueAwayGoalsHT: leagueAway, priorMatches }
    };
  }

  function round(n, digits) {
    const p = 10 ** digits;
    return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * p) / p : null;
  }

  const api = { calculate, summarizeTeam, DEFAULT_PRIOR_MATCHES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TanoPoissonModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
