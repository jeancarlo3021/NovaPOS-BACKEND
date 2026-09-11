/**
 * Correo del comprobante electrónico que recibe el CLIENTE del negocio.
 *
 * Lo manda el negocio, no el sistema: el cliente tiene que reconocer de un
 * vistazo quién le factura, qué documento es y cuánto pagó. Antes era una lista
 * de datos sueltos sin el nombre del negocio, y en «Consecutivo» salía el id
 * interno del proveedor en vez del número que reconoce Hacienda.
 *
 * HTML para correo: tablas y estilos en línea, sin flexbox ni CSS externo —
 * es lo único que Gmail, Outlook y los clientes de celular pintan igual.
 *
 * Función PURA: recibe los datos ya cargados y devuelve el HTML. Así se puede
 * probar sin base de datos ni proveedor.
 */
export interface DatosCorreoComprobante {
  negocio: {
    nombre: string;              // comercial si hay; si no, la razón social
    razonSocial?: string | null;
    cedula?: string | null;
    telefono?: string | null;
    correo?: string | null;
    direccion?: string | null;
    logoUrl?: string | null;     // solo https: los data: los bloquean los clientes de correo
  };
  numero: string;                // N° interno de la venta
  clave: string;                 // 50 dígitos
  estado?: string | null;        // accepted | rejected | sent
  cliente?: string | null;
  fecha?: string | null;         // ISO
  subtotal?: number | null;
  impuesto?: number | null;
  total: number;
  lineas?: Array<{ nombre: string; cantidad: number; precio: number; importe: number }>;
  /** Se adjuntó el XML firmado (y respuesta de Hacienda / PDF si vinieron). */
  adjuntos?: { xml: boolean; respuesta: boolean; pdf: boolean };
}

