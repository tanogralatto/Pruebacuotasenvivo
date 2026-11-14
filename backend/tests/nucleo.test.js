import test from 'node:test';
import assert from 'node:assert/strict';
import { investigar, analizar, limpiarAnalisis, validarPartido, validarPaquete, clienteDePrueba, ErrorPedido, MAX_PAQUETE } from '../nucleo.js';

const partido = { local: 'Casa Pia', visitante: 'Santa Clara', liga: 'Primeira Liga', pais: 'Portugal', fecha: '2026-11-14 13:30' };

test('el ajuste se acota a ±5 puntos y solo vale con mercado conocido', () => {
  const base = { sintesis: 's', factores: [], advertencias: [], calidad_datos: 'alta' };
  assert.equal(limpiarAnalisis({ ...base, ajuste: { aplica: true, mercado: 'visitante', puntos: 40, motivo: 'm' } }).ajuste.puntos, 5);
  assert.equal(limpiarAnalisis({ ...base, ajuste: { aplica: true, mercado: 'local', puntos: -12, motivo: 'm' } }).ajuste.puntos, -5);
  const raro = limpiarAnalisis({ ...base, ajuste: { aplica: true, mercado: 'corners', puntos: 3, motivo: 'm' } }).ajuste;
  assert.deepEqual([raro.aplica, raro.mercado, raro.puntos], [false, 'ninguno', 0]);
  const sin = limpiarAnalisis({ ...base, ajuste: { aplica: false, mercado: 'local', puntos: 3, motivo: '' } }).ajuste;
  assert.deepEqual([sin.aplica, sin.puntos], [false, 0]);
  assert.equal(limpiarAnalisis({}).calidad_datos, 'media');
});

test('se rechazan partidos incompletos y paquetes enormes', () => {
  assert.throws(() => validarPartido({ local: 'A' }), ErrorPedido);
  assert.throws(() => validarPaquete({ x: 'a'.repeat(MAX_PAQUETE) }), ErrorPedido);
  assert.equal(validarPartido(partido).local, 'Casa Pia');
});

test('investigar devuelve el texto final y las fuentes', async () => {
  const r = await investigar(clienteDePrueba(), 'claude-opus-5-5', partido);
  assert.match(r.resumen, /^BAJAS LOCAL/);
  assert.match(r.resumen, /\nBAJAS VISITANTE/);
  assert.deepEqual(r.fuentes, [{ url: 'https://example.com/previa', titulo: 'Previa de ejemplo' }]);
  assert.equal(r.uso.busquedas, 2);
});

test('investigar sigue cuando la búsqueda se pausa y usa las citas como fuentes', async () => {
  let n = 0; const pedidos = [];
  const cliente = { beta: { messages: { async create(p) {
    pedidos.push(p); n++;
    if (n === 1) return { model: 'm', stop_reason: 'pause_turn', usage: { input_tokens: 10, output_tokens: 1 }, content: [
      { type: 'web_search_tool_result', content: [{ url: 'https://a.com/1', title: 'No citada' }] }] };
    return { model: 'm', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, content: [
      { type: 'text', text: 'BAJAS LOCAL: Fulano.', citations: [{ type: 'web_search_result_location', url: 'https://b.com/2', title: 'Citada' }] }] };
  } } } };
  const r = await investigar(cliente, 'claude-haiku-5-5', partido);
  assert.equal(n, 2);
  assert.equal(pedidos[1].messages.length, 2);
  assert.equal(pedidos[0].tools[0].type, 'web_search_20250305');
  assert.equal(pedidos[0].fallbacks, 'default');
  assert.deepEqual(r.fuentes.map(f => f.url), ['https://b.com/2']);
  assert.equal(r.uso.entrada, 20);
});

test('si la cuenta no acepta fallbacks, se repite el pedido sin esa opción', async () => {
  const pedidos = [];
  const cliente = { beta: { messages: { async create(p) {
    pedidos.push(p);
    if (p.fallbacks) throw Object.assign(new Error('fallbacks: not supported'), { status: 400 });
    return clienteDePrueba().beta.messages.create(p);
  } } } };
  const r = await analizar(cliente, 'claude-opus-5-5', { partido }, 'nada');
  assert.equal(pedidos.length, 2);
  assert.equal(pedidos[1].betas, undefined);
  assert.equal(pedidos[1].output_config.format.type, 'json_schema');
  assert.equal(r.analisis.ajuste.aplica, false);
});

test('una respuesta que no es JSON da un error claro', async () => {
  const cliente = { beta: { messages: { async create() { return { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'hola' }] }; } } } };
  await assert.rejects(() => analizar(cliente, 'm', { a: 1 }, ''), /formato esperado/);
});
