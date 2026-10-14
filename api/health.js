/**
 * GET /api/health — diagnóstico del servidor.
 *
 * Es público (el frontend lo usa para saber si la app está en línea), así que:
 *   - NO es caro: el resultado se guarda en memoria unos minutos y reutiliza el
 *     pool de MongoDB.
 *   - NO filtra detalles: los mensajes públicos son genéricos. Los errores reales
 *     (que pueden incluir pedazos de la clave de OpenAI o nombres de servidor) van
 *     a los logs de Vercel, y sólo se devuelven si la petición trae
 *     `?key=<HEALTH_DEBUG_KEY>` (variable opcional que defines tú).
 */
import crypto from "node:crypto";
import { getDb, getTokenSecret, mongoHint, preflight, send } from "./_lib.js";

const TTL_OK_MS = 5 * 60_000;   // si todo está bien, se reutiliza 5 minutos
const TTL_FAIL_MS = 15_000;     // si algo falla, se reintenta pronto

const PUBLIC_MESSAGES = {
  mongoError: "No se pudo conectar a la base de datos.",
  openaiError: "La IA no está disponible en este momento.",
  configError: "El servidor tiene un problema de configuración.",
};

function hasDebugAccess(req) {
  const expected = process.env.HEALTH_DEBUG_KEY;
  const given = String(req.query?.key || "");
  if (!expected || expected.length < 16 || !given) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Vista pública: booleanos + mensajes genéricos. Con clave: detalle completo. */
function view(full, debug) {
  const out = { ...full, details: undefined };
  if (!debug) {
    for (const k of Object.keys(PUBLIC_MESSAGES)) {
      if (full[k]) out[k] = PUBLIC_MESSAGES[k];
    }
  } else {
    out.details = full.details;
  }
  return out;
}

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== "GET") return send(res, 405, { error: "Método no permitido" });

  const debug = hasDebugAccess(req);

  const cached = globalThis.__mimirHealth;
  if (cached && Date.now() < cached.until) {
    return send(res, cached.result.ok ? 200 : 503, view(cached.result, debug));
  }

  const result = {
    ok: false,
    build: "mimir-v8",
    mongo: false,
    mongoError: null,
    openai: false,
    openaiError: null,
    config: false,
    configError: null,
    details: {},
  };

  try {
    getTokenSecret();
    result.config = true;
  } catch (e) {
    result.configError = "config";
    result.details.config = e.message.split(" Genera")[0];
    console.error("[HEALTH]", result.details.config);
  }

  if (!process.env.MONGODB_URI) {
    result.mongoError = "mongo";
    result.details.mongo = "Falta la variable MONGODB_URI.";
    console.error("[HEALTH]", result.details.mongo);
  } else {
    try {
      const db = await getDb();
      await db.command({ ping: 1 });
      result.mongo = true;
    } catch (e) {
      result.mongoError = "mongo";
      result.details.mongo = mongoHint(e);
      console.error("[HEALTH] Mongo:", e?.message);
    }
  }

  if (!process.env.OPENAI_API_KEY) {
    result.openaiError = "openai";
    result.details.openai = "Falta la variable OPENAI_API_KEY.";
    console.error("[HEALTH]", result.details.openai);
  } else {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const response = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      result.openai = response.ok;
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        result.openaiError = "openai";
        result.details.openai = `OpenAI respondió ${response.status}: ${errData?.error?.message || "error desconocido"}`;
        console.error("[HEALTH] OpenAI:", result.details.openai);
      }
    } catch (e) {
      result.openaiError = "openai";
      result.details.openai = "No se pudo contactar a OpenAI: " + (e?.message || "error de red");
      console.error("[HEALTH]", result.details.openai);
    }
  }

  // El chat necesita los tres: base de datos, IA y secreto de sesión.
  result.ok = result.mongo && result.openai && result.config;

  globalThis.__mimirHealth = { result, until: Date.now() + (result.ok ? TTL_OK_MS : TTL_FAIL_MS) };
  return send(res, result.ok ? 200 : 503, view(result, debug));
}
