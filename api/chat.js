/**
 * POST /api/chat
 *
 * Body JSON:
 *   {
 *     conversationId: string,
 *     message: string,
 *     images?:    [{ name, type, dataUrl }],   // jpg, png, gif, webp
 *     documents?: [{ name, text }]             // texto ya extraído en el navegador
 *   }
 *
 * Respuesta:
 *   { text, sources[], followups[], model, fromCache, attachments[] }
 *
 * Orden de trabajo:
 *   1. Autenticación y límite de uso (ANTES de procesar archivos, que es lo caro).
 *   2. Se leen los adjuntos y se convierten a texto (o a imágenes para visión).
 *   3. Caché de MongoDB (sólo preguntas sueltas y sin datos personales).
 *   4. Se elige modelo / esfuerzo / presupuesto (ver _ai.js) y se llama a OpenAI.
 */
import {
  getDb,
  mongoHint,
  preflight,
  readBody,
  send,
  authPayload,
  cacheKey,
  isCacheable,
  readCache,
  writeCache,
  rateLimit,
  sanitizeSources,
  tooMany,
} from "./_lib.js";
import {
  SYSTEM_PROMPT,
  TUTOR_SCHEMA,
  callOpenAI,
  chooseModel,
  parseTutorReply,
  planPrompt,
} from "./_ai.js";
import { extractText, SUPPORTED_EXTENSIONS } from "./_extract.js";
import { ObjectId } from "mongodb";

// Se re-exporta para no romper a quien lo importaba desde aquí (pruebas).
export { chooseModel };

const MAX_HISTORY = 12;                    // mensajes previos enviados al modelo
const MAX_HISTORY_CHARS = 6000;            // recorte por mensaje del historial (ahorra tokens)
const MAX_MESSAGE_CHARS = 4000;            // largo máximo de la pregunta
const MAX_IMAGES = 5;                      // 5 fotos por carga
const MAX_DOCUMENTS = 5;
const MAX_FILE_BYTES = 8 * 1024 * 1024;    // por archivo, ya decodificado
const MAX_TOTAL_BYTES = 3.5 * 1024 * 1024; // Vercel corta el body sobre ~4.5 MB
const MAX_DOC_CHARS = 20_000;              // texto que se manda por documento
const MAX_STORED_MESSAGES = 200;           // tope de mensajes guardados por conversación
const REQUEST_BUDGET_MS = 55_000;          // vercel.json da 60 s a esta función

// Límites de uso por estudiante (protegen el saldo de OpenAI). Ajustables por entorno.
const CHAT_LIMIT_HOUR = Number(process.env.CHAT_LIMIT_HOUR) || 30;
const CHAT_LIMIT_DAY = Number(process.env.CHAT_LIMIT_DAY) || 150;

// Tipos de imagen que OpenAI acepta para visión (SVG y otros no).
const IMAGE_DATA_URL = /^data:image\/(?:png|jpe?g|webp|gif);base64,/i;

/* ============================================================================
   Adjuntos
   ========================================================================== */

function decodeBase64(value) {
  const comma = String(value || "").indexOf(",");
  const payload = comma >= 0 ? value.slice(comma + 1) : value;
  return Buffer.from(payload, "base64");
}

/**
 * Encierra el contenido de un archivo entre marcas claras. El system prompt le
 * dice al modelo que lo de dentro es material de estudio, no instrucciones.
 * Se neutraliza cualquier marca falsa que el propio archivo intente incluir.
 */
function wrapFile(name, text) {
  const safeName = String(name).replace(/[<>\n\r]/g, " ").slice(0, 120);
  const safeText = String(text).replace(/<<<ARCHIVO|ARCHIVO>>>/g, "[marca eliminada]");
  return `<<<ARCHIVO ${safeName}>>>\n${safeText}\nARCHIVO>>>`;
}

