# Historial de cambios

## Segunda revisión: IA, planes de estudio y correcciones

**Uso de la IA (el chat fallaba o respondía a medias)**
- Causa principal: `max_completion_tokens: 2000` en un modelo gpt-5 incluye el razonamiento; el
  modelo gastaba el presupuesto "pensando" y la respuesta salía vacía o cortada. Ahora el
  presupuesto es de 3 000 a 15 000 tokens y el razonamiento es `minimal`/`low` (`medium` en
  matemáticas). Si aun así llega vacío, se reintenta con razonamiento mínimo.
- Salida estructurada (`json_schema` estricto) en lugar de `json_object`; si el JSON llega cortado se
  rescata el texto y se avisa, en vez de mostrar JSON crudo.
- Modo plan de estudio con prompt propio: detecta muchas formas de pedirlo (también cambios a un
  plan previo), pregunta solo si falta lo esencial, entrega un plan realista por semanas y días con
  supuestos declarados, técnicas de estudio, autoevaluación y plan B. Contexto Saber/ICFES.
- Prompt del tutor reescrito: respuesta directa primero, procedimiento paso a paso, honestidad si no
  sabe, y formato compatible con lo que la pantalla muestra (sin tablas, `#`, LaTeX ni bloques de código).
- Fuentes: el modelo ya no inventa URLs (daban 404); elige sitio + tema y el servidor construye el
  enlace de búsqueda.
- Tiempo límite de 55 s con mensaje claro, reintento ante 429/5xx, y modo compatible si OpenAI
  rechaza un parámetro opcional.
- Fotos de 1280 px (antes 800) para que se lean cuadernos escritos a mano; SVG rechazado con aviso.
- La caché ya no comparte preguntas con datos personales ni planes.

**Seguridad y robustez**
- El token de sesión ya no se imprime en la consola del navegador (se quitaron los `console.log`).
- Una caída de red o del servidor ya no cierra la sesión: solo un 401 la borra.
- `/api/health` público solo muestra mensajes genéricos; el detalle va a los logs o a
  `?key=HEALTH_DEBUG_KEY`.
- La lista de conversaciones ya no trae los mensajes (podía superar el límite de Vercel); se cargan
  al abrir cada conversación. Máximo 50 conversaciones por estudiante.
- Límites de uso: login por cuenta + IP (8 fallos / 15 min) y tope amplio por IP; registro 120/hora
  por IP. El límite del chat se aplica antes de leer los adjuntos.
- Las contraseñas se procesan con `scrypt` asíncrono; el login tarda lo mismo exista o no el usuario.
- Nombres de usuario normalizados y restringidos (sin caracteres invisibles); índice único por `userId`.
- Cabeceras de seguridad (CSP, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy).
- Los errores de Mongo ya no se devuelven al cliente.
- "Reintentar" (si se muestra) reenvía la última pregunta con sus archivos y sin duplicarla.
- El estado de salud solo se recuerda si está bien (antes un error puntual se quedaba hasta recargar).

**Pruebas:** 49 pruebas (`npm test`), incluidos los endpoints completos con BD y OpenAI simulados.

---

## Revisión de seguridad y limpieza

**Seguridad**
- `TOKEN_SECRET` ya no tiene valor por defecto en el código (era público en el repositorio):
  sin la variable, o con menos de 32 caracteres, el servidor no emite ni valida sesiones.
- Eliminado `api/test-chat.js` (público, sin autenticación, gastaba saldo de OpenAI en cada visita).
- `/api/health` ahora guarda el resultado en memoria (5 min si todo va bien, 15 s si falla),
  reutiliza el pool de MongoDB y limita el tiempo de la llamada a OpenAI.
- Límite de uso: 30 mensajes/hora y 150/día por estudiante en el chat (configurable),
  5 registros/hora y 20 intentos de login/15 min por IP. Las IP se guardan sólo como hash.
- CORS restringido a `ALLOWED_ORIGINS` (por defecto `https://mimiria.vercel.app`) en lugar de `*`.
- Las URLs de las fuentes se validan en el servidor, al leer de la caché y en el navegador
  (sólo `http`/`https`; se descartan `javascript:`, `data:`, etc.).
