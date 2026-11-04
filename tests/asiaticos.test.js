'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const A = require('../asiaticos.js');
const T = require('../modelo-poisson.js');

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);

test('diferencia de goles: suma 1 y es simétrica con equipos iguales', () => {
  const d = A.diffDist(1.3, 1.3);
  close(d.p.reduce((s, x) => s + x, 0), 1);
  const at = k => d.p[k - d.min];
  close(at(1), at(-1)); close(at(2), at(-2));
});

test('resultado por línea: enteras, medias y de cuarto', () => {
  // Local −0,5: gana si gana, pierde si empata o pierde.
  assert.equal(A.outcome(1, -0.5), 1); assert.equal(A.outcome(0, -0.5), -1);
  // Local −1: gana por 2, devuelve si gana por 1.
  assert.equal(A.outcome(2, -1), 1); assert.equal(A.outcome(1, -1), 0); assert.equal(A.outcome(0, -1), -1);
  // Local −0,25: mitad a 0 y mitad a −0,5. Con empate pierde la mitad.
  assert.equal(A.outcome(0, -0.25), -0.5); assert.equal(A.outcome(1, -0.25), 1);
  // Local −0,75: mitad a −0,5 y mitad a −1. Gana por 1 → gana la mitad.
  assert.equal(A.outcome(1, -0.75), 0.5); assert.equal(A.outcome(2, -0.75), 1);
  // Local +0,25: con empate gana la mitad.
  assert.equal(A.outcome(0, 0.25), 0.5);
});

test('probabilidades por línea: coinciden con la diferencia de goles', () => {
  const d = A.diffDist(1.6, 1.0), at = k => d.p[k - d.min];
  let pHomeWin = 0, pDraw = at(0), pAwayWin = 0;
  for (let k = d.min; k < d.min + d.p.length; k++) { if (k > 0) pHomeWin += at(k); if (k < 0) pAwayWin += at(k); }
  // Local −0,5 = gana el local.
  const h05 = A.lineProbs(d, -0.5, 'home');
  close(h05.win, pHomeWin); close(h05.lose, pDraw + pAwayWin); close(h05.pCond, pHomeWin);
  // Visitante +0,5 (línea del local −0,5) = empate o gana el visitante.
  const a05 = A.lineProbs(d, -0.5, 'away');
  close(a05.win, pDraw + pAwayWin); close(a05.pCond + h05.pCond, 1);
  // Local 0 (empate devuelve).
  const h0 = A.lineProbs(d, 0, 'home');
  close(h0.push, pDraw); close(h0.pCond, pHomeWin / (pHomeWin + pAwayWin));
  // Local −0,25: con empate pierde la mitad.
  const hq = A.lineProbs(d, -0.25, 'home');
  close(hq.halfLose, pDraw); close(hq.W, pHomeWin); close(hq.L, pAwayWin + pDraw / 2);
  // La cuota justa deja EV 0: W·(c−1) − L = 0.
  close(hq.W * (hq.fair - 1) - hq.L, 0);
});

test('cuotas de API-Football: los dos formatos de línea del visitante', () => {
  const resp = [{ fixture: { id: 1 }, bookmakers: [
    { name: 'Pinnacle', bets: [{ id: 4, name: 'Asian Handicap', values: [
      { value: 'Home -0.5', odd: '1.95' }, { value: 'Away +0.5', odd: '1.95' },
      { value: 'Home -0.25', odd: '1.80' }, { value: 'Away +0.25', odd: '2.10' }] }] },
    { name: 'Bet365', bets: [
      { id: 4, name: 'Asian Handicap', values: [{ value: 'Home -0.5', odd: '2.00' }, { value: 'Away -0.5', odd: '1.85' }, { value: 'Home +1', odd: '1.20' }, { value: 'Away +1', odd: '4.50' }] },
      { id: 19, name: 'Asian Handicap First Half', values: [{ value: 'Home -0.5', odd: '3.00' }, { value: 'Away -0.5', odd: '1.40' }] }] }
  ] }];
  const p = A.parseOdds(resp);
  assert.equal(p.books.size, 2);
  const pin = p.books.get('Pinnacle'), b365 = p.books.get('Bet365');
  assert.deepEqual(pin.get(-0.5), { home: 1.95, away: 1.95 });
  assert.deepEqual(pin.get(-0.25), { home: 1.8, away: 2.1 });
  // Bet365 repite la línea del local para el visitante: se detecta.
  assert.deepEqual(b365.get(-0.5), { home: 2.0, away: 1.85 });
  assert.deepEqual(b365.get(1), { home: 1.2, away: 4.5 });
  assert.ok(!p.betNames.some(n => /first half/i.test(n))); // el 1T no se mezcla
  const m = A.marketByLine(p);
  assert.equal(m.get(-0.5).bestHome.price, 2.0); assert.equal(m.get(-0.5).bestHome.bookmaker, 'Bet365');
  close(m.get(-0.5).mktHome, 0.5); assert.equal(m.get(-0.5).mktRef, 'Pinnacle, sin margen');
  assert.equal(A.mainLine(p, m), -0.5); // la más pareja en Pinnacle
});