/**
 * Prepara los documentos para el prompt.
 *
 * Lo normal es que el navegador ya haya extraído el texto (src/lib/extract.ts)
 * y mande `{ name, text }`: así un PDF de 20 MB no tiene que viajar entero, que
 * es imposible con el tope de ~4.5 MB por petición de Vercel. Si en cambio
 * llega `{ name, base64 }` (cliente antiguo o navegador sin DecompressionStream),
 * el servidor lo extrae aquí.
 */
function processDocuments(documents) {
  const blocks = [];
  const summary = [];

  for (const doc of documents.slice(0, MAX_DOCUMENTS)) {
    const name = String(doc?.name || "documento");

    // Camino normal: el texto ya viene extraído del navegador.
    if (typeof doc?.text === "string") {
      const text = doc.text.slice(0, MAX_DOC_CHARS);
      if (text.replace(/\s/g, "").length < 10) {
        summary.push({ name, ok: false, error: "El archivo no tiene texto legible." });
      } else {
        summary.push({ name, ok: true, truncated: Boolean(doc.truncated) });
        blocks.push(wrapFile(name, text));
      }
      continue;
    }

    let data;
    try {
      data = decodeBase64(doc?.base64);
    } catch {
      summary.push({ name, ok: false, error: "No se pudo decodificar el archivo." });
      continue;
    }

    if (!data.length || data.length > MAX_FILE_BYTES) {
      summary.push({ name, ok: false, error: "El archivo está vacío o es demasiado grande." });
      continue;
    }

    const result = extractText({ name, type: doc?.type, data }, { maxChars: MAX_DOC_CHARS });
    summary.push({ name, ok: result.ok, error: result.error, truncated: result.truncated });
    if (result.ok) {
      blocks.push(wrapFile(name, result.text));
    }
  }

  return { blocks, summary };
}