const esc = (v: any) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const crc = (n: any) => `₡${Number(n || 0).toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cant = (n: any) => Number(n || 0).toLocaleString('es-CR', { maximumFractionDigits: 3 });

/** Tipo de documento según la clave (posiciones 30-31): es lo que Hacienda recibió. */
export function tipoDeClave(clave: string): string {
  const t = String(clave ?? '').replace(/\D/g, '').slice(29, 31);
  return t === '01' ? 'Factura electrónica'
    : t === '02' ? 'Nota de débito electrónica'
    : t === '03' ? 'Nota de crédito electrónica'
    : t === '04' ? 'Tiquete electrónico'
    : 'Comprobante electrónico';
}

/** Consecutivo de Hacienda (20 dígitos) embebido en la clave, posiciones 22-41. */
export function consecutivoDeClave(clave: string): string | null {
  const d = String(clave ?? '').replace(/\D/g, '');
  return d.length === 50 ? d.slice(21, 41) : null;
}

/** La clave partida en bloques de 10: leída de corrido no se puede copiar ni dictar. */
function claveEnBloques(clave: string): string {
  const d = String(clave ?? '').replace(/\D/g, '');
  return d.length === 50 ? (d.match(/.{1,10}/g) ?? [d]).join(' ') : esc(clave);
}

function fechaLarga(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(String(iso).length <= 10 ? `${iso}T12:00:00` : String(iso));
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('es-CR', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function comprobanteEmailAsunto(d: DatosCorreoComprobante): string {
  return `${tipoDeClave(d.clave)} ${d.numero} · ${d.negocio.nombre}`;
}

export function comprobanteEmailHtml(d: DatosCorreoComprobante): string {
  const tipo = tipoDeClave(d.clave);
  const consecutivo = consecutivoDeClave(d.clave);
  const fecha = fechaLarga(d.fecha);
  const n = d.negocio;

  const estado = d.estado === 'accepted'
    ? { txt: 'Aceptado por Hacienda', bg: '#ecfdf5', fg: '#047857', borde: '#a7f3d0' }
    : d.estado === 'rejected'
      ? { txt: 'Rechazado por Hacienda', bg: '#fef2f2', fg: '#b91c1c', borde: '#fecaca' }
      : { txt: 'En proceso en Hacienda', bg: '#fffbeb', fg: '#b45309', borde: '#fde68a' };

  // Logo solo si es una dirección pública: los clientes de correo bloquean las
  // imágenes incrustadas, y un recuadro roto se ve peor que no tener logo.
  const logo = n.logoUrl && /^https:\/\//i.test(n.logoUrl)
    ? `<img src="${esc(n.logoUrl)}" alt="${esc(n.nombre)}" height="48" style="display:block;height:48px;max-width:180px;border:0;margin:0 0 12px;">`
    : '';

  const fila = (etiqueta: string, valor: string | null | undefined, mono = false) => valor
    ? `<tr>
         <td style="padding:7px 0;color:#6b7280;font-size:13px;width:38%;vertical-align:top;">${etiqueta}</td>
         <td style="padding:7px 0;color:#111827;font-size:13px;text-align:right;${mono ? 'font-family:Consolas,Menlo,monospace;' : ''}">${valor}</td>
       </tr>`
    : '';

  const lineas = (d.lineas ?? []).slice(0, 40);
  const tablaLineas = lineas.length ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:20px 0 4px;">
      <tr>
        <td style="padding:0 0 8px;color:#6b7280;font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:.04em;">Detalle</td>
        <td style="padding:0 0 8px;color:#6b7280;font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:.04em;text-align:right;">Importe</td>
      </tr>
      ${lineas.map(l => `
      <tr>
        <td style="padding:9px 0;border-top:1px solid #f3f4f6;font-size:13px;color:#111827;">
          ${esc(l.nombre)}
          <div style="color:#9ca3af;font-size:12px;margin-top:2px;">${cant(l.cantidad)} × ${crc(l.precio)}</div>
        </td>
        <td style="padding:9px 0;border-top:1px solid #f3f4f6;font-size:13px;color:#111827;text-align:right;white-space:nowrap;vertical-align:top;">${crc(l.importe)}</td>
      </tr>`).join('')}
      ${(d.lineas?.length ?? 0) > lineas.length ? `
      <tr><td colspan="2" style="padding:8px 0;color:#9ca3af;font-size:12px;border-top:1px solid #f3f4f6;">
        y ${(d.lineas!.length - lineas.length)} línea(s) más — el detalle completo va en el PDF adjunto.
      </td></tr>` : ''}
    </table>` : '';

  const totales = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:${lineas.length ? '4px' : '16px'};">
      ${d.subtotal != null ? `<tr><td style="padding:4px 0;color:#6b7280;font-size:13px;">Subtotal</td><td style="padding:4px 0;color:#111827;font-size:13px;text-align:right;">${crc(d.subtotal)}</td></tr>` : ''}
      ${Number(d.impuesto) > 0 ? `<tr><td style="padding:4px 0;color:#6b7280;font-size:13px;">IVA</td><td style="padding:4px 0;color:#111827;font-size:13px;text-align:right;">${crc(d.impuesto)}</td></tr>` : ''}
      <tr>
        <td style="padding:12px 0 0;border-top:2px solid #111827;color:#111827;font-size:15px;font-weight:bold;">Total</td>
        <td style="padding:12px 0 0;border-top:2px solid #111827;color:#111827;font-size:20px;font-weight:bold;text-align:right;white-space:nowrap;">${crc(d.total)}</td>
      </tr>
    </table>`;

  const a = d.adjuntos;
  const adjuntos = a ? [
    a.xml ? 'el XML firmado' : null,
    a.respuesta ? 'la respuesta de Hacienda' : null,
    a.pdf ? 'el PDF' : null,
  ].filter(Boolean) : [];
  const notaAdjuntos = adjuntos.length ? `
    <div style="margin-top:22px;padding:12px 14px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;color:#4b5563;font-size:12px;line-height:1.5;">
      📎 Adjuntamos ${adjuntos.length > 1 ? adjuntos.slice(0, -1).join(', ') + ' y ' + adjuntos[adjuntos.length - 1] : adjuntos[0]}.
      ${a?.xml ? 'El XML es el comprobante con validez ante Hacienda: guardalo para tu contabilidad.' : ''}
    </div>` : '';

  const contacto = [n.telefono ? `Tel. ${esc(n.telefono)}` : null, n.correo ? esc(n.correo) : null]
    .filter(Boolean).join(' · ');

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${esc(tipo)} ${esc(d.numero)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:#ffffff;border-radius:16px;border:1px solid #e5e7eb;font-family:Arial,Helvetica,sans-serif;">

    <!-- Emisor -->
    <tr><td style="padding:28px 28px 20px;border-bottom:1px solid #f3f4f6;">
      ${logo}
      <div style="color:#111827;font-size:19px;font-weight:bold;">${esc(n.nombre)}</div>
      ${n.razonSocial && n.razonSocial !== n.nombre ? `<div style="color:#6b7280;font-size:13px;margin-top:2px;">${esc(n.razonSocial)}</div>` : ''}
      ${n.cedula ? `<div style="color:#6b7280;font-size:13px;margin-top:2px;">Cédula ${esc(n.cedula)}</div>` : ''}
    </td></tr>

    <!-- Documento -->
    <tr><td style="padding:24px 28px 8px;">
      <div style="color:#6b7280;font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:.05em;">${esc(tipo)}</div>
      <div style="color:#111827;font-size:26px;font-weight:bold;margin:4px 0 12px;">N° ${esc(d.numero)}</div>
      <span style="display:inline-block;padding:5px 12px;border-radius:999px;background:${estado.bg};color:${estado.fg};border:1px solid ${estado.borde};font-size:12px;font-weight:bold;">${estado.txt}</span>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:18px;">
        ${fila('Cliente', d.cliente ? esc(d.cliente) : null)}
        ${fila('Fecha', fecha)}
        ${fila('Consecutivo Hacienda', consecutivo, true)}
      </table>

      ${tablaLineas}
      ${totales}

      <div style="margin-top:22px;color:#6b7280;font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:.04em;">Clave numérica</div>
      <div style="margin-top:4px;color:#374151;font-size:12px;font-family:Consolas,Menlo,monospace;word-break:break-all;">${claveEnBloques(d.clave)}</div>

      ${notaAdjuntos}
    </td></tr>

    <!-- Contacto del negocio -->
    <tr><td style="padding:20px 28px 26px;">
      <div style="border-top:1px solid #f3f4f6;padding-top:16px;color:#6b7280;font-size:12px;line-height:1.6;">
        ¿Dudas sobre este comprobante? Respondé este correo o comunicate con ${esc(n.nombre)}.
        ${contacto ? `<br>${contacto}` : ''}
        ${n.direccion ? `<br>${esc(n.direccion)}` : ''}
      </div>
    </td></tr>
  </table>

  <div style="max-width:580px;margin:14px auto 0;color:#9ca3af;font-size:11px;font-family:Arial,Helvetica,sans-serif;text-align:center;">
    Comprobante emitido con ColónClick
  </div>
</td></tr>
</table>
</body></html>`;
}
