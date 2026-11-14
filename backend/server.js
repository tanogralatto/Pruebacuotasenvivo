// TanoApp IA — servicio que llama a Claude. Corre en Render.
// Existe para que la clave de Anthropic no esté en la página (cualquiera podría copiarla) y para que
// solo las cuentas de Google autorizadas puedan gastar.
//
// Variables de entorno (se cargan en Render, nunca en el repositorio):
//   ANTHROPIC_API_KEY  clave de la cuenta de Anthropic (obligatoria salvo con MOCK=1)
//   ALLOWED_EMAILS     mails de Google autorizados, separados por coma (obligatoria)
//   CLAUDE_MODEL       modelo a usar (por defecto claude-opus-5-5)
//   ALLOWED_ORIGINS    páginas que pueden llamar al servicio (por defecto https://tanogralatto.github.io)
//   FIREBASE_PROJECT   proyecto de Firebase del inicio de sesión (por defecto appuestasclaude)
//   MAX_DIARIO         tope de llamadas a Claude por día (por defecto 60)
//   MOCK=1             responde sin llamar a Claude (para probar sin gastar)
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { investigar, analizar, clienteDePrueba, ErrorPedido } from './nucleo.js';

const env = process.env;
const MOCK = env.MOCK === '1';
const MODELO = env.CLAUDE_MODEL || 'claude-opus-5-5';
const PROYECTO = env.FIREBASE_PROJECT || 'appuestasclaude';
const ORIGENES = (env.ALLOWED_ORIGINS || 'https://tanogralatto.github.io').split(',').map(s => s.trim()).filter(Boolean);
const MAILS = (env.ALLOWED_EMAILS || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
const MAX_DIARIO = Number(env.MAX_DIARIO) > 0 ? Number(env.MAX_DIARIO) : 60;
const PUERTO = Number(env.PORT) || 10000;

const cliente = MOCK ? clienteDePrueba() : (env.ANTHROPIC_API_KEY ? new Anthropic() : null);

// Las sesiones de Google (Firebase) vienen firmadas; se verifican con las claves públicas de Google.
const CLAVES_GOOGLE = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));
async function usuarioDe(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) throw new ErrorPedido('Falta iniciar sesión.', 401);
  let datos;
  try {
    ({ payload: datos } = await jwtVerify(m[1], CLAVES_GOOGLE, { issuer: 'https://securetoken.google.com/' + PROYECTO, audience: PROYECTO }));
  } catch (e) { throw new ErrorPedido('La sesión no es válida o venció. Volvé a entrar.', 401); }
  const mail = String(datos.email || '').toLowerCase();
  if (!mail || datos.email_verified !== true || !MAILS.includes(mail)) throw new ErrorPedido('Esta cuenta no está autorizada a usar el análisis con IA.', 403);
  return mail;
}

// Tope diario de llamadas: protege el gasto. Se guarda en memoria, así que vuelve a cero si el servicio se reinicia.
const tope = { dia: '', n: 0 };
function contar() {
  const hoy = new Date().toISOString().slice(0, 10);
  if (tope.dia !== hoy) { tope.dia = hoy; tope.n = 0; }
  if (tope.n >= MAX_DIARIO) throw new ErrorPedido('Se alcanzó el tope de ' + MAX_DIARIO + ' llamadas a la IA por hoy.', 429);
  tope.n++;
}

function leerJson(req, max = 60000) {
  return new Promise((resolve, reject) => {
    let largo = 0; const partes = [];
    req.on('data', c => { largo += c.length; if (largo > max) { reject(new ErrorPedido('Pedido demasiado grande.', 413)); req.destroy(); } else partes.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(partes).toString('utf8') || '{}')); } catch (e) { reject(new ErrorPedido('El pedido no es JSON válido.')); } });
    req.on('error', reject);
  });
}