/* ============================================================================
   Handler
   ========================================================================== */

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== "POST") return send(res, 405, { error: "Método no permitido" });

  const payload = authPayload(req);
  if (!payload) return send(res, 401, { error: "Sesión inválida. Inicia sesión de nuevo." });

  if (!process.env.OPENAI_API_KEY) {
    return send(res, 503, { error: "El servidor no tiene configurada OPENAI_API_KEY." });
  }

  const deadline = Date.now() + REQUEST_BUDGET_MS;

  try {
    const body = await readBody(req);
    const message = String(body.message || "").trim();
    const conversationId = body.conversationId ? String(body.conversationId) : null;

    if (message.length > MAX_MESSAGE_CHARS) {
      return send(res, 400, {
        error: `Tu mensaje es muy largo (${message.length} caracteres). El máximo es ${MAX_MESSAGE_CHARS}.`,
      });
    }

    /* ---- 1. Límite de uso: ANTES de leer archivos (lo más costoso) ---- */
    const db = await getDb();
    const perHour = await rateLimit(db, `chat-h:${payload.userId}`, CHAT_LIMIT_HOUR, 3600);
    if (!perHour.allowed) return tooMany(res, perHour, `Llegaste al límite de ${CHAT_LIMIT_HOUR} mensajes por hora.`);
    const perDay = await rateLimit(db, `chat-d:${payload.userId}`, CHAT_LIMIT_DAY, 86400);
    if (!perDay.allowed) return tooMany(res, perDay, `Llegaste al límite de ${CHAT_LIMIT_DAY} mensajes por día.`);

    /* ---- 2. Adjuntos ---- */
    const rawImages = Array.isArray(body.images) ? body.images : [];
    const rawDocs = Array.isArray(body.documents) ? body.documents : [];

    const totalBase64 =
      rawImages.reduce((n, i) => n + String(i?.dataUrl || "").length, 0) +
      rawDocs.reduce((n, d) => n + String(d?.base64 || "").length, 0);
    if (totalBase64 > MAX_TOTAL_BYTES * 1.4) {
      return send(res, 413, {
        error: `Los archivos pesan demasiado en conjunto. Envía menos de ${Math.round(
          MAX_TOTAL_BYTES / 1024 / 1024
        )} MB por mensaje.`,
      });
    }

    const images = rawImages
      .filter((img) => img && typeof img.dataUrl === "string" && IMAGE_DATA_URL.test(img.dataUrl))
      .slice(0, MAX_IMAGES);
    const skippedImages = rawImages.length - images.length;

    const { blocks: docBlocks, summary: docSummary } = processDocuments(rawDocs);
    if (skippedImages > 0) {
      docSummary.push({
        name: "imagen",
        ok: false,
        error: "Solo puedo ver imágenes JPG, PNG, WEBP o GIF (no SVG ni otros formatos).",
      });
    }
    const hasAttachments = images.length > 0 || rawDocs.length > 0;

    if (!message && !hasAttachments) {
      return send(res, 400, { error: "Escribe una pregunta." });
    }

    // Si mandó archivos y ninguno se pudo leer, mejor decirlo que responder a ciegas.
    if (rawDocs.length + rawImages.length > 0 && docBlocks.length === 0 && images.length === 0) {
      const detail = docSummary.map((d) => `• ${d.name}: ${d.error}`).join("\n");
      return send(res, 422, {
        error:
          `No pude leer ${rawDocs.length + rawImages.length === 1 ? "el archivo" : "ninguno de los archivos"}.\n\n${detail}\n\n` +
          `Formatos que sí puedo leer: ${SUPPORTED_EXTENSIONS.join(", ")}, además de imágenes JPG, PNG, WEBP y GIF.`,
        attachments: docSummary,
      });
    }

    /* ---- 3. Historial de la conversación ---- */
    const col = db.collection("conversations");

    let convo = null;
    if (conversationId && ObjectId.isValid(conversationId)) {
      convo = await col.findOne({ _id: new ObjectId(conversationId), userId: payload.userId });
    }

    const history = (convo?.messages || [])
      .slice(-MAX_HISTORY)
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_CHARS) }));
    const lastAssistant = [...history].reverse().find((m) => m.role === "assistant")?.content || "";

    /* ---- 4. Modelo, esfuerzo y presupuesto ---- */
    const chosen = chooseModel(message, { hasAttachments, historyLength: history.length, lastAssistant });

    /* ---- 5. Caché ----
       Sólo preguntas independientes, sin datos personales y que no sean un plan
       (los planes son personales). Con adjuntos o historial, la respuesta
       depende del contexto y reutilizarla daría resultados equivocados. */
    const cacheable =
      !hasAttachments && history.length === 0 && chosen.intent !== "plan" && isCacheable(message);
    const key = cacheable ? cacheKey(message) : null;

    let reply = null;
    let model = null;
    let fromCache = false;

    if (key) {
      const hit = await readCache(db, key);
      if (hit) {
        reply = { text: hit.text, sources: sanitizeSources(hit.sources), followups: hit.followups || [] };
        model = hit.model || "caché";
        fromCache = true;
        console.log(`[CHAT] Caché HIT (uso nº ${(hit.hits || 0) + 1}) — 0 tokens gastados`);
      }
    }

    /* ---- 6. Llamada a OpenAI (sólo si no hubo caché) ---- */
    if (!reply) {
      model = chosen.model;
      console.log(`[CHAT] ${model} · ${chosen.intent} · esfuerzo ${chosen.effort} · ${chosen.reason}`);

      let userText = message || "Analiza los archivos que te envié y explícamelos.";
      if (docBlocks.length) {
        userText =
          `${userText}\n\n---\nContenido de los archivos que adjunté ` +
          `(úsalo para responder y menciona el nombre del archivo cuando te refieras a él):\n\n` +
          docBlocks.join("\n\n---\n\n");
      }

      const userContent = images.length
        ? [
            { type: "text", text: userText },
            ...images.map((img) => ({ type: "image_url", image_url: { url: img.dataUrl, detail: "high" } })),
          ]
        : userText;

      const systemPrompt = chosen.intent === "plan" ? SYSTEM_PROMPT + planPrompt() : SYSTEM_PROMPT;
      const messages = [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: userContent },
      ];

      // Los modelos gpt-5-* no aceptan `max_tokens` ni `temperature` personalizada.
      // `max_completion_tokens` INCLUYE el razonamiento: por eso el presupuesto es alto
      // y el esfuerzo de razonamiento bajo.
      const baseBody = {
        model,
        messages,
        max_completion_tokens: chosen.maxTokens,
        reasoning_effort: chosen.effort,
        response_format: { type: "json_schema", json_schema: TUTOR_SCHEMA },
      };
      const opts = { apiKey: process.env.OPENAI_API_KEY, deadline };

      let ai = await callOpenAI(baseBody, opts);

      // Si el modelo gastó todo el presupuesto razonando y no escribió nada, un segundo
      // intento sin razonamiento extra casi siempre resuelve.
      const emptyAndCut = (r) => {
        const c = r?.data?.choices?.[0];
        return r?.ok && c?.finish_reason === "length" && !String(c?.message?.content || "").trim();
      };
      if (emptyAndCut(ai)) {
        console.error("[CHAT] Respuesta vacía por falta de tokens; reintentando con razonamiento mínimo");
        ai = await callOpenAI({ ...baseBody, reasoning_effort: "minimal" }, opts);
      }

      if (!ai.ok) {
        console.error("[CHAT] OpenAI error:", ai.status, String(ai.error).slice(0, 300));
        const status = ai.status === 429 ? 429 : ai.status === 504 ? 504 : 502;
        return send(res, status, { error: `La IA no respondió: ${ai.error}`, model });
      }

      const choice = ai.data?.choices?.[0];
      reply = parseTutorReply(choice?.message?.content, choice?.finish_reason);

      if (!reply.text) {
        return send(res, 502, {
          error: "La IA no alcanzó a escribir la respuesta. Intenta con una pregunta más corta o inténtalo otra vez.",
          model,
        });
      }

      // Sólo se cachean respuestas completas y bien formadas.
      if (key && reply.valid && !reply.truncated) {
        await writeCache(db, key, {
          question: message,
          text: reply.text,
          sources: reply.sources,
          followups: reply.followups,
          model,
        });
      }
    }

    /* ---- 7. Persistir la conversación ---- */
    if (convo) {
      const now = Date.now();
      const files = [
        ...images.map((i) => ({ name: i.name || "imagen", type: i.type || "image" })),
        ...docSummary.filter((d) => d.ok).map((d) => ({ name: d.name, type: "documento" })),
      ];
      const update = {
        $push: {
          messages: {
            $slice: -MAX_STORED_MESSAGES,
            $each: [
              { role: "user", content: message, at: now, ...(files.length ? { files } : {}) },
              {
                role: "assistant",
                content: reply.text,
                sources: reply.sources,
                followUps: reply.followups,
                at: now + 1,
                model,
                fromCache,
              },
            ],
          },
        },
        $set: { updatedAt: now },
      };
      if ((convo.messages || []).length === 0 && message) {
        update.$set.title = message.slice(0, 48) + (message.length > 48 ? "…" : "");
      }
      await col.updateOne({ _id: convo._id, userId: payload.userId }, update);
    }

    return send(res, 200, {
      text: reply.text,
      sources: reply.sources,
      followups: reply.followups,
      model,
      fromCache,
      attachments: docSummary,
    });
  } catch (error) {
    console.error("[CHAT] Error:", error);
    const isMongo = /Mongo|topology|Server selection/i.test(String(error?.message || ""));
    return send(res, 500, {
      error: isMongo ? mongoHint(error) : "Error al procesar el mensaje.",
    });
  }
}
