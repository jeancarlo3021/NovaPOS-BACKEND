/**
 * Estado de autenticación de Baileys guardado en SUPABASE.
 * Así la sesión sobrevive reinicios/redeploys SIN depender de un volumen en disco.
 *
 * UNA FILA POR LLAVE (tabla wa_auth_keys), no un blob único.
 *
 * Antes todo —credenciales MÁS todas las llaves de señal— era un solo JSON en
 * wa_sessions.data, y guardar UNA llave nueva reescribía el blob COMPLETO. Ese
 * blob solo crece: llegó a 950 KB, así que cada llave costaba un megabyte de
 * escritura para persistir doscientos bytes.
 *
 * Y Baileys guarda llaves todo el tiempo: cada mensaje, cada pre-key, cada
 * sesión nueva. Cada reescritura deja otra versión de la fila en el WAL, y con
 * eso una base de 184 MB generaba ~50 MB de WAL entre checkpoints. La
 * decodificación lógica de Realtime tardaba 13 segundos en masticarlo, el disco
 * quedó saturado, y en una instancia de 1 GB la memoria comprometida llegó a
 * 1,21 GB: el login dejó de responder (504/522 en /auth/v1/token).
 *
 * Ahora cada llave es su propia fila y guardar una llave escribe una fila chica.
 * En wa_sessions quedan SOLO las credenciales, que son unos pocos KB y cambian
 * poco.
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

/**
 * Los tipos de llave que usa Baileys.
 *
 * Hacen falta para partir las claves del formato viejo ('tipo-id'), porque el id
 * también trae guiones: 'session-50688887777@s.whatsapp.net.0'. Cortar en el
 * primer guion rompería 'pre-key', 'sender-key' y 'app-state-sync-key'.
 */
const TIPOS_CONOCIDOS = [
  'app-state-sync-key',
  'app-state-sync-version',
  'sender-key-memory',
  'sender-key',
  'pre-key',
  'session',
];

/** Tabla de llaves, una fila por llave. */
const TABLA_LLAVES = 'wa_auth_keys';

/** PostgREST devuelve 1000 filas por vuelta; las llaves se leen por páginas. */
const PAGINA = 1000;

/** La clave con la que una llave vive en memoria. Igual que la de Baileys. */
const enMemoria = (type, id) => `${type}-${id}`;

/**
 * ¿El error dice que la tabla de llaves todavía no existe?
 *
 * Las migraciones acá se corren a mano, así que el worker tiene que arrancar
 * aunque la 154 no esté puesta: si falta la tabla, sigue con el blob viejo. Es
 * más lento, pero una sesión de WhatsApp que no levanta deja al negocio sin
 * avisos, y eso es peor.
 */
const faltaLaTabla = (error) => {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  const t = `${error.message ?? ''} ${error.details ?? ''} ${error.hint ?? ''}`.toLowerCase();
  return /does not exist|could not find the table|schema cache/.test(t)
    && t.includes(TABLA_LLAVES);
};

