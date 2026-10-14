# Despliegue en Vercel (MongoDB Atlas + OpenAI)

## 1. MongoDB Atlas

1. Crea un cluster gratuito (M0) en [MongoDB Atlas](https://www.mongodb.com/atlas).
2. **Database Access**: crea un usuario con contraseña.
3. **Network Access**: permite `0.0.0.0/0` (Vercel usa IPs variables).
4. **Database → Connect → Drivers**: copia la cadena
   `mongodb+srv://usuario:contraseña@cluster0.xxxxx.mongodb.net/`.
   Si la contraseña tiene `@`, `:` o `/`, codifícalos (`@` → `%40`).

La base `mimiria` y sus colecciones se crean solas al primer uso.

## 2. OpenAI

1. Crea una clave en <https://platform.openai.com/api-keys>.
2. Comprueba que tu cuenta tenga acceso a `gpt-5-mini` y `gpt-5-nano`.
3. Agrega saldo a la cuenta.

## 3. Vercel

1. Sube el proyecto a GitHub e impórtalo en Vercel (**Add New Project**).
2. Framework: **Vite**. Build: `npm run build`. Salida: `dist`. Root Directory: vacío.
3. En **Settings → Environment Variables** agrega (ver `.env.example`):
   - `MONGODB_URI`
   - `OPENAI_API_KEY`
   - `TOKEN_SECRET` — mínimo 32 caracteres. Genera una con
     `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
     Si la cambias después, todas las sesiones abiertas se cierran.
4. **Deploy**. Las variables nuevas sólo aplican a despliegues nuevos: tras cambiarlas, haz **Redeploy**.

## 4. Comprobación

Abre `https://tu-sitio.vercel.app/api/health`. Debe responder:

```json
{ "ok": true, "mongo": true, "openai": true, "config": true }
```

El resultado se guarda unos minutos (15 segundos si algo falla). Por seguridad, el endpoint es
público pero solo da mensajes genéricos. Para ver el **detalle técnico** (qué variable falta, el
error exacto de OpenAI o de Mongo), define en Vercel la variable `HEALTH_DEBUG_KEY` (mínimo 16
caracteres) y abre `/api/health?key=TU_CLAVE`. Los errores completos también quedan en los
*Logs* de Vercel.

| Campo con error | Qué significa |
| --- | --- |
| `mongoError` | Revisa `MONGODB_URI`, el usuario/contraseña y Network Access (`0.0.0.0/0`). |
| `openaiError` | Clave inválida, sin saldo o sin acceso a los modelos. |
| `configError` | Falta `TOKEN_SECRET` o tiene menos de 32 caracteres. |

## 5. Si algo falla

- **"El servidor no tiene las funciones /api desplegadas"**: verifica que la carpeta `api/`
  esté en GitHub y revisa los *Build Logs* de Vercel.
- **Cuentas e historial no se comparten entre dispositivos**: `/api/health` está devolviendo
  `ok: false`; lee el error.
- **429 en el chat**: el estudiante superó su límite (30 mensajes/hora, 150/día por defecto;
  se cambian con `CHAT_LIMIT_HOUR` y `CHAT_LIMIT_DAY`).
- **Las respuestas largas se cortan o tardan**: la función de chat tiene 60 segundos
  (`vercel.json`). Los planes de estudio usan hasta 15 000 tokens; si tu cuenta de Vercel
  permite más tiempo, súbelo ahí.
- **Error de OpenAI en el chat**: el mensaje muestra la causa (`401` clave mal copiada,
  `429` sin saldo, `model_not_found` sin acceso al modelo).