- Anti zip bomb: tope de 8 MB por entrada descomprimida, 32 MB en total y 2000 entradas;
  igual para los streams de PDF.
- Los archivos adjuntos se encierran entre marcas `<<<ARCHIVO …>>>` y el prompt del sistema
  indica que su contenido es material de estudio, no instrucciones.
- La respuesta de error del chat ya no incluye el mensaje interno (`details`).

**Robustez**
- Sólo se guardan en la caché respuestas que el modelo devolvió como JSON válido.
- Máximo 200 mensajes guardados por conversación (evita el tope de 16 MB de MongoDB).
- El índice único de usuarios se crea una vez por instancia, no en cada registro.
- El driver de MongoDB se carga bajo demanda.

**Calidad**
- Nuevas pruebas unitarias (`npm test`): tokens, contraseñas, URLs, caché, elección de modelo,
  extracción de documentos, zip bomb, límite de uso y CORS.
- README reescrito, `DEPLOY.md` y `VERCEL_DEPLOY.md` unificados en `DEPLOY.md`
  (ya no menciona Gemini). `CAMBIOS.md` pasó a `CHANGELOG.md`.
- `/chat` fuera del sitemap (estaba bloqueado en `robots.txt`).

**Sin cambiar (decisión pendiente)**
- Límites de archivos: el README histórico decía 20 MB; el servidor sigue aceptando 8 MB por
  archivo y 3.5 MB por petición cuando el navegador no puede extraer el texto.
- Los IDs de estudiante pueden tener huecos si un registro falla tras avanzar el contador.
- Los textos legales no han sido revisados por un abogado.

---

## Entrega anterior — funciones y correcciones

Partí del ZIP que me enviaste (el que corresponde a mimiria.vercel.app), **no**
del que te devolví antes. Esa landing morada era otra versión del archivo; la
descarté por completo. El diseño verde, los textos, las imágenes y las zonas
clicables quedan exactamente como estaban: no moví un solo color, título ni
sección del original.

## Verificación

Compilé el proyecto y lo abrí en un navegador real (Chromium) para comprobarlo,
no solo leyendo el código:

- Las 13 secciones renderizan: navbar, hero, chat teaser, características, cómo
  funciona, sobre MIMIRIA, carrusel, institución, FAQ y pie.
- Cero errores de JavaScript en consola.
- El modo oscuro aplica (`body` pasa a `rgb(11, 17, 32)`).
- El carrusel avanza, el FAQ despliega y el modal de registro abre.
- `npx tsc --noEmit` y `npm run build` pasan limpios.

Lo único que no pude ver son las fotos de ImgBB, Unsplash y del sitio del
colegio, porque mi entorno no tiene acceso a internet. Los `<img>` y las rutas
están intactos, así que en tu despliegue cargan igual que ahora.

---

## 1. Archivos: hasta 20 MB y 5 fotos por carga

Formatos aceptados: **fotos** (JPG, PNG, GIF, WEBP), **PDF**, **Word .docx**,
**Excel .xlsx/.xlsm**, **PowerPoint .pptx**, y texto/código (txt, md, csv, tsv,
json, xml, html y unas veinte extensiones más).

Límites: 20 MB por archivo, 5 fotos y 5 documentos por envío.

### Cómo se logró el límite de 20 MB

Hay un obstáculo real: **Vercel rechaza cualquier petición de más de ~4.5 MB**.
Un PDF de 20 MB convertido a base64 pesa unos 27 MB, así que enviarlo al
servidor nunca podría funcionar, por mucho que el código lo permitiera.

La solución fue mover el trabajo al navegador (`src/lib/extract.ts`):

- **Documentos**: el texto se extrae en el equipo del estudiante y al servidor
  solo viaja ese texto (máximo 20.000 caracteres). Un PDF de 20 MB se convierte
  en unos pocos KB antes de salir del navegador.
- **Fotos**: se reducen a 1600 px de lado mayor y se recomprimen a JPEG antes de
  enviarlas. Una foto de celular de 20 MB queda en unos cientos de KB sin perder
  legibilidad.

Todo con `DecompressionStream`, que ya viene en el navegador: **no instalé
ninguna librería nueva**. Los formatos de Office son ZIP con XML dentro, y los
PDF guardan su contenido comprimido con el mismo algoritmo.