export async function useSupabaseAuthState(supabase, sessionId = 'colonclick', table = 'wa_sessions') {
  /* ── Las credenciales (y, si viene del formato viejo, las llaves) ───────── */
  const leerBlob = async () => {
    const { data, error } = await supabase.from(table).select('data').eq('id', sessionId).maybeSingle();
    if (error || !data?.data) return null;
    try { return JSON.parse(data.data, BufferJSON.reviver); } catch { return null; }
  };

  const guardarCreds = async (creds) => {
    const payload = JSON.stringify({ creds }, BufferJSON.replacer);
    await supabase.from(table).upsert({ id: sessionId, data: payload, updated_at: new Date().toISOString() });
  };

  /* ── Las llaves, una fila cada una ─────────────────────────────────────── */

  /** Lee TODAS las llaves de la sesión. En memoria para que `get` siga siendo síncrono. */
  const leerLlaves = async () => {
    const out = {};
    for (let desde = 0; ; desde += PAGINA) {
      const { data, error } = await supabase
        .from(TABLA_LLAVES)
        .select('key_type,key_id,value')
        .eq('session_id', sessionId)
        .range(desde, desde + PAGINA - 1);
      if (error) {
        if (faltaLaTabla(error)) return null;         // sin tabla: se usa el blob
        throw error;
      }
      for (const fila of data ?? []) {
        try {
          out[enMemoria(fila.key_type, fila.key_id)] = JSON.parse(fila.value, BufferJSON.reviver);
        } catch { /* una llave ilegible se descarta: Baileys la vuelve a pedir */ }
      }
      if (!data || data.length < PAGINA) break;
    }
    return out;
  };

  /**
   * Escribe SOLO las llaves que cambiaron.
   *
   * `cambios` es `{ 'type-id': valor|null }`. Un valor nulo borra la fila, que es
   * como Baileys descarta una pre-key ya consumida.
   */
  const guardarLlaves = async (cambios) => {
    const aEscribir = [];
    /** Los borrados se agrupan por tipo para mandar un DELETE por tipo, no uno por llave. */
    const aBorrar = new Map();

    for (const [type, porId] of Object.entries(cambios)) {
      for (const [id, value] of Object.entries(porId)) {
        if (value) {
          aEscribir.push({
            session_id: sessionId,
            key_type: type,
            key_id: id,
            value: JSON.stringify(value, BufferJSON.replacer),
            updated_at: new Date().toISOString(),
          });
        } else {
          if (!aBorrar.has(type)) aBorrar.set(type, []);
          aBorrar.get(type).push(id);
        }
      }
    }

    if (aEscribir.length) {
      const { error } = await supabase
        .from(TABLA_LLAVES)
        .upsert(aEscribir, { onConflict: 'session_id,key_type,key_id' });
      if (error) return error;
    }
    for (const [type, ids] of aBorrar) {
      const { error } = await supabase
        .from(TABLA_LLAVES)
        .delete()
        .eq('session_id', sessionId)
        .eq('key_type', type)
        .in('key_id', ids);
      if (error) return error;
    }
    return null;
  };

  /* ── Arranque ──────────────────────────────────────────────────────────── */

  const blob = await leerBlob();
  const creds = blob?.creds || initAuthCreds();

  let llaves = await leerLlaves();

  /**
   * Sin tabla de llaves: modo blob, como antes. Es el camino lento, y avisa por
   * qué, para que no quede en silencio esperando que alguien lo note en la
   * factura del disco.
   */
  const modoBlob = llaves === null;
  if (modoBlob) {
    console.warn(
      `[wa] la tabla ${TABLA_LLAVES} no existe todavía: la sesión sigue guardándose `
      + 'como un blob único (lento, reescribe ~1 MB por llave). '
      + 'Corré la migración 154_wa_auth_keys.sql para arreglarlo.',
    );
    llaves = blob?.keys || {};
  }

  /**
   * MIGRACIÓN SOLA, UNA VEZ.
   *
   * Si el blob todavía traía llaves adentro, se reparten en wa_auth_keys y el
   * blob se deja con las credenciales nada más. Pasa sin desvincular el número:
   * las llaves son las mismas, solo cambian de lugar.
   */
  if (!modoBlob && blob?.keys && Object.keys(blob.keys).length) {
    const porTipo = {};
    for (const [clave, value] of Object.entries(blob.keys)) {
      if (!value) continue;
      /* La clave es 'tipo-id', y el id TAMBIÉN trae guiones
         ('session-50688887777@s.whatsapp.net.0'), así que se parte contra la
         lista de tipos conocidos y no por el primer guion. */
      let type = null; let id = null;
      for (const t of TIPOS_CONOCIDOS) {
        if (clave.startsWith(`${t}-`)) { type = t; id = clave.slice(t.length + 1); break; }
      }
      if (type === null) {
        /* Tipo desconocido: se corta en el primer guion. Peor caso, Baileys vuelve
           a pedir esa llave; no se pierde la sesión. */
        const i = clave.indexOf('-');
        if (i <= 0) continue;
        type = clave.slice(0, i);
        id = clave.slice(i + 1);
      }
      if (!porTipo[type]) porTipo[type] = {};
      porTipo[type][id] = value;
    }
    const cuantas = Object.values(porTipo).reduce((n, o) => n + Object.keys(o).length, 0);
    const error = await guardarLlaves(porTipo);
    if (error) {
      console.warn('[wa] no se pudieron migrar las llaves al formato por fila:', error.message ?? error);
    } else {
      /* Las llaves ya están a salvo en su tabla: recién ahí se aliviana el blob. */
      await guardarCreds(creds);
      console.log(`[wa] ${cuantas} llaves pasadas a ${TABLA_LLAVES}; wa_sessions queda solo con las credenciales.`);
    }
  }

  /** Guardar las credenciales ya NO arrastra las llaves. */
  const saveCreds = () => guardarCreds(creds);

  return {
    state: {
      creds,
      keys: {
        get: (type, ids) => {
          const out = {};
          for (const id of ids) {
            let value = llaves[enMemoria(type, id)];
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            out[id] = value;
          }
          return out;
        },
        set: async (data) => {
          /* Memoria primero: `get` es síncrono y Baileys puede pedir una llave
             en la misma vuelta en que la guardó. */
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              const clave = enMemoria(type, id);
              if (value) llaves[clave] = value;
              else delete llaves[clave];
            }
          }
          if (modoBlob) {
            /* Camino viejo: el blob entero. Solo cuando falta la migración. */
            const payload = JSON.stringify({ creds, keys: llaves }, BufferJSON.replacer);
            await supabase.from(table).upsert({ id: sessionId, data: payload, updated_at: new Date().toISOString() });
            return;
          }
          const error = await guardarLlaves(data);
          if (error) console.warn('[wa] no se pudo guardar una llave:', error.message ?? error);
        },
      },
    },
    saveCreds,
    /** Borra la sesión (al desvincular / logout): credenciales y llaves. */
    clear: async () => {
      try { await supabase.from(table).delete().eq('id', sessionId); } catch { /* ignore */ }
      try { await supabase.from(TABLA_LLAVES).delete().eq('session_id', sessionId); } catch { /* ignore */ }
      llaves = {};
    },
  };
}

