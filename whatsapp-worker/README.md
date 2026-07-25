# ColónClick — Worker de WhatsApp (Baileys)

Mantiene **una** sesión de WhatsApp vinculada por **QR** (estilo WhatsApp Web) y
la conserva viva. El backend (Hono/Vercel) le habla por HTTP y el **panel admin**
muestra el QR / estado / envío de prueba.

> ⚠️ **No va en Vercel.** Vercel es serverless (funciones efímeras) y no puede
> mantener la conexión abierta. Deployá esto en un host **siempre encendido** y
> con **disco persistente**: Railway (con Volume), Render (con Disk), Fly.io o un
> VPS. Si el disco no persiste, hay que re-escanear el QR en cada reinicio.

## Variables de entorno

| Var | Descripción |
|-----|-------------|
| `WORKER_SECRET` | Secreto compartido con el backend (obligatorio). Debe coincidir con `WHATSAPP_WORKER_SECRET` del backend. |
| `PORT` | Puerto HTTP (default `8088`). |
| `AUTH_DIR` | Carpeta de credenciales (default `./auth`). **Apuntala a un volumen persistente.** |

## Correr local

```bash
cd whatsapp-worker
npm install
WORKER_SECRET=algo-secreto AUTH_DIR=./auth npm start
```

## Endpoints (todos requieren header `x-worker-secret`, salvo `/health`)

| Método | Ruta | Qué hace |
|--------|------|----------|
| GET | `/health` | `{ ok: true }` (sin secreto) |
| GET | `/status` | `{ state, connected, qr, me }` |
| POST | `/send` | body `{ to, text }` → envía texto |
| POST | `/logout` | cierra la sesión y regenera QR |

## Conectar con el backend

En el backend (Vercel) configurá:

```
WHATSAPP_WORKER_URL=https://tu-worker.up.railway.app
WHATSAPP_WORKER_SECRET=algo-secreto   # = WORKER_SECRET del worker
```

Luego, en el **Panel Admin → WhatsApp**, aparece el QR para vincular el número
ColónClick. Una vez conectado, el envío de mensajes queda disponible.

## Deploy en Railway (recomendado)

1. New Project → Deploy from repo, **Root Directory** = `whatsapp-worker`.
2. Variables: `WORKER_SECRET`, `AUTH_DIR=/data/auth`.
3. Agregá un **Volume** montado en `/data` (para que `AUTH_DIR` persista).
4. Start command: `npm start`.
5. Copiá la URL pública → ponela en `WHATSAPP_WORKER_URL` del backend.

## Notas / riesgos

- WhatsApp Web automatizado **no es oficial**; usalo con moderación (evitá spam)
  para reducir riesgo de bloqueo del número.
- Para volumen alto o garantías, la API oficial de Meta (Cloud API) ya está
  implementada en el backend (`src/services/whatsapp.ts`).