Lo probé con un .docx, .xlsx, .pptx, tres PDF distintos (FlateDecode,
ASCII85+Flate y sin comprimir), un .csv y un .md generados de verdad,
verificando acentos, ñ, símbolos escapados, tablas, varias hojas, varias
diapositivas y cadenas hexadecimales.

### Lo que no funciona, y la app lo dice

- **`.doc`, `.xls`, `.ppt` antiguos**: son binarios OLE, otro formato. El aviso
  pide guardarlos como `.docx`/`.xlsx`/`.pptx`.
- **PDF escaneados**: no hay OCR. Si el PDF no tiene capa de texto, el mensaje
  sugiere subir la página como foto, que sí funciona porque la lee el modelo de
  visión.
- **Navegadores muy viejos** sin `DecompressionStream` (Safari anterior a 16.4):
  avisa y sugiere actualizar.

## 2. nano para lo simple, mini para lo complejo

`chooseModel()` en `api/chat.js`, con el motivo de cada decisión en los logs de
Vercel para que puedas afinarlo con casos reales.

**gpt-5-nano** con saludos y cortesías, preguntas sobre el propio MIMIR
("¿quién eres?") y datos puntuales cortos ("¿cuál es la capital de Colombia?",
"¿en qué año nació Simón Bolívar?").

**gpt-5-mini** en todo lo demás y siempre que haya adjuntos: señales de
razonamiento (analiza, compara, resuelve, demuestra, ensayo, código, paso a
paso, por qué, diferencia entre…), notación matemática y mensajes con varias
preguntas.

El umbral está del lado de mini a propósito: el valor de un tutor está en la
explicación con fuentes, y ahí el modelo pequeño se queda corto.

## 3. Caché de preguntas

Reemplacé la caché anterior, que tenía un problema serio de rendimiento: cargaba
**toda** la colección en memoria en cada pregunta y comparaba una por una. Con
unos cientos de entradas eso ya se nota; con unos miles, la función se cae.

La nueva usa la clave primaria de MongoDB: el SHA-256 de la pregunta
normalizada (minúsculas, sin tildes, sin signos, sin muletillas). Una sola
búsqueda indexada, sin importar cuántas entradas haya. Estas cinco comparten
entrada:

```
¿Qué es la fotosíntesis?      Explícame qué es la fotosíntesis por favor
que es la fotosintesis         QUE ES LA FOTOSINTESIS!!
Oye, ¿qué es la fotosíntesis?
```

Y "¿por qué llueve?" y "¿qué es la lluvia?" siguen dando claves distintas, que
es lo importante. Solo se cachean preguntas independientes: si hay adjuntos o la
conversación ya tiene mensajes, la respuesta depende del contexto y reutilizarla
daría resultados equivocados. Caducan solas a los 30 días con un índice TTL.

En el chat, las respuestas de caché llevan debajo un aviso discreto.

## 4. Modo claro y oscuro

El botón flotante ya existía y funciona bien; lo dejé igual. Lo que sí arreglé:
**los modales estaban con los colores fijos en claro** (`bg-[#FDFCF8]`,
`text-[#0F172A]`), así que en modo oscuro salía un panel blanco. Ahora usan las
variables del tema. En modo claro se ven idénticos a antes.

También faltaban las animaciones `animate-overlay-in` y `animate-modal-in`: las
clases se usaban en el Dialog pero no estaban definidas en el CSS, así que los
modales aparecían de golpe.

## 5. Términos, Privacidad y Contacto

Nueva columna "Legal y contacto" en el pie, con tres enlaces. Al pasar el mouse
aparece una tarjeta flotante con el resumen y tres puntos clave; al hacer clic
se abre el texto completo. En móvil no hay hover, así que el toque abre
directamente el detalle.

- **Términos y condiciones**: 8 apartados reales (quién puede usarlo, uso
  aceptable, límites de la IA, archivos, disponibilidad, propiedad intelectual).
- **Política de privacidad**: 7 apartados, con la Ley 1581 de 2012, qué datos se
  guardan, con quién se comparten (OpenAI, MongoDB Atlas, Vercel), cómo funciona
  la caché y cómo pedir que borren tu cuenta.
