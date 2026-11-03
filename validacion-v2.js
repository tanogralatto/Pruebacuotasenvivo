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
  // market: 'ht05' (por defecto), 'btts' u 'over25'. Los de 90 minutos usan el marcador final reglamentario.
  function settleFromFixture(f, market) {
    const st = f && f.fixture && f.fixture.status && f.fixture.status.short;
    if (VOID_ST.includes(st)) return { status: 'void', reason: st };
    if (!DONE.includes(st)) return { status: 'pending', reason: st || 'sin estado' };
    if (market === 'btts' || market === 'over25') {
      const ft = (f.score && f.score.fulltime) || {};
      if (!isGoals(ft.home) || !isGoals(ft.away)) return { status: 'unverified', reason: 'La API no informó el marcador final.' };
      const y = market === 'btts' ? (ft.home > 0 && ft.away > 0 ? 1 : 0) : (ft.home + ft.away >= 3 ? 1 : 0);
      return { status: 'settled', y, ft: [ft.home, ft.away], source: 'api' };
    }
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
      promisedEv: promised,
      vsMarket: brierVsMarket(settled, T),
      breakdown: roiBreakdown(priced),
      replay: T.kellyStake ? stakeReplay(evPlus, T) : null
    };
  }

  // Brier del modelo y del mercado sin margen, sobre LAS MISMAS predicciones (las que tienen las dos).
  // Si el modelo no queda por debajo del mercado, no le está ganando a las casas.
  function brierVsMarket(settled, T) {
    const both = (settled || []).filter(e => isNum(e.p) && isNum(e.marketProb) && (e.y === 0 || e.y === 1));
    if (!both.length) return { n: 0, model: null, market: null, diff: null };
    const rows = both.map(e => ({ ts: e.ts, p: e.p, mp: e.marketProb, y: e.y }));
    const model = T.scoreRows(rows).brier, market = T.scoreRows(rows, r => r.mp).brier;
    return { n: both.length, model, market, diff: model - market };
  }

  // ROI plano (1u) por rango de EV del modelo, por rango de EV vs mercado y por liga.
  const EV_RANGES = [[-Infinity, 0, 'Negativo'], [0, 0.05, '0–5%'], [0.05, 0.10, '5–10%'], [0.10, 0.15, '10–15%'], [0.15, Infinity, '15% o más']];
  function roiGroup(list) {
    const profit = list.reduce((s, e) => s + (e.y === 1 ? e.odds - 1 : -1), 0);
    return { n: list.length, profit, roi: list.length ? profit / list.length : null, hit: list.length ? list.filter(e => e.y === 1).length / list.length : null };
  }
  function byRange(list, key) {
    return EV_RANGES.map(([lo, hi, label]) => Object.assign({ label }, roiGroup(list.filter(e => isNum(e[key]) && e[key] >= lo && e[key] < hi)))).filter(r => r.n > 0);
  }
  function roiBreakdown(priced) {
    const list = (priced || []).filter(e => isNum(e.odds) && e.odds > 1 && (e.y === 0 || e.y === 1));
    const leagues = new Map();
    for (const e of list) {
      const k = String(e.lid != null ? e.lid : e.ln || '?');
      if (!leagues.has(k)) leagues.set(k, { label: e.ln || ('Liga ' + k), items: [] });
      leagues.get(k).items.push(e);
    }
    const byLeague = [...leagues.values()].map(g => Object.assign({ label: g.label }, roiGroup(g.items))).sort((a, b) => b.n - a.n || b.profit - a.profit);
    return { byEv: byRange(list, 'ev'), byEvMkt: byRange(list, 'evMkt'), byLeague };
  }

  // Qué habría pasado con la banca si se apostaba en cada señal EV+ en orden cronológico:
  // ¼ Kelly (sobre la banca de ese momento) contra stake plano del 1% de la banca inicial.
  // La banca arranca en 1 (= 100%). Partidos del mismo horario se toman uno después del otro (aproximación).
  function stakeReplay(entries, T, opts) {
    const o = Object.assign({ flat: 0.01 }, opts || {});
    const list = (entries || []).filter(e => isNum(e.p) && isNum(e.odds) && e.odds > 1 && (e.y === 0 || e.y === 1))
      .slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const run = stakeOf => {
      let bank = 1, peak = 1, maxDd = 0, bets = 0;
      for (const e of list) {
        const s = stakeOf(e, bank);
        if (!(s > 0)) continue;
        bets++;
        bank += e.y === 1 ? s * (e.odds - 1) : -s;
        peak = Math.max(peak, bank);
        maxDd = Math.max(maxDd, (peak - bank) / peak);
      }
      return { bets, final: bank, maxDrawdown: maxDd };
    };
    const kelly = run((e, bank) => bank * T.kellyStake({ p: e.p, odds: e.odds, marketProb: isNum(e.marketProb) ? e.marketProb : undefined, validated: e.validated !== false }).stake);
    const flat = run(() => o.flat);
    return { n: list.length, kelly, flat };
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
    // seFactor (opcional): con muestras chicas se tolera además el ruido normal (seFactor × error estándar de la banda).
    const tol = b => o.seFactor ? Math.max(o.maxBandGap, o.seFactor * Math.sqrt(b.predicted * (1 - b.predicted) / b.count)) : o.maxBandGap;
    const bad = (metrics.calibration || []).filter(b => b.count >= o.minBand && Math.abs(b.predicted - b.observed) > tol(b));
    if (bad.length) {
      ok = false;
      reasons.push('Bandas mal calibradas: ' + bad.map(b => `${b.range} (dice ${(b.predicted * 100).toFixed(0)}%, ocurre ${(b.observed * 100).toFixed(0)}%)`).join('; ') + '.');
    }
    if (ok) reasons.push('Supera la tasa base y las bandas con muestra suficiente están bien calibradas.');
    return { validated: ok, reasons };
  }

  // Resultado de cada liga por separado (con las mismas predicciones fuera de muestra del backtest).
  // status: 'aprobada' | 'no' | 'faltan' (pocos partidos para decidir).
  // Predicciones "honestas" para juzgar el modelo: para cada partido, tanto la elección de parámetros
  // como la calibración se aprenden SOLO con partidos anteriores (nada aprendido con el resultado que se evalúa).
  //  runs: [{ cfg, rows }] = un backtest por configuración (el primero es la configuración por defecto).
  //  Parámetros: se usa la configuración con menor Brier acumulado en los partidos previos (desde minPrior).
  //  Calibración (si calibrate): se ajusta con los partidos previos ya elegidos (desde minCal, se reajusta cada refit).
  function honestRows(runs, T, opts) {
    const o = Object.assign({ minPrior: 150, minCal: 300, refit: 50, calibrate: false }, opts || {});
    const list = (runs || []).filter(r => r && Array.isArray(r.rows) && r.rows.length);
    if (!list.length) return { rows: [], picks: {} };
    const byId = list.map(r => new Map(r.rows.map(x => [String(x.id) + ':' + x.leagueId, x])));
    const keys = [], seenKey = new Set();
    for (const r of list) for (const x of r.rows) { const k = String(x.id) + ':' + x.leagueId; if (!seenKey.has(k)) { seenKey.add(k); keys.push({ k, ts: x.ts }); } }
    keys.sort((a, b) => a.ts - b.ts);
    const sum = list.map(() => 0), cnt = list.map(() => 0), picks = {};
    const chosen = [];
    let i = 0;
    while (i < keys.length) {
      // Los partidos del mismo momento se deciden juntos, con lo conocido antes de ese momento.
      let j = i;
      while (j < keys.length && keys[j].ts === keys[i].ts) j++;
      const group = keys.slice(i, j);
      for (const { k } of group) {
        let best = -1, bestB = Infinity;
        for (let c = 0; c < list.length; c++) {
          if (!byId[c].has(k)) continue;
          if (best < 0) best = c; // primera disponible (por defecto)
          if (cnt[c] >= o.minPrior && sum[c] / cnt[c] < bestB) { bestB = sum[c] / cnt[c]; best = c; }
        }
        if (best < 0) continue;
        const row = byId[best].get(k);
        chosen.push(Object.assign({}, row, { cfgIndex: best }));
        picks[best] = (picks[best] || 0) + 1;
      }
      for (const { k } of group) for (let c = 0; c < list.length; c++) {
        const x = byId[c].get(k);
        if (x && isNum(x.p) && (x.y === 0 || x.y === 1)) { sum[c] += (x.p - x.y) ** 2; cnt[c]++; }
      }
      i = j;
    }
    if (o.calibrate) {
      let cal = null, lastFit = -Infinity, k = 0;
      while (k < chosen.length) {
        let m = k;
        while (m < chosen.length && chosen[m].ts === chosen[k].ts) m++;
        if (k >= o.minCal && k - lastFit >= o.refit) { cal = T.fitCalibration(chosen.slice(0, k).map(r => ({ p: r.pModel != null ? r.pModel : r.p, y: r.y }))); lastFit = k; }
        for (let t = k; t < m; t++) { chosen[t].pModel = chosen[t].p; if (cal) chosen[t].p = T.applyCalibration(cal, chosen[t].p); }
        k = m;
      }
    }
    return { rows: chosen, picks };
  }

  // Confianza en que la mejora sea real y no suerte: z = mejora / error estándar.
  const confidenceOf = (skill, se) => !isNum(skill) || !isNum(se) || !(se > 0) ? null : skill / se >= 1.64 ? 'alta' : skill / se >= 1 ? 'media' : 'baja';

  // Nombres de país en castellano (la API los da en inglés). Los que no están se muestran como vienen.
  const COUNTRY_ES = { Spain: 'España', England: 'Inglaterra', Italy: 'Italia', Germany: 'Alemania', France: 'Francia', Netherlands: 'Países Bajos',
    Portugal: 'Portugal', Belgium: 'Bélgica', Scotland: 'Escocia', Wales: 'Gales', Turkey: 'Turquía', Greece: 'Grecia', Switzerland: 'Suiza', Austria: 'Austria',
    Denmark: 'Dinamarca', Sweden: 'Suecia', Norway: 'Noruega', Finland: 'Finlandia', Poland: 'Polonia', 'Czech-Republic': 'Chequia', Croatia: 'Croacia',
    Serbia: 'Serbia', Russia: 'Rusia', Ukraine: 'Ucrania', Romania: 'Rumania', Ireland: 'Irlanda', Argentina: 'Argentina', Brazil: 'Brasil', Uruguay: 'Uruguay',
    Paraguay: 'Paraguay', Chile: 'Chile', Peru: 'Perú', Bolivia: 'Bolivia', Ecuador: 'Ecuador', Colombia: 'Colombia', Venezuela: 'Venezuela', Mexico: 'México',
    USA: 'Estados Unidos', 'Costa-Rica': 'Costa Rica', Japan: 'Japón', 'South-Korea': 'Corea del Sur', China: 'China', Australia: 'Australia',
    'Saudi-Arabia': 'Arabia Saudita', Egypt: 'Egipto', Morocco: 'Marruecos', World: 'Internacional', Mundo: 'Internacional' };
  const countryEs = c => COUNTRY_ES[c] || String(c || '').replace(/-/g, ' ');
  const CONF_LABEL = { alta: '🟢 Alta', media: '🟡 Media', baja: '🔴 Baja' };
  const LEAGUE_RULES = { minN: 100, minSkill: 0.01, maxBandGap: 0.07, minBand: 30, seFactor: 2, minZ: 1.64 };
  function leagueVerdicts(rows, T, pick) {
    const byLeague = new Map();
    for (const r of rows || []) { const k = String(r.leagueId); if (!byLeague.has(k)) byLeague.set(k, []); byLeague.get(k).push(r); }
    const out = {};
    for (const [lid, list] of byLeague) {
      const m = T.scoreRows(list, pick);
      const bands = (m.calibration || []).filter(b => b.count >= LEAGUE_RULES.minBand);
      const gap = bands.length ? Math.max(...bands.map(b => Math.abs(b.predicted - b.observed))) : null;
      const confidence = confidenceOf(m.skill, m.skillSe);
      let status;
      if (m.count < LEAGUE_RULES.minN) status = 'faltan';
      else {
        const v = validationVerdict(m, LEAGUE_RULES);
        // Además de mejorar 1% o más, la mejora tiene que ser difícil de explicar por suerte (confianza alta).
        status = v.validated && confidence === 'alta' ? 'aprobada' : 'no';
      }
      out[lid] = { lid, status, n: m.count, skill: m.skill, skillSe: m.skillSe, confidence, brier: m.brier, meanP: m.meanP, observed: m.observed, gap };
    }
    return out;
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

  const LV_KEY = 'o05:leagueval:v1';
  const pure = { settleFromFixture, chunk, summarizeLog, brierVsMarket, roiBreakdown, stakeReplay, honestRows, confidenceOf, validationVerdict, leagueVerdicts, bestByBrier, liveView, pruneLog, LOG_KEY, LAM_KEY, LV_KEY };
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
  const MKT_NAME = { ht05: '+0,5 1T', btts: 'Ambos marcan', over25: '+2,5 goles' };
  const mktOf = e => (e && e.market) || 'ht05';
  // Clave del registro: +0,5 1T usa el id del partido (como siempre); los otros mercados, "id:mercado".
  const logId = (fid, market) => !market || market === 'ht05' ? String(fid) : String(fid) + ':' + market;
  root.logPredictions = function (results, market) {
    market = market || 'ht05';
    const log = readLog(), now = nowSec();
    let added = 0;
    for (const r of results || []) {
      const p = r && r.poisson;
      if (!p || !p.ok || !r.fx) continue;
      const ts = Math.floor(Date.parse(r.fx.iso) / 1000);
      if (!Number.isFinite(ts) || now >= ts) continue; // nunca se registra con el partido iniciado
      const id = logId(r.fx.id, market), prev = log[id];
      if (prev && (prev.y === 0 || prev.y === 1)) continue;
      const d = p.decision || {};
      log[id] = {
        id, fid: String(r.fx.id), market, ts, lid: r.fx.lid, season: r.fx.season, hid: r.fx.hid, aid: r.fx.aid, hn: r.fx.hn, an: r.fx.an, ln: r.fx.ln,
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
    try { renderLeagueVal(); if (added) renderLogOut(); } catch (e) {}
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
    const fidOf = e => String(e.fid || e.id);
    for (const ids of chunk([...new Set(pending.map(fidOf))], 20)) {
      try {
        const j = await api('/fixtures', { ids: ids.join('-'), timezone: TZ });
        const byId = new Map((j.response || []).map(f => [String(f.fixture.id), f]));
        for (const e of pending.filter(x => ids.includes(fidOf(x)))) {
          const id = e.id, f = byId.get(fidOf(e));
          if (!f) { left++; continue; }
          const s = settleFromFixture(f, mktOf(e));
          if (s.status === 'settled') { log[id].y = s.y; if (s.ht) log[id].ht = s.ht; if (s.ft) log[id].ft = s.ft; log[id].htSource = s.source; log[id].settledAt = now; settled++; }
          else if (s.status === 'void') { log[id].void = true; voided++; }
          else left++;
        }
      } catch (e) { valStatus('Error al liquidar: ' + e.message, true); writeLog(log); return; }
    }
    writeLog(log);
    valStatus(`Liquidación lista: ${settled} resueltas, ${voided} anuladas/suspendidas, ${left} todavía pendientes o sin marcador.`);
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
    const all = Object.values(readLog());
    if (!all.length) {
      box.innerHTML = '<div class="val-box"><b>Registro propio vacío.</b> Cada vez que analizás partidos con cuota, la predicción se guarda antes del inicio. Después tocá «Liquidar registro» para medir resultados reales.</div>';
      return;
    }
    // Un bloque por mercado, porque cada uno gana o pierde por su lado.
    box.innerHTML = Object.keys(MKT_NAME).map(mk => {
      const list = all.filter(e => mktOf(e) === mk);
      return list.length ? logBlock(summarizeLog(list, T), MKT_NAME[mk]) : '';
    }).join('');
  }
  function logBlock(s, title) {
    const m = s.metrics;
    return '<div class="val-box"><b>Registro propio · ' + esc(title) + ' (predicciones guardadas antes del partido)</b><br>' +
      `Liquidadas: <b>${s.settled}</b> · pendientes: <b>${s.pending}</b>` +
      (m.count ? `<br>Brier ${num(m.brier, 4)} (tasa base ${num(m.baselineBrier, 4)}) · mejora sobre la base ${num(m.skill * 100, 1)}% · promedio predicho ${pct(m.meanP, 1)} vs real ${pct(m.observed, 1)}` : '') +
      '</div>' + (m.count ? bandsTable(m.calibration) : '') +
      '<table class="val-table"><tr><th>Apuestas (1u, cuota guardada)</th><th>N</th><th>Aciertos</th><th>ROI</th></tr>' +
      roiLine('Todas con cuota', s.all) + roiLine('EV+ posible o sólido', s.evPlus) + roiLine('EV+ sólido', s.evSolid) + '</table>' +
      (s.promisedEv != null ? `<div class="small">El modelo prometía un EV promedio de ${(s.promisedEv >= 0 ? '+' : '') + num(s.promisedEv * 100, 1)}% en las señales EV+. Si el ROI real queda muy por debajo, el modelo está sobreestimando.</div>` : '') +
      vsMarketHtml(s.vsMarket) + breakdownHtml(s.breakdown) + replayHtml(s.replay) +
      '<div class="small">Con pocas decenas de apuestas el ROI es puro ruido: hacen falta cientos para sacar conclusiones.</div>';
  }
  function vsMarketHtml(v) {
    if (!v || !v.n) return '<div class="val-box"><b>¿Le gana el modelo a las casas?</b><br>Todavía no hay predicciones liquidadas con probabilidad del mercado guardada.</div>';
    const better = v.diff < 0;
    return '<div class="val-box"><b>¿Le gana el modelo a las casas?</b> (Brier: más bajo = mejor)<br>' +
      `Sobre las mismas ${v.n} predicciones: modelo <b>${num(v.model, 4)}</b> · mercado sin margen <b>${num(v.market, 4)}</b><br>` +
      `<span style="color:${better ? 'var(--c4)' : 'var(--c1)'}">${better ? '✅ El modelo acierta mejor que el mercado.' : '❌ El mercado acierta mejor que el modelo: las señales que solo ve el modelo no son confiables.'}</span>` +
      (v.n < 300 ? '<br><span class="small">Con menos de 300 casos la diferencia todavía puede ser casualidad.</span>' : '') + '</div>';
  }
  function groupTable(title, rows) {
    if (!rows || !rows.length) return '';
    return `<table class="val-table"><tr><th>${esc(title)}</th><th>N</th><th>Aciertos</th><th>ROI</th></tr>` +
      rows.map(r => roiLine(esc(r.label), r)).join('') + '</table>';
  }
  function breakdownHtml(b) {
    if (!b || !(b.byEv.length || b.byEvMkt.length)) return '';
    return '<details class="val-box"><summary><b>¿Dónde se gana y dónde se pierde?</b> (desglose del ROI)</summary>' +
      groupTable('Por EV del modelo', b.byEv) + groupTable('Por EV vs mercado (sin margen)', b.byEvMkt) + groupTable('Por liga', b.byLeague) +
      '<div class="small">Sirve para ver si hay un rango de EV o una liga donde la ganancia se repite. Ojo: con grupos chicos (menos de ~50) los números saltan mucho por azar.</div></details>';
  }
  function replayHtml(r) {
    if (!r || !r.n) return '';
    const fmt = x => (x.final >= 1 ? '+' : '') + num((x.final - 1) * 100, 1) + '%';
    const row = (label, x) => `<tr><td>${label}</td><td>${x.bets}</td><td style="color:${x.final >= 1 ? 'var(--c4)' : 'var(--c1)'}">${fmt(x)}</td><td>−${num(x.maxDrawdown * 100, 1)}%</td></tr>`;
    return '<div class="val-box"><b>Simulación de la banca con tus señales EV+</b><br>' +
      '<table class="val-table"><tr><th>Método</th><th>Apuestas</th><th>Resultado banca</th><th>Peor caída</th></tr>' +
      row('¼ Kelly (stake sugerido)', r.kelly) + row('Plano 1% de la banca', r.flat) + '</table>' +
      '<div class="small">Se repasan en orden las predicciones EV+ ya liquidadas, como si hubieras apostado en todas. «Peor caída» es lo máximo que bajó la banca desde su punto más alto. Kelly apuesta más cuando la ventaja es más grande y menos cuando es chica.</div></div>';
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
      // Si la API frena por consultas por minuto, toda la descarga se pausa un minuto, sigue más despacio
      // y el partido vuelve a la cola (hasta MAX_PAUSES pausas, para no quedar trabada para siempre).
      const MAX_PAUSES = 15, PAUSE_MS = 65000;
      const queue = batch.slice(), tries = new Map();
      let got = 0, none = 0, failed = 0, pauses = 0, inFlight = 0, pauseUntil = 0, workers = 4, lastError = '';
      const progress = () => `${got + none + failed}/${batch.length} · con xG ${got} · sin xG ${none} · con error ${failed}`;
      const isRateLimit = m => /limit|minuto|too many/i.test(m) && !/day|día/i.test(m);
      valStatus(`Bajando xG… ${progress()}`);
      const worker = async n => {
        while ((queue.length || inFlight) && !state.cancel) {
          if (n >= workers) return; // después de una pausa siguen menos pedidos en paralelo
          const wait = pauseUntil - Date.now();
          if (wait > 0) { await sleep(Math.min(wait, 1000)); continue; }
          if (!queue.length) { await sleep(200); continue; } // otro pedido en curso puede devolver su partido a la cola
          const g = queue.shift();
          inFlight++;
          try {
            const j = await api('/fixtures/statistics', { fixture: g.i });
            const x = X.extractMatchXg(j.response, g.h, g.a);
            if (x.available) { xgStore[String(g.i)] = [x.home, x.away]; got++; } else { xgStore[String(g.i)] = null; none++; }
          } catch (e) {
            lastError = e.message;
            if (e.fatal || (/token|requests|access|plan/i.test(e.message) && !isRateLimit(e.message))) { state.cancel = true; failed++; continue; }
            const t = (tries.get(g.i) || 0) + 1;
            if (isRateLimit(e.message) && pauses < MAX_PAUSES && t <= 3) {
              tries.set(g.i, t);
              queue.push(g);
              if (pauseUntil <= Date.now()) {
                pauses++;
                pauseUntil = Date.now() + PAUSE_MS;
                workers = Math.max(1, workers - 1);
                saveXgStore();
                valStatus(`La API pidió frenar (límite por minuto). Pausa de 1 minuto y sigo sola, más despacio… ${progress()}`);
              }
              continue;
            }
            failed++;
          } finally { inFlight--; }
          const done = got + none + failed;
          if (done % 20 === 0) saveXgStore();
          if (done % 5 === 0 && pauseUntil <= Date.now()) valStatus(`Bajando xG… ${progress()}`);
        }
      };
      await Promise.all(Array.from({ length: 4 }, (_, n) => worker(n)));
      saveXgStore();
      leagueHistoryMemo.clear(); // para que el modelo vuelva a armar los partidos con el xG nuevo
      const left = batch.length - got - none - failed;
      const errNote = lastError && (failed > 0 || left > 0) ? ` Último error de la API: «${lastError}».` : '';
      const leftNote = left > 0 ? ` Quedaron ${left} sin intentar.` : '';
      const retry = failed > 0 || left > 0 ? ' Tocá «Bajar xG» otra vez para seguir con los que faltan.' : ' Ahora corré «Validar» para ver si mejora el modelo.';
      valStatus(`xG: ${got} partidos con xG, ${none} sin xG, ${failed} con error.${leftNote}${retry}${errNote}${badNote}`, (failed > 0 && got === 0) || badLeagues.length > 0);
    } catch (e) {
      valStatus('No se pudo bajar xG: ' + e.message, true);
    } finally { btn.disabled = false; }
  }

  /* ---- validación ---- */
  async function runValidation() {
    if (!state.key) { valStatus('Primero guardá y probá tu clave de API-Football.', true); return; }
    const comps = selectedComps();
    if (!comps.length) { valStatus('Buscá partidos y marcá al menos una liga en la sección 2.', true); return; }
    const market = MKT_NAME[state.market] ? state.market : 'ht05', ft = market !== 'ht05';
    state.cancel = false;
    q('#btnValidate').disabled = true;
    try {
      const games = [], seen = new Set();
      for (let i = 0; i < comps.length; i++) {
        valStatus(`Bajando historial de la liga ${i + 1}/${comps.length}…`);
        const h = await loadLeagueHistory(comps[i].lid, comps[i].season);
        // También se evalúa la temporada pasada (cada partido se predice solo con partidos anteriores),
        // así las ligas europeas, que llevan pocas fechas, tienen muestra suficiente para decidir.
        for (const g of (ft ? h.gamesFT || [] : h.games)) { const k = g.id + ':' + g.leagueId; if (!seen.has(k)) { seen.add(k); games.push(Object.assign({}, g, { isTarget: true })); } }
      }
      const targets = games.filter(g => g.isTarget !== false);
      const withXg = targets.filter(g => isNum(g.xh) && isNum(g.xa)).length;
      const xgCoverage = targets.length ? withXg / targets.length : 0;

      const runCfg = cfg => T.rollingBacktest(games, Object.assign({ market }, cfg));
      const results = [];
      const runs = []; // cada backtest, para el juicio honesto (ver honestRows)
      const grid = [{ halfLifeDays: T.DEFAULTS.halfLifeDays, priorMatches: T.DEFAULTS.priorMatches, xgWeight: 0 }]; // la de siempre primero
      for (const halfLifeDays of [120, 240, 500]) for (const priorMatches of [8, 14, 25]) if (!(halfLifeDays === grid[0].halfLifeDays && priorMatches === grid[0].priorMatches)) grid.push({ halfLifeDays, priorMatches, xgWeight: 0 });
      for (let i = 0; i < grid.length; i++) {
        valStatus(`Probando parámetros ${i + 1}/${grid.length} (cada prueba usa solo partidos anteriores)…`);
        await tick();
        const bt = runCfg(grid[i]);
        if (bt.metrics.count) { results.push(Object.assign({}, grid[i], { count: bt.metrics.count, brier: bt.metrics.brier, skill: bt.metrics.skill })); runs.push({ cfg: grid[i], rows: bt.rows }); }
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
          if (bt.metrics.count) { xr.push(Object.assign({}, cfg, { count: bt.metrics.count, brier: bt.metrics.brier, skill: bt.metrics.skill })); runs.push({ cfg, rows: bt.rows }); }
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
      // Juicio honesto: parámetros y calibración elegidos partido a partido solo con lo anterior.
      // (finalCfg y cal.calibration, aprendidos con todo, son los que se usan de acá en adelante.)
      const honest = honestRows(runs, T, { calibrate: !!useCal });
      const finalMetrics = T.scoreRows(honest.rows);
      const verdict = validationVerdict(finalMetrics);
      const saved = {
        halfLifeDays: finalCfg.halfLifeDays, priorMatches: finalCfg.priorMatches, xgWeight: finalCfg.xgWeight,
        calibration: useCal ? { a: cal.calibration.a, b: cal.calibration.b } : null,
        validated: verdict.validated, validatedAt: Date.now(), n: finalMetrics.count, skill: finalMetrics.skill, brier: finalMetrics.brier,
        leagues: comps.map(c => c.lid)
      };
      if (!ft) LS.set('o05:model:v1', saved); // ajuste general de +0,5 1T (para ligas sin validar)
      // Se suma a la lista de ligas validadas: las ligas de esta prueba se actualizan, las demás quedan como estaban.
      const per = leagueVerdicts(honest.rows, T);
      const names = new Map((state.fixtures || []).map(f => [String(f.lid), f.ln]));
      const countries = new Map((state.fixtures || []).map(f => [String(f.lid), f.lc]));
      const lv = readLv(market), stamp = Date.now();
      const cfgSaved = { halfLifeDays: saved.halfLifeDays, priorMatches: saved.priorMatches, xgWeight: saved.xgWeight, calibration: saved.calibration };
      for (const c of comps) {
        const k = String(c.lid), r = per[k] || { lid: k, status: 'faltan', n: 0, skill: null, brier: null, meanP: null, observed: null, gap: null };
        lv[k] = Object.assign({}, r, { name: names.get(k) || (lv[k] && lv[k].name) || 'Liga ' + k, country: countries.get(k) || (lv[k] && lv[k].country) || '', cfg: cfgSaved, validatedAt: stamp });
      }
      LS.set(lvKeyOf(market), lv);
      renderLeagueVal();
      renderValidation({ results, finalCfg, finalMetrics, rawMetrics: bt.metrics, cal, useCal, verdict, xgNote, skipped: bt.skipped, comps });
      const okNow = comps.filter(c => per[String(c.lid)] && per[String(c.lid)].status === 'aprobada').length;
      valStatus(`Validación de ${MKT_NAME[market]} terminada: ${okNow} de ${comps.length} liga(s) aprobada(s). Mirá la tabla «Ligas validadas».`, okNow === 0);
    } catch (e) {
      valStatus('No se pudo validar: ' + e.message, true);
    } finally { q('#btnValidate').disabled = false; }
  }

  /* ---- ligas validadas (se van sumando) ---- */
  const curMarket = () => (typeof state !== 'undefined' && MKT_NAME[state.market]) ? state.market : 'ht05';
  const lvKeyOf = market => !market || market === 'ht05' ? LV_KEY : 'o05:leagueval:' + market + ':v1';
  function readLv(market) { const m = LS.get(lvKeyOf(market), null); return m && typeof m === 'object' ? m : {}; }
  // La validación del 31/10 fue conjunta (sin detalle por liga): esas ligas quedan aprobadas como «prueba conjunta».
  function migrateLv() {
    const lv = readLv(), old = LS.get('o05:model:v1', null);
    if (Object.keys(lv).length || !old || !Array.isArray(old.leagues) || !old.leagues.length) return;
    const names = new Map((state.fixtures || []).map(f => [String(f.lid), f.ln]));
    const cfg = { halfLifeDays: old.halfLifeDays, priorMatches: old.priorMatches, xgWeight: old.xgWeight || 0, calibration: old.calibration || null };
    for (const id of old.leagues) {
      const k = String(id);
      lv[k] = { lid: k, name: names.get(k) || 'Liga ' + k, status: old.validated ? 'conjunta' : 'no', n: null, skill: null, gap: null, cfg, validatedAt: old.validatedAt || 0 };
    }
    LS.set(LV_KEY, lv);
  }
  const ST_LABEL = { aprobada: '✅ Aprobada', revalidar: '🔄 Volver a validar', no: '❌ No aprobada', faltan: '⏳ Faltan datos' };
  const ST_ORDER = { aprobada: 0, revalidar: 1, faltan: 2, no: 3 };
  function renderLeagueVal() {
    migrateLv();
    const market = curMarket(), key = lvKeyOf(market);
    const lv0 = readLv(market), names = new Map((state.fixtures || []).map(f => [String(f.lid), f.ln]));
    let renamed = false;
    for (const e of Object.values(lv0)) if (/^Liga \d+$/.test(e.name || '') && names.has(String(e.lid))) { e.name = names.get(String(e.lid)); renamed = true; }
    const countries = new Map((state.fixtures || []).map(f => [String(f.lid), f.lc]));
    for (const e of Object.values(lv0)) if (!e.country && countries.get(String(e.lid))) { e.country = countries.get(String(e.lid)); renamed = true; }
    if (renamed) LS.set(key, lv0);
    const lv = readLv(market), box = q('#leagueValOut');
    // Aprobadas con el método anterior (sin «Confianza»): no cuentan como aprobadas hasta volver a validarlas.
    const list = Object.values(lv).map(e => Object.assign({}, e, { status: (e.status === 'aprobada' || e.status === 'conjunta') && !e.confidence ? 'revalidar' : e.status }));
    const ok = list.filter(e => e.status === 'aprobada').length;
    const toRedo = list.filter(e => e.status === 'revalidar').length;
    const badge = q('#valBadge');
    if (badge) badge.textContent = list.length ? `· ${MKT_NAME[market]}: ${ok} liga(s) aprobada(s)` : `· ${MKT_NAME[market]}: sin validar`;
    if (!box) return;
    if (!list.length) { box.innerHTML = `<div class="val-box"><b>Ligas validadas para ${MKT_NAME[market]}: ninguna todavía.</b> Marcá ligas en la sección 2 y tocá «Validar». Cada mercado se valida por separado (arriba elegís el mercado).</div>`; return; }
    // Mejor calibrada primero: aprobadas arriba, y dentro de cada grupo la que más mejora sobre la tasa base.
    list.sort((a, b) => (ST_ORDER[a.status] - ST_ORDER[b.status]) || ((b.skill ?? -9) - (a.skill ?? -9)));
    const rows = list.map(e => `<tr><td>${e.country ? esc(countryEs(e.country)) : '—'}</td><td>${esc(e.name || 'Liga ' + e.lid)}</td><td>${ST_LABEL[e.status] || esc(e.status)}</td>` +
      `<td>${e.n == null ? '—' : e.n}</td>` +
      `<td>${isNum(e.skill) ? (e.skill >= 0 ? '+' : '') + num(e.skill * 100, 1) + '%' : '—'}</td>` +
      `<td>${CONF_LABEL[e.confidence] || '—'}</td>` +
      `<td>${isNum(e.meanP) && isNum(e.observed) ? pct(e.meanP, 0) + ' / ' + pct(e.observed, 0) : '—'}</td>` +
      `<td>${isNum(e.gap) ? num(e.gap * 100, 1) + ' pts' : '—'}</td>` +
      `<td>${e.validatedAt ? new Date(e.validatedAt).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }) : '—'}</td></tr>`).join('');
    const hasJoint = list.some(e => e.status === 'conjunta');
    box.innerHTML = `<div class="val-box"><b>Ligas validadas para ${MKT_NAME[market]}: ${ok} aprobada(s) de ${list.length}</b><br>` +
      'Cada vez que tocás «Validar», las ligas marcadas se suman o se actualizan acá, solo para el mercado elegido arriba. Las demás no se tocan. ' +
      'En las ligas sin aprobar, el EV+ aparece como «provisorio».</div>' +
      '<table class="val-table"><tr><th>País</th><th>Liga</th><th>Estado</th><th>Partidos</th><th>Mejora</th><th>Confianza</th><th>Dice / pasa</th><th>Desvío</th><th>Fecha</th></tr>' + rows + '</table>' +
      '<div class="small"><b>Mejora</b>: cuánto acierta mejor que adivinar con el promedio de goles (más alto = mejor). ' +
      '<b>Confianza</b>: si la mejora es real o puede ser suerte, según cuántos partidos hay (alta = casi seguro que es real; media = puede ser; baja = puede ser pura casualidad). ' +
      '<b>Dice / pasa</b>: lo que la app predijo en promedio y lo que pasó. <b>Desvío</b>: la mayor diferencia en algún grupo de partidos (más bajo = mejor calibrada). ' +
      `Para aprobar, una liga necesita al menos ${LEAGUE_RULES.minN} partidos evaluados, mejora de 1% o más con confianza alta y un desvío chico (hasta ${Math.round(LEAGUE_RULES.maxBandGap * 100)} pts, un poco más si el grupo tiene pocos partidos, porque ahí la suerte pesa más).` +
      (toRedo ? ` <b>${toRedo} liga(s) dicen «Volver a validar»: se aprobaron con el método anterior, que era más generoso, y mientras tanto se tratan como no aprobadas. Marcalas en el Escáner y tocá «Validar».</b>` : '') +
      (hasJoint ? ' Las de «prueba conjunta» se aprobaron todas juntas el ' + new Date(list.find(e => e.status === 'conjunta').validatedAt).toLocaleDateString('es-AR') + ': si las volvés a validar, vas a ver el detalle de cada una.' : '') + '</div>';
  }
  root.tanoRenderLeagueVal = renderLeagueVal;

  function renderValidation(v) {
    const m = v.finalMetrics;
    const tune = v.results.slice().sort((a, b) => a.brier - b.brier).slice(0, 6)
      .map(r => `<tr><td>${r.halfLifeDays} d</td><td>${r.priorMatches}</td><td>${Math.round((r.xgWeight || 0) * 100)}%</td><td>${num(r.brier, 4)}</td></tr>`).join('');
    q('#valOut').innerHTML =
      `<div class="val-box"><b>${v.verdict.validated ? 'Todas las ligas de esta prueba juntas: pasó' : 'Todas las ligas de esta prueba juntas: NO pasó'}</b><br>` +
      v.verdict.reasons.map(esc).join('<br>') + '<br><br>' +
      `Predicciones evaluadas: <b>${m.count}</b> en ${v.comps.length} liga(s). Cada una se juzga con un modelo, parámetros y calibración elegidos solo con partidos anteriores.<br>` +
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
  renderLeagueVal();
  root.tanoRenderLog = renderLogOut;
  renderLogOut();
})(typeof globalThis !== 'undefined' ? globalThis : this);
