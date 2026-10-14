/**
 * Utilidades compartidas por las funciones serverless de MIMIR IA (Vercel).
 * Variables de entorno requeridas: MONGODB_URI, OPENAI_API_KEY, TOKEN_SECRET.
 */
import crypto from "node:crypto";
import { promisify } from "node:util";

const MONGODB_URI = process.env.MONGODB_URI;
export const DB_NAME = "mimiria";

/**
 * Un único secreto para TODA la app, SIN valor por defecto.
 * Antes había un secreto de respaldo escrito en el código (y por tanto público
 * en el repositorio): cualquiera podía fabricar tokens válidos si la variable
 * no estaba configurada. Ahora, sin TOKEN_SECRET (o con menos de 32 caracteres)
 * el servidor se niega a emitir o validar tokens.
 */
export function getTokenSecret() {
  const secret = process.env.TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "TOKEN_SECRET no está configurada o es demasiado corta (mínimo 32 caracteres). " +
        'Genera una con: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
  }
  return secret;
}

/* ---------------- Conexión a MongoDB (pool reutilizado entre invocaciones) ---------------- */
export function getDb() {
  if (!MONGODB_URI) throw new Error("MONGODB_URI no está configurada");
  if (!globalThis.__mimirMongo) {
    // Import dinámico: el driver sólo se carga cuando de verdad se necesita.
    globalThis.__mimirMongo = import("mongodb").then(({ MongoClient }) =>
      MongoClient.connect(MONGODB_URI, {
        maxPoolSize: 5,
        serverSelectionTimeoutMS: 8000,
        appName: "mimiria",
      })
    ).catch((err) => {
      // Si falla la conexión hay que descartar la promesa cacheada,
      // si no la función queda "envenenada" hasta el próximo cold start.
      globalThis.__mimirMongo = null;
      throw err;
    });
  }
  return globalThis.__mimirMongo.then((client) => client.db(DB_NAME));
}

/** Traduce errores típicos de MongoDB a mensajes útiles (sin revelar la URI). */
export function mongoHint(err) {
  const msg = String(err?.message || err || "");
  if (/TOKEN_SECRET/.test(msg)) return msg.split(" Genera")[0];
  if (/Invalid scheme/i.test(msg)) {
    return 'La variable MONGODB_URI no es una cadena de conexión válida: debe empezar con "mongodb://" o "mongodb+srv://". En MongoDB Atlas ve a Database → Connect → Drivers, copia la cadena y reemplaza <username> y <password> por tus datos reales (sin los símbolos < >). Verifica que en Vercel la variable se llame exactamente MONGODB_URI y haz Redeploy.';
  }
  if (/Server selection timed out|ECONNREFUSED|ENOTFOUND|network/i.test(msg)) {
    return "No se pudo conectar a MongoDB. Verifica la variable MONGODB_URI y en Atlas → Network Access permite la IP 0.0.0.0/0. Después haz Redeploy en Vercel.";
  }
  if (/bad auth|Authentication failed|auth/i.test(msg)) {
    return "MongoDB rechazó la autenticación. Revisa usuario y contraseña dentro de MONGODB_URI (caracteres especiales deben ir codificados, ej. @ como %40).";
  }
  // El detalle real va a los logs de Vercel, no al cliente (puede incluir nombres de servidor).
  console.error("[DB]", msg.slice(0, 300));
  return "Error de base de datos. Intenta de nuevo en unos segundos.";
}

