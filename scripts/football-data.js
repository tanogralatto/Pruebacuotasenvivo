#!/usr/bin/env node
/**
 * Baja de football-data.co.uk las cuotas de cierre 1X2 (Pinnacle o promedio de las casas) y los resultados
 * de las últimas dos temporadas, y arma data/fd-1x2.json para la pestaña Precisión de goles.html.
 * Uso: node scripts/football-data.js   (Node 18+; lo corre también la tarea semanal de GitHub)
 */
'use strict';
const fs = require('fs');
const path = require('path');

// id de liga en API-Football -> archivo de football-data.co.uk
const MAIN = { 39: 'E0', 40: 'E1', 41: 'E2', 42: 'E3', 43: 'EC', 179: 'SC0', 180: 'SC1', 181: 'SC2', 182: 'SC3',
  78: 'D1', 79: 'D2', 135: 'I1', 136: 'I2', 140: 'SP1', 141: 'SP2', 61: 'F1', 62: 'F2', 88: 'N1', 144: 'B1',
  94: 'P1', 203: 'T1', 197: 'G1' };
const EXTRA = { 128: 'ARG', 218: 'AUT', 71: 'BRA', 169: 'CHN', 119: 'DNK', 244: 'FIN', 357: 'IRL', 98: 'JPN',
  262: 'MEX', 103: 'NOR', 106: 'POL', 283: 'ROU', 235: 'RUS', 113: 'SWE', 207: 'SWZ', 253: 'USA' };
const BASE = 'https://www.football-data.co.uk/';
const SINCE = new Date(Date.UTC(new Date().getUTCFullYear() - 2, 6, 1)); // desde el 1 de julio de hace dos años

function seasonCodes() {
  const now = new Date(), y = now.getUTCFullYear() % 100, m = now.getUTCMonth();
  const start = m >= 6 ? y : y - 1; // la temporada europea arranca en julio
  const pad = n => String((n + 100) % 100).padStart(2, '0');
  return [start - 1, start].map(s => pad(s) + pad(s + 1));
}
function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const head = lines.shift().split(',').map(h => h.trim());
  return lines.map(l => { const v = l.split(','); const o = {}; head.forEach((h, i) => { if (h) o[h] = (v[i] || '').trim(); }); return o; });
}
function parseDate(s) {
  const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let y = Number(m[3]); if (y < 100) y += 2000;
  return Date.UTC(y, Number(m[2]) - 1, Number(m[1]));
}
// Probabilidades sin margen. Prioridad: Pinnacle cierre, promedio cierre, Pinnacle, promedio.
function probs(r) {
  for (const [h, d, a] of [['PSCH', 'PSCD', 'PSCA'], ['AvgCH', 'AvgCD', 'AvgCA'], ['PSH', 'PSD', 'PSA'], ['AvgH', 'AvgD', 'AvgA']]) {
    const o = [r[h], r[d], r[a]].map(Number);
    if (o.every(x => x > 1)) { const inv = o.map(x => 1 / x), s = inv[0] + inv[1] + inv[2]; if (s > 0.98 && s < 1.3) return inv.map(x => Math.round(x / s * 1000)); }
  }
  return null;
}
async function get(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'tanoapp-goles' } });
  if (!res.ok) throw new Error(url + ' HTTP ' + res.status);
  return res.text();
}
(async () => {
  const out = { source: 'football-data.co.uk', built: new Date().toISOString().slice(0, 10), note: 'fila = [día (desde 1970), goles local, goles visitante, p local, p empate, p visitante (por mil, sin margen), local, visitante]', leagues: {} };
  const jobs = [];
  for (const [lid, code] of Object.entries(MAIN)) for (const s of seasonCodes()) jobs.push({ lid, url: BASE + 'mmz4281/' + s + '/' + code + '.csv', kind: 'main' });
  for (const [lid, code] of Object.entries(EXTRA)) jobs.push({ lid, url: BASE + 'new/' + code + '.csv', kind: 'extra' });
  for (const j of jobs) {
    let rows;
    try { rows = parseCsv(await get(j.url)); } catch (e) { console.warn('salteado:', e.message); continue; }
    const list = out.leagues[j.lid] || (out.leagues[j.lid] = []);
    for (const r of rows) {
      const t = parseDate(r.Date); if (t === null || t < SINCE.getTime()) continue;
      const hg = Number(j.kind === 'main' ? r.FTHG : r.HG), ag = Number(j.kind === 'main' ? r.FTAG : r.AG);
      if (!Number.isInteger(hg) || !Number.isInteger(ag)) continue;
      const p = probs(r); if (!p) continue;
      list.push([Math.round(t / 864e5), hg, ag, p[0], p[1], p[2], j.kind === 'main' ? r.HomeTeam : r.Home, j.kind === 'main' ? r.AwayTeam : r.Away]);
    }
    await new Promise(r => setTimeout(r, 300));
  }
  let n = 0;
  for (const k of Object.keys(out.leagues)) { out.leagues[k].sort((a, b) => a[0] - b[0]); n += out.leagues[k].length; if (!out.leagues[k].length) delete out.leagues[k]; }
  const file = path.join(__dirname, '..', 'data', 'fd-1x2.json');
  fs.writeFileSync(file, JSON.stringify(out));
  console.log(`${n} partidos de ${Object.keys(out.leagues).length} ligas -> ${file} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
})();
