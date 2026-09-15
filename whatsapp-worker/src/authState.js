/**
 * Estado de autenticación de Baileys guardado en SUPABASE (tabla wa_sessions).
 * Así la sesión sobrevive reinicios/redeploys SIN depender de un volumen en disco.
 *
 * Guarda todo (creds + keys) como un único blob JSON por sesión, serializado con
 * BufferJSON (maneja los Buffers de las llaves de señal). Patrón estándar de
 * Baileys (initAuthCreds / BufferJSON / proto).
 */
import * as baileys from '@whiskeysockets/baileys';

/**
 * Baileys se importa como ESPACIO DE NOMBRES completo.
 *
 * `initAuthCreds`, `BufferJSON` y `proto` son exports CON NOMBRE, pero acá se
 * sacaban del export por defecto —que es `makeWASocket`, una función— y quedaban
 * en `undefined`. El worker moría con «initAuthCreds is not a function», y solo
 * por el camino de Supabase: con la sesión en disco nunca se tocaba este archivo.
 *
 * Se leen de los dos lados porque el empaquetado cambia entre versiones.
 */
const api = {
  ...(baileys.default && typeof baileys.default !== 'undefined' ? baileys.default : {}),
  ...baileys,
};
const initAuthCreds = api.initAuthCreds;
const BufferJSON = api.BufferJSON;
const proto = api.proto;

if (typeof initAuthCreds !== 'function') {
  throw new Error(
    'No se encontró initAuthCreds en @whiskeysockets/baileys. '
    + 'Revisá la versión instalada del paquete en whatsapp-worker.',
  );
}

export async function useSupabaseAuthState(supabase, sessionId = 'colonclick', table = 'wa_sessions') {
  const loadRaw = async () => {
    const { data, error } = await supabase.from(table).select('data').eq('id', sessionId).maybeSingle();
    if (error || !data?.data) return null;
    try { return JSON.parse(data.data, BufferJSON.reviver); } catch { return null; }
  };

  const persist = async (obj) => {
    const payload = JSON.stringify(obj, BufferJSON.replacer);
    await supabase.from(table).upsert({ id: sessionId, data: payload, updated_at: new Date().toISOString() });
  };

  const saved = await loadRaw();
  const creds = saved?.creds || initAuthCreds();
  const keys = saved?.keys || {};

  const saveState = () => persist({ creds, keys });

  return {
    state: {
      creds,
      keys: {
        get: (type, ids) => {
          const out = {};
          for (const id of ids) {
            let value = keys[`${type}-${id}`];
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            out[id] = value;
          }
          return out;
        },
        set: async (data) => {
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              const key = `${type}-${id}`;
              if (value) keys[key] = value;
              else delete keys[key];
            }
          }
          await saveState();
        },
      },
    },
    saveCreds: saveState,
    /** Borra la sesión (al desvincular / logout). */
    clear: async () => { try { await supabase.from(table).delete().eq('id', sessionId); } catch { /* ignore */ } },
  };
}
