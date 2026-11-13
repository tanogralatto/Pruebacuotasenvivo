// Lógica del servicio sin la parte de red: validar lo que llega, llamar a Claude y ordenar lo que vuelve.
// Está separada de server.js para poder probarla con un cliente de mentira (tests/ y MOCK=1).
import { SYS_INVESTIGAR, SYS_ANALIZAR, ESQUEMA_ANALISIS, mensajeInvestigar, mensajeAnalizar } from './prompts.js';

export const MAX_PAQUETE = 24000;      // caracteres del paquete de datos
export const MAX_INVESTIGACION = 6000; // caracteres del resumen de investigación que se reenvía
const BETA_FALLBACK = 'server-side-fallback-2026-07-01';

export class ErrorPedido extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const texto = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0009\u000b-\u001f]+/g, ' ').trim().slice(0, max);

export function validarPartido(p) {
  if (!p || typeof p !== 'object') throw new ErrorPedido('Falta el partido.');
  const out = { local: texto(p.local, 80), visitante: texto(p.visitante, 80), liga: texto(p.liga, 100), pais: texto(p.pais, 60), fecha: texto(p.fecha, 60) };
  if (!out.local || !out.visitante || !out.liga) throw new ErrorPedido('Faltan los equipos o la competición.');
  return out;
}

export function validarPaquete(paquete) {
  if (!paquete || typeof paquete !== 'object' || Array.isArray(paquete)) throw new ErrorPedido('Falta el paquete de datos.');
  const n = JSON.stringify(paquete).length;
  if (n > MAX_PAQUETE) throw new ErrorPedido('El paquete de datos es demasiado grande (' + n + ' caracteres).', 413);
  return paquete;
}

// El ajuste que propone Claude se acota acá, pase lo que pase en la respuesta.
export function limpiarAnalisis(a) {
  const MERCADOS = ['local', 'empate', 'visitante', 'mas25', 'ambos_marcan'];
  const aj = (a && a.ajuste) || {};
  let puntos = Number(aj.puntos);
  if (!Number.isFinite(puntos)) puntos = 0;
  puntos = Math.max(-5, Math.min(5, Math.round(puntos * 10) / 10));
  const aplica = aj.aplica === true && MERCADOS.includes(aj.mercado) && puntos !== 0;
  return {
    sintesis: texto(a && a.sintesis, 2500),
    factores: (Array.isArray(a && a.factores) ? a.factores : []).slice(0, 6).map(f => ({
      titulo: texto(f && f.titulo, 80), detalle: texto(f && f.detalle, 600),
      efecto: ['favorece_local', 'favorece_visitante', 'mas_goles', 'menos_goles', 'neutro'].includes(f && f.efecto) ? f.efecto : 'neutro'
    })),
    ajuste: { aplica, mercado: aplica ? aj.mercado : 'ninguno', puntos: aplica ? puntos : 0, motivo: texto(aj.motivo, 500) },
    advertencias: (Array.isArray(a && a.advertencias) ? a.advertencias : []).slice(0, 8).map(x => texto(x, 400)).filter(Boolean),
    calidad_datos: ['alta', 'media', 'baja'].includes(a && a.calidad_datos) ? a.calidad_datos : 'media'
  };
}