/* ---------------- URLs de fuentes (vienen del modelo: no son de fiar) ---------------- */
/** Devuelve la URL normalizada sólo si es http(s); si no (javascript:, data:…), null. */
export function safeUrl(value) {
  try {
    const u = new URL(String(value || "").trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Fuentes: el modelo NO inventa URLs (las inventadas suelen dar 404). Elige un sitio
 * de esta lista y un tema a buscar, y el servidor construye un enlace de búsqueda que
 * siempre existe (en Wikipedia, si el título coincide, abre directamente el artículo).
 */
const enc = encodeURIComponent;
export const SOURCE_SITES = {
  wikipedia: { name: "Wikipedia", url: (q) => `https://es.wikipedia.org/w/index.php?search=${enc(q)}&go=Go` },
  khan_academy: { name: "Khan Academy", url: (q) => `https://es.khanacademy.org/search?page_search_query=${enc(q)}` },
  britannica: { name: "Britannica", url: (q) => `https://www.britannica.com/search?query=${enc(q)}` },
  mdn: { name: "MDN Web Docs", url: (q) => `https://developer.mozilla.org/es/search?q=${enc(q)}` },
  scielo: { name: "SciELO", url: (q) => `https://search.scielo.org/?q=${enc(q)}` },
  google_scholar: { name: "Google Académico", url: (q) => `https://scholar.google.com/scholar?q=${enc(q)}` },
  wolfram_alpha: { name: "Wolfram Alpha", url: (q) => `https://www.wolframalpha.com/input?i=${enc(q)}` },
};

/** Filtra y limpia la lista de fuentes del modelo (nuevo formato site+query, o url antigua de la caché). */
export function sanitizeSources(list, max = 6) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list) {
    let url = null;
    let label = null;
    const site = SOURCE_SITES[s?.site];
    const query = String(s?.query || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (site && query) {
      url = site.url(query);
      label = `${site.name} — ${query}`;
    } else {
      url = safeUrl(s?.url);
      label = s?.label;
    }
    if (!url) continue;
    out.push({ label: String(s?.label || label || url).slice(0, 120), url });
    if (out.length >= max) break;
  }
  return out;
}

/* ---------------- Límite de uso (rate limiting) en MongoDB ---------------- */
/**
 * Contador por ventana fija: una fila por (clave, ventana) con índice TTL.
 * Sirve para proteger el saldo de OpenAI y frenar el abuso del registro/login.
 * Si MongoDB falla, no se bloquea al usuario (el resto del handler fallará solo).
 */
let rateIndexReady = false;

export async function rateLimit(db, key, limit, windowSec) {
  try {
    const col = db.collection("rate_limits");
    if (!rateIndexReady) {
      rateIndexReady = true;
      await col.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {
        rateIndexReady = false;
      });
    }
    const windowMs = windowSec * 1000;
    const bucket = Math.floor(Date.now() / windowMs);
    const doc = await col.findOneAndUpdate(
      { _id: `${key}:${bucket}` },
      {
        $inc: { count: 1 },
        $setOnInsert: { expireAt: new Date((bucket + 1) * windowMs + 60_000) },
      },
      { upsert: true, returnDocument: "after" }
    );
    const count = (doc?.value ?? doc)?.count ?? 1;
    const retryAfter = Math.max(1, Math.ceil(((bucket + 1) * windowMs - Date.now()) / 1000));
    return { allowed: count <= limit, count, limit, retryAfter };
  } catch (e) {
    console.error("[RATE] Error:", e.message);
    return { allowed: true, count: 0, limit, retryAfter: 0 };
  }
}

/** Cuenta actual de una ventana SIN incrementarla (para contar sólo los fallos). */
export async function rateCount(db, key, windowSec) {
  try {
    const windowMs = windowSec * 1000;
    const bucket = Math.floor(Date.now() / windowMs);
    const doc = await db.collection("rate_limits").findOne({ _id: `${key}:${bucket}` });
    const retryAfter = Math.max(1, Math.ceil(((bucket + 1) * windowMs - Date.now()) / 1000));
    return { count: doc?.count || 0, retryAfter };
  } catch (e) {
    console.error("[RATE] Error:", e.message);
    return { count: 0, retryAfter: 0 };
  }
}

/** IP del cliente, guardada sólo como hash (no se almacenan IPs en claro). */
export function clientKey(req) {
  const raw =
    req.headers["x-vercel-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    String(req.headers["x-forwarded-for"] || "").split(",")[0] ||
    req.socket?.remoteAddress ||
    "unknown";
  return crypto.createHash("sha256").update(String(raw).trim()).digest("hex").slice(0, 24);
}

/** Responde 429 con Retry-After. */
export function tooMany(res, result, what) {
  res.setHeader("Retry-After", String(result.retryAfter));
  return send(res, 429, {
    error: `${what} Intenta de nuevo en ${Math.ceil(result.retryAfter / 60)} min.`,
  });
}

/** Crea una sola vez (por instancia) el índice único de usuarios. */
let usersIndexReady = null;
export function ensureUserIndexes(db) {
  if (!usersIndexReady) {
    const users = db.collection("users");
    usersIndexReady = Promise.all([
      users.createIndex({ usernameLower: 1 }, { unique: true }),
      // Mejor esfuerzo: si la base ya tuviera datos raros, no debe impedir registrarse.
      users.createIndex({ userId: 1 }, { unique: true }).catch((e) => console.error("[DB] índice userId:", e.message)),
    ])
      .catch((e) => {
        usersIndexReady = null;
        throw e;
      });
  }
  return usersIndexReady;
}

/* ---------------- Contraseñas (scrypt asíncrono, sin dependencias nativas) ---------------- */
const scryptAsync = promisify(crypto.scrypt);

export async function hashPassword(password, salt) {
  const key = await scryptAsync(String(password), salt, 64);
  return Buffer.from(key).toString("hex");
}

/** Comparación en tiempo constante de dos hashes hexadecimales. */
export async function verifyPassword(password, salt, expectedHex) {
  const actual = Buffer.from(await hashPassword(password, salt), "hex");
  const expected = Buffer.from(String(expectedHex || ""), "hex");
  if (actual.length !== expected.length || expected.length === 0) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/* ---------------- Nombres de usuario ---------------- */
/** Normaliza (NFC, espacios simples) para que "José" y "Jose\u0301" sean el mismo nombre. */
export function normalizeUsername(raw) {
  return String(raw || "").normalize("NFC").replace(/\s+/g, " ").trim();
}
/** Sólo letras, números, espacios y . _ ' - (nada de caracteres invisibles ni símbolos raros). */
export const USERNAME_RE = /^[\p{L}\p{N} ._'-]{2,40}$/u;

/* ---------------- Tokens de sesión (HMAC) ---------------- */
export function signToken(payload, ttlHours = 24 * 30) {
  const body = Buffer
    .from(JSON.stringify({ ...payload, exp: Date.now() + ttlHours * 3600_000 }))
    .toString("base64url");
  const sig = crypto.createHmac("sha256", getTokenSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  try {
    const [body, sig] = String(token || "").split(".");
    if (!body || !sig) return null;
    const expected = crypto.createHmac("sha256", getTokenSecret()).update(body).digest("base64url");
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ---------------- HTTP helpers ---------------- */
/**
 * CORS restringido. El frontend y la API viven en el mismo dominio, así que las
 * peticiones normales ni siquiera necesitan CORS. Sólo se permite explícitamente
 * a los orígenes de ALLOWED_ORIGINS (separados por coma); por defecto, el sitio
 * en producción. Antes se enviaba `Access-Control-Allow-Origin: *`.
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://mimiria.vercel.app")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export function cors(res, req) {
  res.setHeader("Vary", "Origin");
  const origin = req?.headers?.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

export function send(res, status, body) {
  cors(res, res.req);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(status).json(body);
}

/**
 * Responde el preflight CORS (OPTIONS) con 204.
 * Devuelve true si ya se respondió (para que el handler haga `return`).
 */
export function preflight(req, res) {
  cors(res, req);
  if (req.method !== "OPTIONS") return false;
  res.status(204).end();
  return true;
}

/**
 * Lee el cuerpo JSON de la petición.
 * En Vercel `req.body` ya viene parseado para application/json: leer el stream
 * con `for await (const chunk of req)` devuelve vacío porque ya se consumió.
 * Por eso se comprueba req.body ANTES de tocar el stream.
 */
export async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))).toString("utf8");
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

/* ---------------- Autenticación ---------------- */
export function authPayload(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const payload = verifyToken(token);
  if (!payload || typeof payload.userId !== "number") return null;
  return payload;
}

export async function authUser(req) {
  const payload = authPayload(req);
  if (!payload) return null;
  const db = await getDb();
  const user = await db.collection("users").findOne({ userId: payload.userId });
  return user || null;
}

/* ---------------- ID correlativo de estudiante ---------------- */
export const displayId = (n) => `#${String(n).padStart(3, "0")}`;

export async function nextUserId(db) {
  const doc = await db
    .collection("counters")
    .findOneAndUpdate(
      { _id: "users" },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" }
    );
  // El driver v5 devuelve { value }, el v6+ devuelve el documento directamente.
  const value = doc?.value ?? doc;
  const seq = value?.seq;
  if (typeof seq !== "number") throw new Error("No se pudo generar el ID de estudiante");
  return seq;
}

/* ============================================================================
   Caché de preguntas frecuentes
   --------------------------------------------------------------------------
   Muchos estudiantes preguntan exactamente lo mismo ("¿qué es la fotosíntesis?").
   Guardar la respuesta y reutilizarla ahorra tokens y responde al instante.
   ========================================================================== */

export const CACHE_COLLECTION = "qa_cache";
export const CACHE_TTL_DAYS = 30;

/** Muletillas que no cambian el significado de la pregunta. */
const FILLERS = [
  /^(oye|hola|hey|buenas)[,\s]+/,
  /^(por favor|porfa|porfis)[,\s]+/,
  /^(me puedes|puedes|podr[ií]as|me podr[ií]as)\s+(explicar|decir|contar|ayudar con)\s+/,
  /^(explicame|expl[ií]came|dime|cu[eé]ntame|ay[uú]dame con)\s+/,
  /[,\s]+(por favor|porfa|gracias)[.!?]*$/,
];

/**
 * Normaliza la pregunta para que variantes triviales compartan la misma entrada:
 * minúsculas, sin tildes, sin signos repetidos, sin muletillas y sin espacios
 * sobrantes. NO se tocan las palabras interrogativas ("qué", "por qué"…),
 * porque cambian la respuesta.
 */
export function normalizeQuestion(question) {
  let q = String(question || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")   // quitar tildes
    .replace(/\s+/g, " ")
    .trim();

  for (const re of FILLERS) q = q.replace(re, "").trim();

  return q
    .replace(/^[¿¡]+/, "")
    .replace(/[?!.¿¡]+$/, "")
    .trim();
}

/**
 * ¿Es seguro compartir la respuesta con otros estudiantes? No si el mensaje trae datos
 * personales (nombre, teléfono, correo, números largos…) o es muy largo/personalizado.
 */
const PERSONAL_RE =
  /\d{4,}|@|(?:^|[^\p{L}])(?:me llamo|mi nombre|mi apellido|mi (?:n[uú]mero|tel[eé]fono|celular|direcci[oó]n|c[eé]dula|correo|colegio|curso|profesor|profesora|profe|mam[aá]|pap[aá]|nota|notas))(?![\p{L}])/iu;
const SOY_NOMBRE_RE = /(?:^|[^\p{L}])[Ss]oy [A-ZÁÉÍÓÚÑ][a-záéíóúñ]+/u;

export function isCacheable(message) {
  const m = String(message || "");
  if (m.length === 0 || m.length > 300) return false;
  return !PERSONAL_RE.test(m) && !SOY_NOMBRE_RE.test(m);
}

/** Clave de caché: SHA-256 de la pregunta normalizada. */
export function cacheKey(question) {
  const normalized = normalizeQuestion(question);
  if (normalized.length < 8) return null; // demasiado corta para ser útil
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

let cacheIndexReady = false;

async function ensureCacheIndexes(db) {
  if (cacheIndexReady) return;
  cacheIndexReady = true;
  try {
    // Índice TTL: MongoDB borra solo las entradas viejas.
    await db.collection(CACHE_COLLECTION).createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: CACHE_TTL_DAYS * 24 * 3600 }
    );
  } catch (e) {
    cacheIndexReady = false;
    console.error("[CACHE] No se pudo crear el índice TTL:", e.message);
  }
}

/**
 * Busca una respuesta guardada. Un fallo de caché NUNCA debe tumbar el chat,
 * así que cualquier error se registra y se devuelve null (se llama a la IA).
 */
export async function readCache(db, key) {
  if (!key) return null;
  try {
    await ensureCacheIndexes(db);
    const doc = await db.collection(CACHE_COLLECTION).findOneAndUpdate(
      { _id: key },
      { $inc: { hits: 1 }, $set: { lastUsedAt: new Date() } },
      { returnDocument: "after" }
    );
    const hit = doc?.value ?? doc;
    return hit && typeof hit.text === "string" ? hit : null;
  } catch (e) {
    console.error("[CACHE] Error al leer:", e.message);
    return null;
  }
}

/** Guarda una respuesta nueva en la caché. */
export async function writeCache(db, key, { question, text, sources, followups, model }) {
  if (!key || !text) return;
  try {
    await ensureCacheIndexes(db);
    await db.collection(CACHE_COLLECTION).updateOne(
      { _id: key },
      {
        $set: {
          question: String(question).slice(0, 500),
          normalized: normalizeQuestion(question),
          text,
          sources: sources || [],
          followups: followups || [],
          model,
          createdAt: new Date(),
          lastUsedAt: new Date(),
        },
        $setOnInsert: { hits: 0 },
      },
      { upsert: true }
    );
  } catch (e) {
    console.error("[CACHE] Error al guardar:", e.message);
  }
}
