// Contador de consultas a API-Football por cuenta de Google (index-v2 y Alpha).
// Se acumula en memoria y se anota en Firestore (tanoapp_api_uso/{día}_{uid}) cada 30 minutos
// y cuando la app pasa a segundo plano o se cierra: pocas escrituras, ninguna lectura.
// De la clave solo se guardan los últimos 4 caracteres, para saber qué clave se usó.
import { doc, setDoc, increment, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const TZ = 'America/Argentina/Buenos_Aires';
const FLUSH_MS = 30 * 60 * 1000;
export const usageDay = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ });

export function startApiUsage(db, auth, appName) {
  let pending = {}, timer = null;
  async function flush() {
    clearTimeout(timer); timer = null;
    const u = auth.currentUser;
    if (!u || !Object.keys(pending).length) return;
    const batch = pending; pending = {};
    for (const [k, n] of Object.entries(batch)) {
      const [day, last4] = k.split('|');
      try {
        await setDoc(doc(db, 'tanoapp_api_uso', day + '_' + u.uid), {
          uid: u.uid, email: u.email || '', date: day, count: increment(n),
          claves: { [last4]: increment(n) }, apps: { [appName]: increment(n) }, updated: serverTimestamp()
        }, { merge: true });
      } catch (e) {
        pending[k] = (pending[k] || 0) + n; // se reintenta en la próxima anotación
        console.warn('No se pudo anotar el uso de la API', e);
      }
    }
  }
  window.tanoCountApi = key => {
    const last4 = String(key || '').trim().slice(-4) || 'sin clave';
    const k = usageDay() + '|' + last4;
    pending[k] = (pending[k] || 0) + 1;
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('pagehide', flush);
  return { flush };
}