function sumarUso(acum, usage) {
  if (!usage) return acum;
  acum.entrada += (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  acum.salida += usage.output_tokens || 0;
  acum.busquedas += (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
  return acum;
}

// Una llamada a Claude. Si un filtro de seguridad rechaza el pedido, la API reintenta sola con otro modelo
// (fallbacks). Si la cuenta no acepta esa opción, se repite el pedido sin ella.
async function llamar(cliente, params) {
  try {
    return await cliente.beta.messages.create({ ...params, betas: [BETA_FALLBACK], fallbacks: 'default' });
  } catch (e) {
    if (e && e.status === 400 && /fallback/i.test(String(e.message))) return cliente.beta.messages.create(params);
    throw e;
  }
}

const textoDe = contenido => contenido.filter(b => b.type === 'text').map(b => b.text).join('');

// Paso 1: investigación con búsqueda web.
export async function investigar(cliente, modelo, partido) {
  const p = validarPartido(partido);
  // Los modelos Haiku usan la versión básica de la herramienta de búsqueda.
  const tipo = /haiku/i.test(modelo) ? 'web_search_20250305' : 'web_search_20260209';
  const mensajes = [{ role: 'user', content: mensajeInvestigar(p) }];
  const uso = { entrada: 0, salida: 0, busquedas: 0 };
  let resp = null;
  const bloques = []; // todo lo que devolvió Claude, sumando las vueltas si la búsqueda se pausó
  for (let vuelta = 0; vuelta < 4; vuelta++) {
    resp = await llamar(cliente, {
      model: modelo, max_tokens: 8000, system: SYS_INVESTIGAR,
      tools: [{ type: tipo, name: 'web_search', max_uses: 4 }],
      messages: mensajes
    });
    sumarUso(uso, resp.usage);
    bloques.push(...resp.content);
    // La búsqueda corre del lado de Anthropic; si se pausa, se reenvía lo que lleva para que siga.
    if (resp.stop_reason !== 'pause_turn') break;
    mensajes.push({ role: 'assistant', content: resp.content });
  }
  if (resp.stop_reason === 'refusal') throw new ErrorPedido('Claude no quiso responder este pedido.', 422);

  // El resumen es el texto del final, después de la última búsqueda.
  const finales = [];
  for (let i = bloques.length - 1; i >= 0; i--) {
    const b = bloques[i];
    if (b.type === 'text') finales.unshift(b);
    else if (b.type !== 'thinking' && b.type !== 'redacted_thinking') break;
  }
  const resumen = texto(textoDe(finales) || textoDe(bloques), MAX_INVESTIGACION);

  // Fuentes: primero las que Claude citó; si no citó ninguna, las primeras que devolvió la búsqueda.
  const fuentes = [], vistas = new Set();
  const agregar = (url, titulo) => {
    if (!/^https?:\/\//i.test(url || '') || vistas.has(url) || fuentes.length >= 6) return;
    vistas.add(url); fuentes.push({ url, titulo: texto(titulo || url, 140) });
  };
  for (const b of bloques) if (b.type === 'text') for (const c of b.citations || []) if (c.type === 'web_search_result_location') agregar(c.url, c.title);
  if (!fuentes.length) for (const b of bloques) if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) agregar(r.url, r.title);

  return { resumen: resumen || 'Sin información confirmada.', fuentes, uso, modelo: resp.model };
}

// Paso 2: análisis con salida en formato fijo.
export async function analizar(cliente, modelo, paquete, investigacion) {
  validarPaquete(paquete);
  const resp = await llamar(cliente, {
    model: modelo, max_tokens: 8000, system: SYS_ANALIZAR,
    output_config: { format: { type: 'json_schema', schema: ESQUEMA_ANALISIS } },
    messages: [{ role: 'user', content: mensajeAnalizar(paquete, texto(investigacion, MAX_INVESTIGACION)) }]
  });
  if (resp.stop_reason === 'refusal') throw new ErrorPedido('Claude no quiso responder este pedido.', 422);
  if (resp.stop_reason === 'max_tokens') throw new ErrorPedido('La respuesta quedó cortada. Probá de nuevo.', 502);
  let crudo;
  try { crudo = JSON.parse(textoDe(resp.content)); }
  catch (e) { throw new ErrorPedido('La respuesta de Claude no vino en el formato esperado.', 502); }
  return { analisis: limpiarAnalisis(crudo), uso: sumarUso({ entrada: 0, salida: 0, busquedas: 0 }, resp.usage), modelo: resp.model };
}

// Cliente de mentira (MOCK=1): responde al instante y sin gastar, para probar la app completa.
export function clienteDePrueba() {
  const usage = { input_tokens: 1200, output_tokens: 300 };
  return { beta: { messages: { async create(params) {
    if (params.tools) {
      return { model: 'prueba', stop_reason: 'end_turn', usage: { ...usage, server_tool_use: { web_search_requests: 2 } }, content: [
        { type: 'server_tool_use', id: 'x', name: 'web_search', input: { query: 'bajas' } },
        { type: 'web_search_tool_result', tool_use_id: 'x', content: [{ type: 'web_search_result', url: 'https://example.com/previa', title: 'Previa de ejemplo' }] },
        { type: 'text', text: 'BAJAS LOCAL: sin información confirmada (respuesta de prueba).\nBAJAS VISITANTE: sin información confirmada.\nALINEACIONES: sin confirmar.\nCONTEXTO: modo de prueba, no se consultó la web.\nDUDAS: todo.' }
      ] };
    }
    return { model: 'prueba', stop_reason: 'end_turn', usage, content: [{ type: 'text', text: JSON.stringify({
      sintesis: 'Respuesta de prueba: el servicio funciona, pero no se llamó a Claude. Los números de arriba son los de tu modelo.',
      factores: [{ titulo: 'Modo de prueba', detalle: 'Este texto lo genera el servicio sin usar IA.', efecto: 'neutro' }],
      ajuste: { aplica: false, mercado: 'ninguno', puntos: 0, motivo: '' },
      advertencias: ['Modo de prueba activo (MOCK=1).'], calidad_datos: 'media'
    }) }] };
  } } } };
}
