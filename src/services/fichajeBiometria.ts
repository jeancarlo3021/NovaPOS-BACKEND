import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { db } from '../db/client.js';

/**
 * HUELLA Y FACEID PARA FICHAR (WebAuthn).
 *
 * Lo primero que hay que entender: **acá no se guarda ninguna huella ni
 * ninguna cara**. Eso nunca sale del teléfono. El aparato crea un par de
 * llaves para este negocio, se queda con la privada —protegida por su propio
 * sensor— y nos manda la pública. Al fichar, el teléfono verifica a la persona
 * con su biometría y firma un desafío; el servidor comprueba la firma con la
 * llave pública. Si esta base se filtrara, no hay nada biométrico que filtrar.
 *
 * Requiere HTTPS (o localhost): los navegadores no permiten WebAuthn sin él.
 */

/** Dominio donde corre la app. De ahí sale el `rpID` que exige WebAuthn. */
function origenYDominio(c: any): { origen: string; rpID: string } {
  const origen = c.req.header('origin') || c.req.header('referer') || '';
  try {
    const u = new URL(origen);
    return { origen: u.origin, rpID: u.hostname };
  } catch {
    return { origen: 'http://localhost:5173', rpID: 'localhost' };
  }
}

/**
 * Los desafíos viven en memoria, un minuto.
 *
 * Guardarlos en la base sería una tabla más para algo que dura lo que tarda
 * alguien en poner el dedo. En memoria alcanza, y si el servidor se reinicia
 * lo único que pasa es que hay que volver a tocar el botón.
 */
const desafios = new Map<string, { challenge: string; vence: number }>();
const guardarDesafio = (clave: string, challenge: string) => {
  desafios.set(clave, { challenge, vence: Date.now() + 60_000 });
  if (desafios.size > 500) {
    for (const [k, v] of desafios) if (v.vence < Date.now()) desafios.delete(k);
  }
};
const tomarDesafio = (clave: string): string | null => {
  const d = desafios.get(clave);
  desafios.delete(clave);                      // de un solo uso
  if (!d || d.vence < Date.now()) return null;
  return d.challenge;
};

/** Paso 1 del registro: el servidor propone, el teléfono crea la llave. */
export async function opcionesRegistro(c: any, tenantId: string, empleado: { id: string; full_name: string }) {
  const { rpID } = origenYDominio(c);
  const { data: previas } = await db.from('attendance_credentials')
    .select('credential_id').eq('employee_id', empleado.id);

  const options = await generateRegistrationOptions({
    rpName: 'NovaPOS · Fichaje',
    rpID,
    userName: empleado.full_name,
    userDisplayName: empleado.full_name,
    attestationType: 'none',
    // Ya registrado en ESTE aparato: que el navegador no ofrezca repetirlo.
    excludeCredentials: (previas ?? []).map((p: any) => ({ id: p.credential_id })),
    authenticatorSelection: {
      // `platform` = el sensor del propio aparato (huella del teléfono, FaceID,
      // Windows Hello). Una llave USB no sirve para fichar: se presta.
      authenticatorAttachment: 'platform',
      userVerification: 'required',
      residentKey: 'preferred',
    },
  });
  guardarDesafio(`reg:${tenantId}:${empleado.id}`, options.challenge);
  return options;
}

/** Paso 2: se verifica lo que creó el teléfono y se guarda la llave pública. */
export async function verificarRegistro(c: any, tenantId: string, empleadoId: string, respuesta: any, etiqueta?: string) {
  const { origen, rpID } = origenYDominio(c);
  const challenge = tomarDesafio(`reg:${tenantId}:${empleadoId}`);
  if (!challenge) throw new Error('El registro venció. Volvé a intentarlo.');

  const v = await verifyRegistrationResponse({
    response: respuesta,
    expectedChallenge: challenge,
    expectedOrigin: origen,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  if (!v.verified || !v.registrationInfo) throw new Error('El aparato no pudo registrarse');

  const cred = (v.registrationInfo as any).credential ?? v.registrationInfo;
  const credentialId: string = cred.id ?? cred.credentialID;
  const publicKey: Uint8Array = cred.publicKey ?? cred.credentialPublicKey;

  const { error } = await db.from('attendance_credentials').insert({
    tenant_id: tenantId,
    employee_id: empleadoId,
    credential_id: String(credentialId),
    public_key: Buffer.from(publicKey).toString('base64'),
    counter: Number(cred.counter ?? 0),
    label: etiqueta?.slice(0, 60) ?? null,
  });
  if (error) throw new Error(error.message);
  return { ok: true };
}

/** Paso 1 del fichaje: un desafío para que el teléfono lo firme. */
export async function opcionesFichaje(c: any, tenantId: string) {
  const { rpID } = origenYDominio(c);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    // Sin lista de credenciales: el aparato ofrece las que tenga para este
    // dominio, y así la pantalla no tiene que preguntar primero quién sos.
  });
  guardarDesafio(`fich:${tenantId}`, options.challenge);
  return options;
}

/** Paso 2: se verifica la firma y se devuelve a QUIÉN pertenece la llave. */
export async function verificarFichaje(c: any, tenantId: string, respuesta: any) {
  const { origen, rpID } = origenYDominio(c);
  const challenge = tomarDesafio(`fich:${tenantId}`);
  if (!challenge) throw new Error('El intento venció. Tocá de nuevo el botón.');

  const credId = String(respuesta?.id ?? '');
  const { data: cred } = await db.from('attendance_credentials')
    .select('*').eq('tenant_id', tenantId).eq('credential_id', credId).maybeSingle();
  if (!cred) throw new Error('Este aparato no está registrado para fichar');

  const v = await verifyAuthenticationResponse({
    response: respuesta,
    expectedChallenge: challenge,
    expectedOrigin: origen,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential: {
      id: (cred as any).credential_id,
      publicKey: new Uint8Array(Buffer.from((cred as any).public_key, 'base64')),
      counter: Number((cred as any).counter ?? 0),
    },
  } as any);
  if (!v.verified) throw new Error('No se pudo verificar la huella');

  /*
   * El contador que sube evita que alguien repita una firma vieja. Se guarda
   * el nuevo; si el aparato no lleva contador (varios teléfonos no lo hacen),
   * queda en cero y la protección la da el desafío de un solo uso.
   */
  await db.from('attendance_credentials').update({
    counter: Number(v.authenticationInfo?.newCounter ?? 0),
    last_used_at: new Date().toISOString(),
  }).eq('id', (cred as any).id);

  const { data: emp } = await db.from('employees')
    .select('id, full_name, position, status').eq('id', (cred as any).employee_id).maybeSingle();
  if (!emp || (emp as any).status !== 'active') throw new Error('El empleado no está activo');
  return emp as any;
}