test('vista: línea principal, EV contra el mercado, control de diferencia y stake', () => {
  const resp = [{ bookmakers: [
    { name: 'Pinnacle', bets: [{ name: 'Asian Handicap', values: [{ value: 'Home -0.5', odd: '1.95' }, { value: 'Away +0.5', odd: '1.95' }] }] },
    { name: 'Otra', bets: [{ name: 'Asian Handicap', values: [{ value: 'Home -0.5', odd: '2.10' }, { value: 'Away +0.5', odd: '1.80' }] }] }] }];
  const v = A.view({ lambdaHome: 1.5, lambdaAway: 1.1, odds: A.parseOdds(resp) }, T);
  assert.equal(v.ok, true); assert.equal(v.main.line, -0.5); assert.equal(v.mainFromOdds, true);
  const h = v.main.home;
  assert.equal(h.odds, 2.1);
  close(h.mkt, 0.5); close(h.evMkt, 0.5 * 2.1 - 1); // +5% contra el mercado
  close(h.ev, h.pCond * 2.1 - 1);
  // Hándicap sin validar: Kelly usa solo el mercado (0,5 a 2,1) y ⅛: (0,5·1,1 − 0,5)/1,1 / 8.
  close(h.kelly.stake, ((0.5 * 1.1 - 0.5) / 1.1) / 8);
  // Un modelo que se aleja más de 12 puntos del mercado queda marcado.
  const far = A.view({ lambdaHome: 3.5, lambdaAway: 0.4, odds: A.parseOdds(resp) }, T);
  assert.equal(far.main.home.suspicious, true);
  // Sin goles esperados no se calcula.
  assert.equal(A.view({ lambdaHome: 0, lambdaAway: 1 }, T).ok, false);
  // Sin cuotas: la principal es la que el modelo ve más pareja.
  const no = A.view({ lambdaHome: 2.0, lambdaAway: 0.8 }, T);
  assert.equal(no.mainFromOdds, false); assert.ok(no.main.line < 0);
});

test('sin goles esperados del modelo: igual compara con el mercado', () => {
  const resp = [{ bookmakers: [
    { name: 'Pinnacle', bets: [{ name: 'Asian Handicap', values: [{ value: 'Home +1.5', odd: '1.95' }, { value: 'Away -1.5', odd: '1.95' }] }] },
    { name: 'Otra', bets: [{ name: 'Asian Handicap', values: [{ value: 'Home +1.5', odd: '2.10' }, { value: 'Away -1.5', odd: '1.80' }] }] }] }];
  const v = A.view({ lambdaHome: null, lambdaAway: null, odds: A.parseOdds(resp), modelReason: 'Sin cálculo propio: muestra insuficiente.' }, T);
  assert.equal(v.ok, true); assert.equal(v.hasModel, false); assert.match(v.modelReason, /muestra insuficiente/);
  assert.equal(v.main.line, 1.5);
  close(v.main.home.evMkt, 0.5 * 2.1 - 1);
  assert.equal(v.main.home.pCond, null); assert.equal(v.main.home.ev, null);
  close(v.main.home.kelly.stake, ((0.5 * 1.1 - 0.5) / 1.1) / 8); // solo mercado, ⅛
  assert.equal(v.lines.length, 1); // sin modelo solo se muestran las líneas con cuota
  // Sin modelo y sin cuotas: no evaluable.
  assert.equal(A.view({ lambdaHome: null, lambdaAway: null, odds: null }, T).ok, false);
});
