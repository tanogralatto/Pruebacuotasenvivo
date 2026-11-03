/**
 * TANOapp — validación, registro de predicciones, xG y probabilidad en vivo (parte de la interfaz).
 *
 * Se carga DESPUÉS del script principal de index.html y reutiliza sus globales
 * (state, api, LS, $, esc, loadLeagueHistory, xgStore, ...). La parte "pura" no toca el
 * navegador y se prueba con Node (tests/validacion-v2.test.js).
 *
 * Qué resuelve:
 *  - logPredictions / saveLambdas: guarda cada predicción ANTES del partido (con su cuota).
 *  - Liquidar registro: baja el resultado al descanso y mide Brier, calibración y ROI reales.
 *  - Validar con las ligas marcadas: backtest cronológico + ajuste de parámetros + calibración.
 *  - Probar xG / Bajar xG: comprueba si API-Football entrega expected_goals y lo guarda.
 *  - En vivo: probabilidad y EV de Over 0,5 / 1,0 1T con el λ prepartido guardado.
 */
(function (root) {
  'use strict';

  const DONE = ['FT', 'AET', 'PEN'];
  const VOID_ST = ['PST', 'CANC', 'ABD', 'AWD', 'WO', 'SUSP'];
  const LOG_KEY = 'o05:plog:v1';
  const LAM_KEY = 'o05:lam:v1';
  const MAX_LOG = 3000;
  const isNum = n => typeof n === 'number' && Number.isFinite(n);
  const isGoals = n => Number.isInteger(n) && n >= 0;

  /* ============================== PURO ============================== */

  // Resultado al descanso de un partido de /fixtures. Nunca inventa un HT.
  function settleFromFixture(f) {
    const st = f && f.fixture && f.fixture.status && f.fixture.status.short;
    if (VOID_ST.includes(st)) return { status: 'void', reason: st };
    if (!DONE.includes(st)) return { status: 'pending', reason: st || 'sin estado' };
    const ht = (f.score && f.score.halftime) || {};
    if (isGoals(ht.home) && isGoals(ht.away)) {
      return { status: 'settled', y: ht.home + ht.away > 0 ? 1 : 0, ht: [ht.home, ht.away], source: 'api' };
    }
    const ft = (f.score && f.score.fulltime) || {};
    if (ft.home === 0 && ft.away === 0) return { status: 'settled', y: 0, ht: [0, 0], source: 'inferred_ft_0_0' };
    return { status: 'unverified', reason: 'La API no informó el marcador al descanso.' };
  }

  function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  // Métricas del registro propio. T = modelo (scoreRows). Solo partidos liquidados.
  function summarizeLog(entries, T) {
    const settled = (entries || []).filter(e => e && (e.y === 0 || e.y === 1) && isNum(e.p));
    const rows = settled.map(e => ({ ts: e.ts, p: e.p, y: e.y }));
    const m = T.scoreRows(rows);
    const priced = settled.filter(e => isNum(e.odds) && e.odds > 1);
    const roiOf = list => {
      if (!list.length) return { n: 0, profit: null, roi: null, hit: null };
      const profit = list.reduce((s, e) => s + (e.y === 1 ? e.odds - 1 : -1), 0);
      return { n: list.length, profit, roi: profit / list.length, hit: list.filter(e => e.y === 1).length / list.length };
    };
    const evPlus = priced.filter(e => e.signal === 'ev_solido' || e.signal === 'ev_posible');
    const solid = priced.filter(e => e.signal === 'ev_solido');
    // Valor esperado que el modelo prometía vs lo que pasó (si el modelo es bueno, se parecen).
    const promised = evPlus.length ? evPlus.reduce((s, e) => s + (e.p * e.odds - 1), 0) / evPlus.length : null;
    return {
      settled: settled.length,
      pending: (entries || []).filter(e => e && e.y == null && !e.void).length,
      metrics: m,
      all: roiOf(priced),
      evPlus: roiOf(evPlus),
      evSolid: roiOf(solid),
      promisedEv: promised
    };
  }

  // Decide si el modelo "pasó" la validación. Criterios fijos y explícitos.
  function validationVerdict(metrics, opts) {
    const o = Object.assign({ minN: 300, minSkill: 0.01, maxBandGap: 0.07, minBand: 30 }, opts || {});
    const reasons = [];
    let ok = true;
    if (!metrics || !metrics.count) return { validated: false, reasons: ['No hubo partidos evaluables.'] };
    if (metrics.count < o.minN) { ok = false; reasons.push(`Pocos partidos evaluados: ${metrics.count} de ${o.minN} necesarios.`); }
    if (!(metrics.skill >= o.minSkill)) {
      ok = false;
      reasons.push(`Mejora sobre la tasa base de solo ${(metrics.skill * 100).toFixed(1)}% (mínimo ${(o.minSkill * 100).toFixed(0)}%).`);
    }
    const bad = (metrics.calibration || []).filter(b => b.count >= o.minBand && Math.abs(b.predicted - b.observed) > o.maxBandGap);
    if (bad.length) {
      ok = false;
      reasons.push('Bandas mal calibradas: ' + bad.map(b => `${b.range} (dice ${(b.predicted * 100).toFixed(0)}%, ocurre ${(b.observed * 100).toFixed(0)}%)`).join('; ') + '.');
    }
    if (ok) reasons.push('Supera la tasa base y las bandas con muestra suficiente están bien calibradas.');
    return { validated: ok, reasons };
  }

  function bestByBrier(results) {
    const ok = (results || []).filter(r => r && isNum(r.brier) && r.count > 0);
    if (!ok.length) return null;
    return ok.slice().sort((a, b) => a.brier - b.brier)[0];
  }

  // Probabilidad en vivo de Over 0,5 / 1,0 del 1T. T = modelo.
  function liveView(inp, T) {
    const o = inp || {};
    if (!(o.lambdaTotal > 0)) return { ok: false, reason: 'No hay λ prepartido guardado para este partido. Analizalo primero en el Escáner.' };
    if (!isNum(o.minute) || o.minute < 0) return { ok: false, reason: 'La API no informó el minuto.' };
    const goals = Math.max(0, Number(o.goalsNow) || 0);
    const rem = T.liveRemainingLambda({ lambdaTotalHT: o.lambdaTotal, minute: o.minute, goalsNow: goals });
    if (!rem.ok) return rem;
    const mk = (line, odds) => {
      const r = T.liveMarket({ lambdaRemaining: rem.lambdaRemaining, goalsNow: goals, line, odds: Number(odds) > 1 ? odds : undefined });
      return r.ok ? r : null;
    };
    return { ok: true, remaining: rem, over05: mk(0.5, o.odds05), over10: mk(1, o.odds10) };
  }

  function pruneLog(map) {
    const list = Object.values(map || {});
    if (list.length <= MAX_LOG) return map;
    list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const keep = {};
    list.slice(0, MAX_LOG).forEach(e => { keep[e.id] = e; });
    return keep;
  }

  const pure = { settleFromFixture, chunk, summarizeLog, validationVerdict, bestByBrier, liveView, pruneLog, LOG_KEY, LAM_KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  root.TanoVal = pure;

  /* ============================ NAVEGADOR =========================== */
  if (typeof document === 'undefined' || !document.getElementById('btnValidate')) return;

  const T = root.TanoPoissonModel, X = root.TanoXg;
  const q = s => document.querySelector(s);
  const pct = (x, d = 1) => (typeof fmtPct === 'function' ? fmtPct(x, d) : (x * 100).toFixed(d) + '%');
  const num = (x, d = 2) => (typeof fmtNum === 'function' ? fmtNum(x, d) : Number(x).toFixed(d));
  const valStatus = (m, err) => setStatus(q('#valStatus'), m, err);
  const readLog = () => LS.get(LOG_KEY, {}) || {};
  const writeLog = map => LS.set(LOG_KEY, pruneLog(map));
  const nowSec = () => Math.floor(Date.now() / 1000);
  const tick = () => new Promise(r => setTimeout(r, 0));

  /* ---- registro de predicciones (antes del partido) ---- */
  root.logPredictions = function (results) {
    const log = readLog(), now = nowSec();
    let added = 0;
    for (const r of results || []) {
      const p = r && r.poisson;
      if (!p || !p.ok || !r.fx) continue;
      const ts = Math.floor(Date.parse(r.fx.iso) / 1000);
      if (!Number.isFinite(ts) || now >= ts) continue; // nunca se registra con el partido iniciado
      const id = String(r.fx.id), prev = log[id];
      if (prev && (prev.y === 0 || prev.y === 1)) continue;
      const d = p.decision || {};
      log[id] = {
        id, ts, lid: r.fx.lid, season: r.fx.season, hid: r.fx.hid, aid: r.fx.aid, hn: r.fx.hn, an: r.fx.an, ln: r.fx.ln,
        p: p.probability, pRaw: p.probabilityRaw, pLow: p.pLow, lam: p.lambdas && p.lambdas.total,
        odds: p.marketOdds ? p.marketOdds.price : null, bk: p.marketOdds ? p.marketOdds.bookmaker : null,
        marketProb: Number.isFinite(p.marketProb) ? p.marketProb : null,
        ev: Number.isFinite(d.ev) ? d.ev : null, signal: d.signal || null, validated: !!p.validated,
        evMkt: Number.isFinite(p.marketProb) && p.marketOdds && p.marketOdds.price > 1 ? p.marketProb * p.marketOdds.price - 1 : null,
        calibrated: !!p.calibrated, params: p.params || null, loggedAt: now
      };
      added++;
    }
    if (added) writeLog(log);
    return added;
  };

  // λ del partido para la pestaña En Vivo (se guarda aunque el partido ya haya empezado).
  root.saveLambdas = function (results) {
    const map = LS.get(LAM_KEY, {}) || {}, now = nowSec();
    for (const r of results || []) {
      const p = r && r.poisson;
      if (!p || !p.ok || !r.fx || !p.lambdas) continue;
      map[String(r.fx.id)] = { lam: p.lambdas.total, ts: Math.floor(Date.parse(r.fx.iso) / 1000), hn: r.fx.hn, an: r.fx.an, savedAt: now };
    }
    for (const k of Object.keys(map)) if (!(map[k].ts > now - 3 * 86400)) delete map[k];
    LS.set(LAM_KEY, map);
  };

  /* ---- liquidación ---- */
  async function settleLog() {
    if (!state.key) { valStatus('Primero guardá y probá tu clave de API-Football.', true); return; }
    const log = readLog(), now = nowSec();
    const pending = Object.values(log).filter(e => e.y == null && !e.void && e.ts < now - 150 * 60);
    if (!pending.length) { valStatus('No hay predicciones pendientes de liquidar (el partido debe haber terminado hace más de 2 h y media).'); renderLogOut(); return; }
    state.cancel = false;
    let settled = 0, voided = 0, left = 0;
    for (const ids of chunk(pending.map(e => e.id), 20)) {
      try {
        const j = await api('/fixtures', { ids: ids.join('-'), timezone: TZ });
        const byId = new Map((j.response || []).map(f => [String(f.fixture.id), f]));
        for (const id of ids) {
          const f = byId.get(String(id));
          if (!f) { left++; continue; }
          const s = settleFromFixture(f);
          if (s.status === 'settled') { log[id].y = s.y; log[id].ht = s.ht; log[id].htSource = s.source; log[id].settledAt = now; settled++; }
          else if (s.status === 'void') { log[id].void = true; voided++; }
          else left++;
        }
      } catch (e) { valStatus('Error al liquidar: ' + e.message, true); writeLog(log); return; }
    }
    writeLog(log);
    valStatus(`Liquidación lista: ${settled} resueltas, ${voided} anuladas/suspendidas, ${left} todavía pendientes o sin marcador al descanso.`);
    renderLogOut();
  }

  function bandsTable(cal) {
    if (!cal || !cal.length) return '';
    return '<table class="val-table"><tr><th>Banda</th><th>Casos</th><th>Dice</th><th>Ocurre</th></tr>' +
      cal.map(b => `<tr><td>${esc(b.range)}</td><td>${b.count}</td><td>${pct(b.predicted, 0)}</td><td>${pct(b.observed, 0)}</td></tr>`).join('') + '</table>';
  }
  const roiLine = (label, r) => r.n ? `<tr><td>${label}</td><td>${r.n}</td><td>${pct(r.hit, 0)}</td><td style="color:${r.roi >= 0 ? 'var(--c4)' : 'var(--c1)'}">${(r.roi >= 0 ? '+' : '') + num(r.roi * 100, 1)}%</td></tr>` : `<tr><td>${label}</td><td>0</td><td>—</td><td>—</td></tr>`;

  function renderLogOut() {
    const box = q('#logOut');
    if (!box) return;
    const s = summarizeLog(Object.values(readLog()), T);
    if (!s.settled && !s.pending) {
      box.innerHTML = '<div class="val-box"><b>Registro propio vacío.</b> Cada vez que analizás partidos del 1T con cuota, la predicción se guarda antes del inicio. Después tocá «Liquidar registro» para medir resultados reales.</div>';
      return;
    }
    const m = s.metrics;
    box.innerHTML = '<div class="val-box"><b>Registro propio (predicciones guardadas antes del partido)</b><br>' +
      `Liquidadas: <b>${s.settled}</b> · pendientes: <b>${s.pending}</b>` +
      (m.count ? `<br>Brier ${num(m.brier, 4)} (tasa base ${num(m.baselineBrier, 4)}) · mejora sobre la base ${num(m.skill * 100, 1)}% · promedio predicho ${pct(m.meanP, 1)} vs real ${pct(m.observed, 1)}` : '') +
      '</div>' + (m.count ? bandsTable(m.calibration) : '') +
      '<table class="val-table"><tr><th>Apuestas (1u, cuota guardada)</th><th>N</th><th>Aciertos</th><th>ROI</th></tr>' +
      roiLine('Todas con cuota', s.all) + roiLine('EV+ posible o sólido', s.evPlus) + roiLine('EV+ sólido', s.evSolid) + '</table>' +
      (s.promisedEv != null ? `<div class="small">El modelo prometía un EV promedio de ${(s.promisedEv >= 0 ? '+' : '') + num(s.promisedEv * 100, 1)}% en las señales EV+. Si el ROI real queda muy por debajo, el modelo está sobreestimando.</div>` : '') +
      '<div class="small">Con pocas decenas de apuestas el ROI es puro ruido: hacen falta cientos para sacar conclusiones.</div>';
  }

  async function copyLog() {
    const txt = JSON.stringify(Object.values(readLog()), null, 1);
    try { await navigator.clipboard.writeText(txt); valStatus('Registro copiado (' + Object.keys(readLog()).length + ' predicciones).'); }
    catch (e) { valStatus('No se pudo copiar el registro.', true); }
  }

  /* ---- ligas marcadas ---- */
  function selectedComps() {
    const comps = new Map();
    for (const f of state.fixtures || []) if (state.selected.has(f.lid)) comps.set(String(f.lid), { lid: f.lid, season: f.season });
    return [...comps.values()];
  }

  /* ---- sonda y descarga de xG ---- */
  function typesOf(resp) {
    const b = Array.isArray(resp) && resp[0] && Array.isArray(resp[0].statistics) ? resp[0].statistics : [];
    return b.map(s => s && s.type).filter(Boolean);
  }
  async function recentFinished(c) {
    const games = await leagueSeasonGames(c.lid, c.season);
    return games.filter(g => g.fs).sort((a, b) => b.d - a.d)[0] || null;
  }
  async function probeXg() {
    if (!state.key) { valStatus('Primero guardá y probá tu clave de API-Football.', true); return; }
    const comps = selectedComps().slice(0, 5);
    if (!comps.length) { valStatus('Buscá partidos y marcá al menos una liga en la sección 2.', true); return; }
    state.cancel = false;
    const lines = [];
    let first = null;
    for (const c of comps) {
      try {
        const g = await recentFinished(c);
        if (!g) { lines.push(`Liga ${c.lid}: sin partidos terminados.`); continue; }
        const j = await api('/fixtures/statistics', { fixture: g.i });
        const x = X.extractMatchXg(j.response, g.h, g.a);
        lines.push(`Liga ${c.lid} (partido ${g.i}): ` + (x.available ? `xG disponible (${num(x.home)} - ${num(x.away)}).` : 'sin xG. Estadísticas recibidas: ' + (typesOf(j.response).join(', ') || 'ninguna') + '.'));
        if (!first && g) first = g;
      } catch (e) { lines.push(`Liga ${c.lid}: error ${e.message}`); }
    }
    let half = '';
    if (first) {
      try {
        const j = await api('/fixtures/statistics', { fixture: first.i, half: 'true' });
        const blocks = Array.isArray(j.response) ? j.response.length : 0;
        half = `<br>Prueba del 1T (<code>half=true</code>) en el partido ${first.i}: la API respondió con ${blocks} bloque(s); tipos: ${esc(typesOf(j.response).join(', ') || 'ninguno')}. ` +
          (X.extractMatchXg(j.response, first.h, first.a).available ? 'Trae xG: habría que revisar si es del 1T.' : 'No trae xG del primer tiempo, así que el xG solo sirve como xG de partido completo escalado al 1T.');
      } catch (e) { half = `<br>El parámetro <code>half</code> no fue aceptado: ${esc(e.message)}. xG del 1T no disponible.`; }
    }
    q('#valOut').innerHTML = '<div class="val-box"><b>Sonda de xG</b><br>' + lines.map(esc).join('<br>') + half + '</div>';
    valStatus('Sonda terminada (' + state.calls + ' llamadas en total en esta sesión).');
  }

  async function downloadXg() {
    if (!state.key) { valStatus('Primero guardá y probá tu clave de API-Football.', true); return; }
    const comps = selectedComps();
    if (!comps.length) { valStatus('Buscá partidos y marcá al menos una liga en la sección 2.', true); return; }
    const budget = Math.max(10, Math.min(2000, Number(q('#xgBudget').value) || 200));
    const btn = q('#btnXgDownload');
    state.cancel = false;
    btn.disabled = true;
    try {
      // Paso 1: lista de partidos de cada liga. Avisa en pantalla y, si una liga falla, sigue con las demás.
      const names = new Map((state.fixtures || []).map(f => [f.lid, f.ln]));
      const badLeagues = [];
      const todo = [];
      for (let i = 0; i < comps.length; i++) {
        const c = comps[i], name = names.get(c.lid) || 'liga ' + c.lid;
        valStatus(`Preparando ligas ${i + 1} de ${comps.length} (${name})…`);
        try {
          const games = (await leagueSeasonGames(c.lid, c.season)).filter(g => g.fs && !(String(g.i) in xgStore));
          for (const g of games) todo.push(g);
        } catch (e) {
          if (e.message === 'Cancelado' || e.fatal) throw e;
          badLeagues.push(`${name}: ${e.message}`);
        }
      }
      const badNote = badLeagues.length ? ` Ligas que no se pudieron cargar (${badLeagues.length}): ${badLeagues.join(' · ')}` : '';
      todo.sort((a, b) => b.d - a.d);
      const batch = todo.slice(0, budget);
      if (!batch.length) { valStatus('No quedan partidos sin xG para bajar en las ligas marcadas.' + badNote, badLeagues.length > 0); return; }

      // Paso 2: xG partido por partido. Los que fallan no se guardan, así se reintentan tocando el botón otra vez.
      let idx = 0, got = 0, none = 0, failed = 0;
      valStatus(`Bajando xG… 0/${batch.length}`);
      const worker = async () => {
        while (idx < batch.length && !state.cancel) {
          const g = batch[idx++];
          try {
            const j = await api('/fixtures/statistics', { fixture: g.i });
            const x = X.extractMatchXg(j.response, g.h, g.a);
            if (x.available) { xgStore[String(g.i)] = [x.home, x.away]; got++; } else { xgStore[String(g.i)] = null; none++; }
          } catch (e) { failed++; if (/token|requests|access|plan/i.test(e.message)) state.cancel = true; }
          const done = got + none + failed;
          if (done % 20 === 0) saveXgStore();
          if (done % 5 === 0) valStatus(`Bajando xG… ${done}/${batch.length} · con xG ${got} · sin xG ${none} · con error ${failed}`);
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      saveXgStore();
      leagueHistoryMemo.clear(); // para que el modelo vuelva a armar los partidos con el xG nuevo
      const retry = failed > 0 ? ' Tocá «Bajar xG» otra vez para reintentar los que dieron error.' : ' Ahora corré «Validar» para ver si mejora el modelo.';
      valStatus(`xG: ${got} partidos con xG, ${none} sin xG, ${failed} con error.${retry}${badNote}`, (failed > 0 && got === 0) || badLeagues.length > 0);
    } catch (e) {
      valStatus('No se pudo bajar xG: ' + e.message, true);
    } finally { btn.disabled = false; }
  }

  /* ---- validación ---- */
  async function runValidation() {
    if (!state.key) { valStatus('Primero guardá y probá tu clave de API-Football.', true); return; }
    const comps = selectedComps();
    if (!comps.length) { valStatus('Buscá partidos y marcá al menos una liga en la sección 2.', true); return; }
    state.cancel = false;
    q('#btnValidate').disabled = true;
    try {
      const games = [], seen = new Set();
      for (let i = 0; i < comps.length; i++) {
        valStatus(`Bajando historial de la liga ${i + 1}/${comps.length}…`);
        const h = await loadLeagueHistory(comps[i].lid, comps[i].season);
        for (const g of h.games) { const k = g.id + ':' + g.leagueId; if (!seen.has(k)) { seen.add(k); games.push(g); } }
      }
      const targets = games.filter(g => g.isTarget !== false);
      const withXg = targets.filter(g => isNum(g.xh) && isNum(g.xa)).length;
      const xgCoverage = targets.length ? withXg / targets.length : 0;

      const runCfg = cfg => T.rollingBacktest(games, cfg);
      const results = [];
      const grid = [];
      for (const halfLifeDays of [120, 240, 500]) for (const priorMatches of [8, 14, 25]) grid.push({ halfLifeDays, priorMatches, xgWeight: 0 });
      for (let i = 0; i < grid.length; i++) {
        valStatus(`Probando parámetros ${i + 1}/${grid.length} (cada prueba usa solo partidos anteriores)…`);
        await tick();
        const bt = runCfg(grid[i]);
        if (bt.metrics.count) results.push(Object.assign({}, grid[i], { count: bt.metrics.count, brier: bt.metrics.brier, skill: bt.metrics.skill }));
      }
      let best = bestByBrier(results);
      if (!best) { valStatus('No hay partidos suficientes para evaluar: probá con ligas con más historial.', true); return; }
      let xgNote = 'xG: sin datos descargados (el modelo usa solo goles).';
      if (xgCoverage >= 0.5) {
        const xr = [];
        for (const w of [0.3, 0.6]) {
          valStatus(`Probando mezcla con xG ${Math.round(w * 100)}%…`);
          await tick();
          const cfg = { halfLifeDays: best.halfLifeDays, priorMatches: best.priorMatches, xgWeight: w };
          const bt = runCfg(cfg);
          if (bt.metrics.count) xr.push(Object.assign({}, cfg, { count: bt.metrics.count, brier: bt.metrics.brier, skill: bt.metrics.skill }));
        }
        const bx = bestByBrier(xr);
        if (bx && bx.brier < best.brier - 0.0005) { best = bx; xgNote = `xG mejora el Brier: se usa con peso ${Math.round(bx.xgWeight * 100)}%.`; }
        else xgNote = 'xG probado (cobertura ' + Math.round(xgCoverage * 100) + '%) y NO mejora el Brier: no se usa.';
        results.push(...xr);
      } else if (withXg) xgNote = `xG con cobertura baja (${Math.round(xgCoverage * 100)}%): no se evalúa.`;

      const finalCfg = { halfLifeDays: best.halfLifeDays, priorMatches: best.priorMatches, xgWeight: best.xgWeight || 0 };
      const bt = runCfg(finalCfg);
      const cal = T.validateCalibration(bt.rows);
      const useCal = cal.accepted && cal.calibration;
      const finalMetrics = useCal ? T.scoreRows(bt.rows, r => T.applyCalibration(cal.calibration, r.p)) : bt.metrics;
      const verdict = validationVerdict(finalMetrics);
      const saved = {
        halfLifeDays: finalCfg.halfLifeDays, priorMatches: finalCfg.priorMatches, xgWeight: finalCfg.xgWeight,
        calibration: useCal ? { a: cal.calibration.a, b: cal.calibration.b } : null,
        validated: verdict.validated, validatedAt: Date.now(), n: finalMetrics.count, skill: finalMetrics.skill, brier: finalMetrics.brier,
        leagues: comps.map(c => c.lid)
      };
      LS.set('o05:model:v1', saved);
      renderValidation({ results, finalCfg, finalMetrics, rawMetrics: bt.metrics, cal, useCal, verdict, xgNote, skipped: bt.skipped, comps });
      valStatus(`Validación terminada con ${finalMetrics.count} predicciones. ${verdict.validated ? 'El modelo pasó.' : 'El modelo NO pasó todavía.'}`, !verdict.validated);
    } catch (e) {
      valStatus('No se pudo validar: ' + e.message, true);
    } finally { q('#btnValidate').disabled = false; }
  }

  function renderValidation(v) {
    const m = v.finalMetrics;
    const badge = q('#valBadge');
    if (badge) badge.textContent = v.verdict.validated ? '· validado' : '· NO validado';
    const tune = v.results.slice().sort((a, b) => a.brier - b.brier).slice(0, 6)
      .map(r => `<tr><td>${r.halfLifeDays} d</td><td>${r.priorMatches}</td><td>${Math.round((r.xgWeight || 0) * 100)}%</td><td>${num(r.brier, 4)}</td></tr>`).join('');
    q('#valOut').innerHTML =
      `<div class="val-box"><b>${v.verdict.validated ? 'Resultado: el modelo pasó la validación' : 'Resultado: el modelo NO pasó la validación'}</b><br>` +
      v.verdict.reasons.map(esc).join('<br>') + '<br><br>' +
      `Predicciones evaluadas: <b>${m.count}</b> en ${v.comps.length} liga(s), cada una con un modelo ajustado solo con partidos anteriores.<br>` +
      `Brier ${num(m.brier, 4)} vs tasa base ${num(m.baselineBrier, 4)} · mejora ${num(m.skill * 100, 1)}% · log loss ${num(m.logloss, 4)}<br>` +
      `Promedio predicho ${pct(m.meanP, 1)} vs real ${pct(m.observed, 1)}<br>` +
      `Parámetros elegidos: vida media ${v.finalCfg.halfLifeDays} d, prior ${v.finalCfg.priorMatches} partidos` +
      (v.useCal ? `, calibración logística aplicada (mejoró fuera de muestra).` : (v.cal && v.cal.reason ? '. ' + esc(v.cal.reason) : '.')) +
      `<br>${esc(v.xgNote)}</div>` +
      bandsTable(m.calibration) +
      '<table class="val-table"><tr><th>Vida media</th><th>Prior</th><th>xG</th><th>Brier</th></tr>' + tune + '</table>' +
      '<div class="small">Esta validación mide si las <b>probabilidades</b> son buenas (acierta mejor que la tasa base y se cumplen). No mide ganancia: el ROI real sale del registro propio de abajo, con cuotas guardadas antes de cada partido.</div>';
  }

  /* ---- En Vivo ---- */
  function decorateLive() {
    const lam = LS.get(LAM_KEY, {}) || {};
    document.querySelectorAll('#liveList [data-live-odds]').forEach(btn => {
      const card = btn.closest('.live-expanded');
      if (!card || card.querySelector('.val-live')) return;
      const id = String(btn.dataset.liveOdds);
      const f = (liveState.fixtures || []).find(x => String(x.fixture.id) === id);
      if (!f) return;
      const st = f.fixture.status || {};
      const div = document.createElement('div');
      div.className = 'val-live';
      if (st.short !== '1H') { div.textContent = 'Poisson en vivo: solo se calcula durante el primer tiempo.'; card.appendChild(div); return; }
      const odds = liveState.odds.get(id) || {};
      const h = Number.isInteger(f.goals && f.goals.home) ? f.goals.home : 0, a = Number.isInteger(f.goals && f.goals.away) ? f.goals.away : 0;
      const view = liveView({ lambdaTotal: lam[id] && lam[id].lam, minute: st.elapsed, goalsNow: h + a, odds05: odds.over05 && odds.over05.price, odds10: odds.over10 && odds.over10.price }, T);
      if (!view.ok) { div.textContent = 'Poisson en vivo: ' + view.reason; card.appendChild(div); return; }
      const parts = [];
      const fmt = (label, r) => {
        if (!r) return;
        const ev = r.ev != null ? ` · EV ${(r.ev >= 0 ? '+' : '') + num(r.ev * 100, 1)}%` : ' · sin cuota para comparar';
        parts.push(`<b>${label}</b>: prob ${pct(r.pWin, 1)}${r.pPush > 0.001 ? ' (devolución ' + pct(r.pPush, 0) + ')' : ''} · cuota justa ${r.fairOdds ? num(r.fairOdds) : '—'}${ev}`);
      };
      if (h + a === 0) fmt('Over 0,5 1T', view.over05);
      fmt('Over 1,0 1T', view.over10);
      div.innerHTML = parts.join('<br>') + `<div class="small">Minuto ${st.elapsed}' · λ prepartido ${num(lam[id].lam)} · ritmo ${num(view.remaining.tempo)}. El reparto de goles por tramos del 1T es un supuesto sin validar, y el modelo en vivo no ve tarjetas rojas ni presión: usalo como referencia, no como señal.</div>`;
      card.appendChild(div);
    });
  }
  if (typeof renderLive === 'function') {
    const original = renderLive;
    renderLive = function () { const r = original.apply(this, arguments); try { decorateLive(); } catch (e) { /* la interfaz original sigue funcionando */ } return r; };
  }

  q('#btnValidate').addEventListener('click', runValidation);
  q('#btnXgProbe').addEventListener('click', probeXg);
  q('#btnXgDownload').addEventListener('click', downloadXg);
  q('#btnSettle').addEventListener('click', settleLog);
  q('#btnLogCopy').addEventListener('click', copyLog);
  const cfg0 = LS.get('o05:model:v1', null);
  if (cfg0 && q('#valBadge')) q('#valBadge').textContent = cfg0.validated ? '· validado' : '· NO validado';
  renderLogOut();
})(typeof globalThis !== 'undefined' ? globalThis : this);
