# MIMIR IA

Tutor personal con inteligencia artificial para estudiantes de la Institución Educativa
Gonzalo Rivera Laguado (Cúcuta, Colombia). Proyecto SENA, ficha 3156695.

Explica conceptos paso a paso, cita fuentes, lee fotos y documentos (PDF, Word, Excel,
PowerPoint y texto) y guarda el historial de cada estudiante.

**Sitio:** https://mimiria.vercel.app

## Tecnología

| Capa | Herramientas |
| --- | --- |
| Frontend | React 18, Vite, TypeScript, Tailwind CSS 4, React Router |
| Backend | Funciones serverless de Vercel (`api/`, Node 20+) |
| Datos | MongoDB Atlas (`users`, `conversations`, `counters`, `qa_cache`, `rate_limits`) |
| IA | OpenAI `gpt-5-nano` (preguntas simples) y `gpt-5-mini` (explicaciones y adjuntos) |

## Estructura

```
api/            Funciones serverless (cada archivo es un endpoint)
  _lib.js         Mongo, tokens, contraseñas, CORS, límites de uso, caché, enlaces de fuentes
  _ai.js          Prompts, modo plan de estudio, elección de modelo, llamada a OpenAI
  _extract.js     Lectura de PDF/DOCX/XLSX/PPTX en el servidor (con límites anti zip bomb)
  chat.js         POST /api/chat           Elige modelo, usa caché, llama a OpenAI
  conversations.js GET (lista sin mensajes) / GET ?id= / POST / DELETE  /api/conversations
  register.js     POST /api/register
  login.js        POST /api/login
  me.js           GET  /api/me
  health.js       GET  /api/health         Estado del servidor (con caché de unos minutos)
src/            Frontend (landing, chat, modales legales)
tests/          Pruebas del backend (node:test): funciones y endpoints con BD y OpenAI simulados
```

## Puesta en marcha

Requisitos: Node 20 o superior.

```bash
npm install
cp .env.example .env     # y rellena las variables (ver abajo)
npm run dev              # frontend en http://localhost:3000
npm test                 # pruebas del backend
npm run typecheck        # revisión de tipos
npm run build            # compila a dist/
```

`npm run dev` sólo sirve el frontend. Para probar también `api/` en local usa
`npx vercel dev` (con las variables en `.env`).

## Variables de entorno

Ver `.env.example`. Las tres obligatorias son `MONGODB_URI`, `OPENAI_API_KEY` y
`TOKEN_SECRET` (mínimo 32 caracteres; sin ella el servidor no emite sesiones).

## Despliegue

Ver [DEPLOY.md](DEPLOY.md).

## Cómo usa la IA

- **Salida estructurada** (`json_schema` estricto): la respuesta siempre llega como JSON completo
  (`text`, `sources`, `followups`); si se cortara, se rescata el texto en vez de mostrar JSON crudo.
- **Presupuesto de tokens realista:** en los modelos gpt-5 el límite incluye el razonamiento, así que
  se usa un esfuerzo de razonamiento bajo (`minimal` para saludos, `low` por defecto, `medium` en
  matemáticas) y entre 3 000 y 15 000 tokens según la tarea.
- **Modo plan de estudio:** se activa con frases como "hazme un plan de estudio", "organizar mi
  estudio", "cómo me preparo para el ICFES"… y también al pedir cambios a un plan ya entregado.
  Si faltan datos esenciales, pregunta; si no, entrega el plan completo declarando sus supuestos.
- **Fuentes que no dan 404:** el modelo elige un sitio y un tema; el servidor construye el enlace de
  búsqueda (Wikipedia, Khan Academy, MDN, Wolfram Alpha…).
- Tiempo límite de 55 s, reintentos ante errores transitorios y modo compatible si OpenAI rechaza
  un parámetro opcional.

## Seguridad (resumen)

- Contraseñas con scrypt + salt; tokens firmados con HMAC y con caducidad.
- Límite de mensajes por estudiante; los intentos de login se limitan por cuenta + IP y los
  registros por IP con un tope alto (un colegio comparte conexión).
- Cabeceras de seguridad (CSP, X-Frame-Options, etc.) en `vercel.json`.
- CORS restringido; las URLs de fuentes que genera el modelo se validan (sólo http/https).
- Los archivos adjuntos se tratan como datos, no como instrucciones para el modelo.
- La descompresión de documentos tiene tope de tamaño (protección contra zip bombs).

## Cambios

Ver [CHANGELOG.md](CHANGELOG.md).
