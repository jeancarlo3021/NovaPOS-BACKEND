import { Hono } from 'hono';
import { db } from '../db/client.js';
import { ok, fail } from '../utils/response.js';

/**
 * Guardar un PDF y devolver un enlace https para abrirlo.
 *
 * Existe por la app de Android: adentro del WebView, la descarga clásica (el
 * `<a download>` que usa jsPDF) no hace NADA — ni descarga ni error, el usuario
 * toca «Descargar» y no pasa nada. En cambio un enlace https se abre en el
 * navegador del teléfono, que sí sabe descargar y compartir.
 *
 * El archivo va a un bucket privado y se entrega con un enlace firmado que
 * caduca: una proforma o una factura no deberían quedar públicas en internet.
 */
const sharedDocs = new Hono<{ Variables: { userId: string; tenantId: string; role: string } }>();

const BUCKET = 'shared-docs';
/** Un día alcanza para descargarlo y mandarlo por WhatsApp; después, se vence. */
const TTL_SEGUNDOS = 24 * 60 * 60;
/** Tope de tamaño: un PDF de estos pesa decenas de KB; 12 MB es de sobra. */
const MAX_BYTES = 12 * 1024 * 1024;

async function asegurarBucket() {
  // `createBucket` falla si ya existe: eso no es un error, es el caso normal.
  try { await db.storage.createBucket(BUCKET, { public: false }); } catch { /* ya existe */ }
}

// POST / — { filename, content_base64 } → { url, expires_in }
sharedDocs.post('/', async (c) => {
  try {
    const tenantId = c.get('tenantId');
    if (!tenantId) return fail(c, 'Sin negocio asignado', 403);

    const body = await c.req.json().catch(() => ({} as any));
    const filename = String(body?.filename ?? '').trim() || 'documento.pdf';
    const b64 = String(body?.content_base64 ?? '');
    if (!b64) return fail(c, 'Falta el contenido del archivo', 422);

    const bytes = Buffer.from(b64, 'base64');
    if (!bytes.length) return fail(c, 'El archivo llegó vacío', 422);
    if (bytes.length > MAX_BYTES) return fail(c, 'El archivo es demasiado grande', 413);

    // Nombre saneado: lo que llega es texto del cliente y termina en una ruta.
    const limpio = filename.replace(/[^\w.\- ]+/g, '_').slice(0, 80);
    const uuid = (globalThis.crypto as any)?.randomUUID?.()
      ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
    const path = `${tenantId}/${uuid}-${limpio}`;

    await asegurarBucket();
    const { error: upErr } = await db.storage.from(BUCKET)
      .upload(path, bytes, { contentType: 'application/pdf', upsert: false });
    if (upErr) throw new Error(upErr.message);

    const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, TTL_SEGUNDOS);
    if (error || !data?.signedUrl) throw new Error(error?.message || 'No se pudo firmar el enlace');

    return ok(c, { url: data.signedUrl, expires_in: TTL_SEGUNDOS });
  } catch (err: any) { return fail(c, err.message, 500); }
});

export default sharedDocs;
