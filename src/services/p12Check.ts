import forge from 'node-forge';

export type P12Check = {
  abre: boolean;              // ¿la clave guardada abre el archivo?
  motivo?: string;            // por qué no abre, en palabras
  vencido?: boolean;
  desde?: string;
  hasta?: string;
  sujeto?: string;            // nombre del titular como viene en el certificado
  cedula?: string;            // cédula que declara el certificado
  coincide_cedula?: boolean;  // ¿es la del emisor?
  cedula_emisor?: string;     // con cuál se comparó
};

/** Cédula del titular: Hacienda la pone en el CN/serialNumber del sujeto. */
function cedulaDelSujeto(sujeto: any): string {
  const campos = ['serialNumber', 'commonName', 'organizationalUnitName', 'organizationName'];
  for (const c of campos) {
    const v = sujeto.getField?.(c)?.value ?? sujeto.getField?.({ name: c })?.value;
    const dig = String(v ?? '').replace(/\D/g, '');
    if (dig.length >= 9 && dig.length <= 12) return dig;
  }
  return '';
}

/**
 * Abre el .p12 LOCALMENTE para saber si el problema es el certificado.
 *
 * Cuando el proveedor de facturación responde un error genérico, no hay forma de
 * distinguir un certificado vencido o con la clave equivocada de una falla de
 * ellos. Esto lo resuelve sin intermediarios: si el archivo no abre con la clave
 * guardada, o venció, o es de otra cédula, el problema es acá y se dice cuál es.
 */
export function revisarP12(p12Base64: string, clave: string, cedulaEmisor = ''): P12Check {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const der = forge.util.decode64(p12Base64);
    const asn1 = forge.asn1.fromDer(der);
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, clave);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    // forge distingue el fallo de MAC (clave incorrecta) del archivo corrupto.
    if (/mac could not be verified|invalid password/i.test(msg)) {
      return { abre: false, motivo: 'La CLAVE del certificado no es la correcta: el archivo no abre con la que está guardada.' };
    }
    if (/unsupported|algorithm|oid/i.test(msg)) {
      return { abre: false, motivo: `El archivo usa un cifrado que no se pudo leer acá (${msg}). No prueba que esté malo.` };
    }
    return { abre: false, motivo: `El archivo no parece un .p12 válido: ${msg}` };
  }

  // Primer certificado con datos de vigencia: es el del titular.
  const bags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const cert = (bags[forge.pki.oids.certBag] ?? []).map(b => b.cert).find(Boolean);
  if (!cert) return { abre: true, motivo: 'Abre con la clave, pero no trae ningún certificado adentro.' };

  const desde = cert.validity.notBefore;
  const hasta = cert.validity.notAfter;
  const ahora = new Date();
  const cedula = cedulaDelSujeto(cert.subject);
  const mia = String(cedulaEmisor ?? '').replace(/\D/g, '');

  return {
    abre: true,
    vencido: hasta < ahora || desde > ahora,
    desde: desde.toISOString().slice(0, 10),
    hasta: hasta.toISOString().slice(0, 10),
    sujeto: cert.subject.getField('CN')?.value ?? '',
    cedula,
    coincide_cedula: !cedula || !mia ? undefined : cedula === mia,
    cedula_emisor: mia,
  };
}

/** Resumen en texto para mostrarle al usuario. */
export function resumenP12(r: P12Check): string {
  if (!r.abre) return `❌ CERTIFICADO: ${r.motivo}`;
  const l: string[] = [];
  l.push(`✅ El certificado abre con la clave guardada.`);
  l.push(`   Titular: ${r.sujeto || '(sin nombre)'}${r.cedula ? ` · cédula ${r.cedula}` : ''}`);
  l.push(`   Vigencia: ${r.desde} → ${r.hasta}`);
  if (r.vencido) l.push(`❌ ESTÁ FUERA DE VIGENCIA. Hay que renovarlo en el ATV de Hacienda.`);
  if (r.coincide_cedula === false) l.push(`❌ El certificado es de la cédula ${r.cedula}, pero el emisor es ${r.cedula_emisor}.`);
  if (!r.vencido && r.coincide_cedula !== false) l.push(`   Está vigente y corresponde al emisor.`);
  return l.join('\n');
}