// Mensajes de error de Claude en palabras simples.
function errorDeClaude(e) {
  if (e instanceof Anthropic.AuthenticationError) return ['La clave de Anthropic no es válida. Revisala en Render.', 502];
  if (e instanceof Anthropic.PermissionDeniedError) return ['La cuenta de Anthropic no tiene permiso para este modelo.', 502];
  if (e instanceof Anthropic.NotFoundError) return ['El modelo configurado (' + MODELO + ') no existe para esta cuenta.', 502];
  if (e instanceof Anthropic.RateLimitError) return ['Claude está limitando los pedidos. Esperá un minuto y probá de nuevo.', 503];
  if (e instanceof Anthropic.BadRequestError) return [/credit|billing/i.test(e.message) ? 'La cuenta de Anthropic no tiene saldo.' : 'Claude rechazó el pedido: ' + e.message, 502];
  if (e instanceof Anthropic.APIConnectionError) return ['No se pudo conectar con Claude. Probá de nuevo.', 503];
  if (e instanceof Anthropic.APIError) return ['Claude devolvió un error (' + (e.status || '?') + '). Probá de nuevo.', 503];
  return null;
}

const servidor = http.createServer(async (req, res) => {
  const origen = req.headers.origin;
  const cab = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin' };
  if (origen && ORIGENES.includes(origen)) {
    cab['Access-Control-Allow-Origin'] = origen;
    cab['Access-Control-Allow-Headers'] = 'authorization, content-type';
    cab['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    cab['Access-Control-Max-Age'] = '86400';
  }
  const responder = (status, cuerpo) => { res.writeHead(status, cab); res.end(JSON.stringify(cuerpo)); };
  const ruta = new URL(req.url, 'http://x').pathname;
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, cab); return res.end(); }
    if (req.method === 'GET' && (ruta === '/' || ruta === '/salud')) {
      return responder(200, { ok: true, servicio: 'tanoapp-ia', ia: !!cliente, prueba: MOCK, modelo: MOCK ? 'prueba' : MODELO, autorizados: MAILS.length });
    }
    if (req.method === 'POST' && (ruta === '/investigar' || ruta === '/analizar')) {
      const mail = await usuarioDe(req);
      if (!cliente) throw new ErrorPedido('Falta cargar la clave de Anthropic (ANTHROPIC_API_KEY) en Render.', 503);
      const cuerpo = await leerJson(req);
      contar();
      const t0 = Date.now();
      const out = ruta === '/investigar'
        ? await investigar(cliente, MODELO, cuerpo.partido)
        : await analizar(cliente, MODELO, cuerpo.paquete, cuerpo.investigacion);
      console.log(`${ruta} ${mail.replace(/^(..).*(@.*)$/, '$1…$2')} ${Date.now() - t0} ms entrada=${out.uso.entrada} salida=${out.uso.salida} busquedas=${out.uso.busquedas}`);
      return responder(200, { ok: true, ...out, restantesHoy: MAX_DIARIO - tope.n });
    }
    responder(404, { ok: false, error: 'No existe esa ruta.' });
  } catch (e) {
    if (e instanceof ErrorPedido) return responder(e.status, { ok: false, error: e.message });
    const c = errorDeClaude(e);
    if (c) { console.error(ruta, e.status || '', e.message); return responder(c[1], { ok: false, error: c[0] }); }
    console.error(ruta, e);
    responder(500, { ok: false, error: 'Error interno del servicio.' });
  }
});

servidor.listen(PUERTO, () => {
  console.log(`TanoApp IA en el puerto ${PUERTO} · modelo ${MOCK ? 'prueba' : MODELO} · ${MAILS.length} cuenta(s) autorizada(s) · tope ${MAX_DIARIO}/día`);
  if (!cliente) console.warn('Falta ANTHROPIC_API_KEY: el análisis no va a funcionar hasta cargarla.');
  if (!MAILS.length) console.warn('Falta ALLOWED_EMAILS: nadie está autorizado.');
});
