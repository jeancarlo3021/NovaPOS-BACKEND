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
  /** Nota que el negocio le puso a la factura («entrega el jueves», «OC 4471»). */
  nota?: string | null;
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

/** Leyenda obligatoria al pie del comprobante electrónico (resolución DGT 4.4). */
const FE_RESOLUTION_FOOTER =
  'Autorizada mediante resolución MH-DGT-RES-0027-2024 del 13 de noviembre del 2024 de la DGTD. Version 4.4';

/**
 * Importe con el formato del tiquete: sin decimales si es redondo.
 *
 * El tiquete térmico imprime colones enteros. Mostrar «₡3.800,00» donde el
 * papel dice «₡3.800» rompe el parecido por nada; pero si el monto trae
 * céntimos hay que enseñarlos, o el cliente suma las líneas y no le da.
 */
const monto = (n: any): string => {
  const v = Number(n || 0);
  const dec = Math.abs(v % 1) > 0.004 ? 2 : 0;
  return `₡${v.toLocaleString('es-CR', { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
};

/**
 * EL CORREO SE VE COMO EL TIQUETE.
 *
 * El cliente ya vio el tiquete en el mostrador: papel angosto, letra de máquina
 * de escribir, líneas de guiones, el total entre dos rayas. Cuando después le
 * llega un correo con otra cara —tarjetas, grises, tipografía de sitio web—
 * tiene que volver a leerlo todo para convencerse de que es la misma compra.
 *
 * Acá se repite la forma del tiquete: el mismo orden de bloques, la misma
 * tipografía monoespaciada, los mismos separadores y el mismo total destacado.
 * Tres diferencias a propósito, porque el correo no es papel:
 *
 *   · los separadores son bordes punteados y no filas de guiones: una fila de
 *     «-» se parte distinto en cada cliente de correo y en el celular queda en
 *     dos renglones;
 *   · el estado de Hacienda va arriba, visible, porque es lo primero que el
 *     cliente quiere saber de un comprobante que le llega por correo;
 *   · sigue el aviso de los adjuntos, que en el papel no existe.
 */
export function comprobanteEmailHtml(d: DatosCorreoComprobante): string {
  const tipo = tipoDeClave(d.clave);
  const consecutivo = consecutivoDeClave(d.clave);
  const fecha = fechaLarga(d.fecha);
  const n = d.negocio;

  const estado = d.estado === 'accepted'
    ? { txt: 'ACEPTADO POR HACIENDA', bg: '#ecfdf5', fg: '#047857', borde: '#a7f3d0' }
    : d.estado === 'rejected'
      ? { txt: 'RECHAZADO POR HACIENDA', bg: '#fef2f2', fg: '#b91c1c', borde: '#fecaca' }
      : { txt: 'EN PROCESO EN HACIENDA', bg: '#fffbeb', fg: '#b45309', borde: '#fde68a' };

  // Logo solo si es una dirección pública: los clientes de correo bloquean las
  // imágenes incrustadas, y un recuadro roto se ve peor que no tener logo.
  const logo = n.logoUrl && /^https:\/\//i.test(n.logoUrl)
    ? `<img src="${esc(n.logoUrl)}" alt="${esc(n.nombre)}" height="56" style="display:inline-block;height:56px;max-width:70%;border:0;margin:0 0 8px;">`
    : '';

  /** Línea punteada, el separador del tiquete. */
  const sep = (margen = '8px') =>
    `<div style="border-top:1px dashed #9ca3af;margin:${margen} 0;font-size:0;line-height:0;">&nbsp;</div>`;

  /** Rótulo de sección, pegado a la izquierda como en el papel. */
  const rotulo = (t: string) =>
    `<div style="font-weight:bold;font-size:13px;color:#111827;margin:0 0 2px;">${t}</div>`;

  /**
   * Las líneas se muestran CON IMPUESTO, igual que en el tiquete.
   *
   * En la base los renglones están sin IVA (así lo exige la factura), pero el
   * papel enseña el precio final: es lo que el cliente pagó y lo que le permite
   * sumar las líneas y llegar al total. Se reparte el IVA del documento con la
   * misma proporción que usa el tiquete, para que los dos digan lo mismo.
   */
  const base = Number(d.subtotal ?? 0);
  const iva = Number(d.impuesto ?? 0);
  const tasa = base > 0 && iva > 0 ? iva / base : 0;
  const conIva = (v: number) => (tasa > 0 ? Math.round(v * (1 + tasa)) : v);

  const lineas = (d.lineas ?? []).slice(0, 60);
  const filasArticulos = lineas.map(l => `
    <tr>
      <td style="padding:3px 0 0;font-size:13px;color:#111827;font-weight:bold;word-break:break-word;">${esc(l.nombre)}</td>
      <td style="padding:3px 0 0;font-size:13px;color:#111827;font-weight:bold;text-align:right;white-space:nowrap;">${monto(conIva(l.importe))}</td>
    </tr>
    <tr>
      <td colspan="2" style="padding:0 0 3px;font-size:12px;color:#374151;">&nbsp;&nbsp;${cant(l.cantidad)} × ${monto(conIva(l.precio))}</td>
    </tr>`).join('');

  const masLineas = (d.lineas?.length ?? 0) > lineas.length
    ? `<tr><td colspan="2" style="padding:4px 0;font-size:12px;color:#6b7280;">y ${(d.lineas!.length - lineas.length)} línea(s) más — el detalle completo va en los adjuntos.</td></tr>`
    : '';

  const totales = `
    ${iva > 0 ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>
        <td style="padding:2px 0;font-size:13px;color:#111827;">IVA incluido:</td>
        <td style="padding:2px 0;font-size:13px;color:#111827;text-align:right;white-space:nowrap;">${monto(iva)}</td>
      </tr>
    </table>
    ${sep()}` : ''}
    <div style="border-top:2px solid #111827;border-bottom:2px solid #111827;padding:7px 0;margin:8px 0;text-align:center;font-size:19px;font-weight:bold;color:#111827;letter-spacing:1px;">
      *** TOTAL: ${monto(d.total)} ***
    </div>`;

  const nota = String(d.nota ?? '').trim();
  const bloqueNota = nota ? `
    ${sep()}
    ${rotulo('NOTA')}
    <div style="font-size:13px;color:#111827;white-space:pre-wrap;word-break:break-word;">${esc(nota)}</div>` : '';

  const a = d.adjuntos;
  const adjuntos = a ? [
    a.xml ? 'el XML firmado' : null,
    a.respuesta ? 'la respuesta de Hacienda' : null,
    a.pdf ? 'el PDF' : null,
  ].filter(Boolean) : [];
  const notaAdjuntos = adjuntos.length ? `
    <div style="margin-top:14px;padding:10px 12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;color:#4b5563;font-size:12px;line-height:1.5;font-family:Arial,Helvetica,sans-serif;">
      📎 Adjuntamos ${adjuntos.length > 1 ? adjuntos.slice(0, -1).join(', ') + ' y ' + adjuntos[adjuntos.length - 1] : adjuntos[0]}.
      ${a?.xml ? 'El XML es el comprobante con validez ante Hacienda: guardalo para tu contabilidad.' : ''}
    </div>` : '';

  /** Datos del negocio, centrados bajo el nombre, como en el papel. */
  const lineaTienda = (t: string | null | undefined) =>
    t ? `<div style="font-size:12px;color:#111827;word-break:break-word;">${esc(t)}</div>` : '';

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${esc(tipo)} ${esc(d.numero)}</title></head>
<body style="margin:0;padding:0;background:#e5e7eb;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e5e7eb;">
<tr><td align="center" style="padding:24px 10px;">

  <!-- El «papel»: angosto y monoespaciado, como el tiquete -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:400px;background:#ffffff;border:1px solid #d1d5db;font-family:'Courier New',Courier,monospace;">
    <tr><td style="padding:18px 18px 20px;">

      <!-- Encabezado -->
      <div style="text-align:center;">
        ${logo}
        <div style="font-size:16px;font-weight:bold;color:#111827;letter-spacing:1px;text-transform:uppercase;">${esc(tipo)}</div>
        <div style="font-size:13px;font-weight:bold;color:#111827;margin-top:2px;">Factura #${esc(d.numero)}</div>
        ${consecutivo ? `<div style="font-size:11px;color:#374151;margin-top:2px;">Consecutivo: ${esc(consecutivo)}</div>` : ''}
        <!-- La clave se parte ENTRE bloques de diez, no en cualquier dígito: con
             break-all quedaba un dígito suelto en la última línea y así no se
             puede ni dictar ni copiar. -->
        <div style="font-size:10px;color:#374151;overflow-wrap:break-word;line-height:1.4;margin-top:3px;">Clave: ${claveEnBloques(d.clave)}</div>
        ${fecha ? `<div style="font-size:12px;color:#111827;margin-top:2px;">${esc(fecha)}</div>` : ''}
        <div style="margin-top:8px;">
          <span style="display:inline-block;padding:4px 10px;background:${estado.bg};color:${estado.fg};border:1px solid ${estado.borde};font-size:11px;font-weight:bold;letter-spacing:.04em;">${estado.txt}</span>
        </div>
      </div>

      <!-- Negocio -->
      <div style="text-align:center;margin-top:10px;">
        <div style="font-size:14px;font-weight:bold;color:#111827;">${esc(n.nombre)}</div>
        ${n.razonSocial && n.razonSocial !== n.nombre ? lineaTienda(n.razonSocial) : ''}
        ${lineaTienda(n.cedula ? `Céd. ${n.cedula}` : null)}
        ${lineaTienda(n.direccion)}
        ${lineaTienda(n.telefono ? `Tel. ${n.telefono}` : null)}
        ${lineaTienda(n.correo)}
      </div>

      ${sep('10px')}

      ${d.cliente ? `${rotulo('CLIENTE')}<div style="font-size:13px;color:#111827;word-break:break-word;">${esc(d.cliente)}</div>${sep()}` : ''}

      ${filasArticulos ? `
      ${rotulo('ARTÍCULOS')}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        ${filasArticulos}
        ${masLineas}
      </table>
      ${sep()}` : ''}

      ${totales}
      ${bloqueNota}

      ${sep()}
      <div style="text-align:center;font-size:11px;color:#374151;line-height:1.5;">${FE_RESOLUTION_FOOTER}</div>

      ${notaAdjuntos}

      <div style="margin-top:14px;border-top:1px dashed #9ca3af;padding-top:10px;text-align:center;font-size:12px;color:#374151;font-family:Arial,Helvetica,sans-serif;line-height:1.5;">
        ¿Dudas sobre este comprobante? Respondé este correo o comunicate con ${esc(n.nombre)}.
      </div>

    </td></tr>
  </table>

  <div style="max-width:400px;margin:12px auto 0;color:#6b7280;font-size:11px;font-family:Arial,Helvetica,sans-serif;text-align:center;">
    Comprobante emitido con ColónClick
  </div>
</td></tr>
</table>
</body></html>`;
}