- **Contacto**: correo `Cristiancaro027@gmail.com` (abre el cliente de correo con
  asunto) y WhatsApp `+57 324 472 8516` (abre el chat con mensaje inicial).

Además, un **botón flotante de WhatsApp** en la esquina inferior derecha, encima
del de tema, con su etiqueta al pasar el mouse.

Los textos legales los escribí yo según lo que hace la aplicación. **No son un
documento revisado por un abogado**: para un proyecto del SENA sirven, pero si
la plataforma se abre a más colegios conviene que alguien con formación jurídica
les dé una pasada.

---

## Correcciones de fallos

Además de lo que pediste, arreglé esto:

1. **`api/chat.js` enviaba `temperature: 0.7`**, que los modelos gpt-5 no
   aceptan: la API devolvía 400 en cada llamada.
2. **Dos secretos de token distintos**: `_lib.js` usaba uno y
   `login/register/conversations` otro. Si `TOKEN_SECRET` no estaba configurada,
   `/api/me` rechazaba los tokens recién emitidos por `/api/login` y la sesión no
   sobrevivía a un refresco.
3. **Los tokens no caducaban nunca**: se firmaban sin campo `exp`.
4. **El cuerpo de las peticiones se leía del stream ya consumido**
   (`for await (const chunk of req)`). En Vercel `req.body` ya viene parseado, así
   que se leía vacío: por eso el título de las conversaciones siempre quedaba en
   "Nueva conversación".
5. **Conexión nueva a MongoDB en cada petición**, y varias rutas de error la
   dejaban sin cerrar. Ahora hay un pool compartido.
6. **Registro con condición de carrera**: sin índice único, dos registros
   simultáneos con el mismo nombre creaban usuarios duplicados.
7. **Comparaciones sensibles a timing** en la contraseña y en la firma del token.
8. **CORS**: el comentario decía que las cabeceras las ponía `vercel.json`, pero
   ahí no había ninguna sección `headers`.
9. **`<button>` dentro de `<button>`** en la lista de conversaciones: HTML
   inválido, con el clic propagándose de forma impredecible.
10. **`/api/health` no devolvía los campos que lee el frontend** (`mongoError`,
    `openaiError`), y marcaba `ok` mirando solo MongoDB: la app se declaraba "en
    línea" aunque la IA no pudiera responder.
11. **`.gitignore` con comillas de markdown**: no ignoraba nada, por eso
    `node_modules/` venía dentro del ZIP.
12. **Diez dependencias sin usar** (`@supabase/supabase-js`, `framer-motion`,
    `recharts`, `@dnd-kit/*`, `embla-carousel-react`, `date-fns`, `uuid`,
    `canvas-confetti`). Ninguna se importa en el código.

## Antes de desplegar

1. `rm -rf node_modules dist && npm install` — borré `package-lock.json` porque
   quedó desfasado al quitar dependencias; se regenera solo.
2. En Vercel → Settings → Environment Variables: `MONGODB_URI`, `OPENAI_API_KEY`
   y `TOKEN_SECRET`. Si cambias `TOKEN_SECRET`, todas las sesiones abiertas se
   cierran.
3. Comprueba `https://mimiria.vercel.app/api/health`: debe responder
   `{"ok": true, "mongo": true, "openai": true}`.

Lo que no pude probar por falta de red: la llamada real a OpenAI y la conexión
real a MongoDB Atlas. Eso lo sabrás en el primer despliegue con `/api/health`.

## Detalles que quizá quieras revisar

- Una de las imágenes del carrusel (`IMG_AUTODIDACTA`) viene de
  `encrypted-tbn0.gstatic.com`, que es la caché de miniaturas de Google
  Imágenes: puede desaparecer en cualquier momento y su licencia es dudosa.
  Conviene subirla a ImgBB con las demás.
- `api/test-chat.js` expone diagnóstico del servidor sin autenticación. Es útil
  mientras despliegas; bórralo cuando esté estable.
- La caché es global entre todos los estudiantes. Para preguntas académicas es
  justo lo que quieres, pero si algún día agregas respuestas personalizadas
  ("¿cómo van mis notas?"), hay que incluir el `userId` en la clave.
