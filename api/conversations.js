/**
 * /api/conversations
 *  GET            → lista las conversaciones del usuario SIN mensajes
 *                   (antes devolvía hasta 100 conversaciones completas y, con
 *                   uso intenso, superaba el límite de ~4.5 MB de Vercel)
 *  GET  ?id=...   → una conversación con todos sus mensajes
 *  POST           → crea una conversación   { title? }
 *  DELETE ?id=... → elimina una conversación
 */
import { ObjectId } from "mongodb";
import { authPayload, getDb, mongoHint, preflight, readBody, send } from "./_lib.js";

const MAX_CONVERSATIONS = 50; // por estudiante

export default async function handler(req, res) {
  if (preflight(req, res)) return;

  // Verificación de token centralizada: firma en tiempo constante + caducidad.
  const payload = authPayload(req);
  if (!payload) return send(res, 401, { error: "Sesión inválida. Inicia sesión de nuevo." });

  try {
    // Pool reutilizado: antes se abría y cerraba una conexión nueva en cada petición.
    const db = await getDb();
    const col = db.collection("conversations");

    if (req.method === "GET") {
      const id = req.query?.id;

      if (id) {
        if (!ObjectId.isValid(String(id))) return send(res, 400, { error: "ID de conversación inválido." });
        const doc = await col.findOne({ _id: new ObjectId(String(id)), userId: payload.userId });
        if (!doc) return send(res, 404, { error: "Conversación no encontrada." });
        const { _id, ...rest } = doc;
        return send(res, 200, { conversation: { ...rest, id: String(_id) } });
      }

      const docs = await col
        .find({ userId: payload.userId }, { projection: { messages: 0 } })
        .sort({ updatedAt: -1 })
        .limit(MAX_CONVERSATIONS)
        .toArray();
      return send(res, 200, {
        conversations: docs.map(({ _id, ...rest }) => ({ ...rest, id: String(_id) })),
      });
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const title = String(body.title || "Nueva conversación").slice(0, 80);

      const total = await col.countDocuments({ userId: payload.userId });
      if (total >= MAX_CONVERSATIONS) {
        return send(res, 409, {
          error: `Llegaste al máximo de ${MAX_CONVERSATIONS} conversaciones. Elimina alguna para crear otra.`,
        });
      }

      const now = Date.now();
      const doc = { userId: payload.userId, title, createdAt: now, updatedAt: now, messages: [] };
      const result = await col.insertOne(doc);
      const { _id, ...rest } = doc;
      return send(res, 201, { conversation: { ...rest, id: String(result.insertedId) } });
    }

    if (req.method === "DELETE") {
      const id = req.query?.id;
      if (!id) return send(res, 400, { error: "Falta el id de la conversación." });
      if (!ObjectId.isValid(String(id))) {
        return send(res, 400, { error: "ID de conversación inválido." });
      }
      const result = await col.deleteOne({ _id: new ObjectId(String(id)), userId: payload.userId });
      if (result.deletedCount === 0) {
        return send(res, 404, { error: "Conversación no encontrada." });
      }
      return send(res, 200, { ok: true });
    }

    return send(res, 405, { error: "Método no permitido" });
  } catch (error) {
    console.error("[CONVERSATIONS] Error:", error);
    return send(res, 500, { error: mongoHint(error) });
  }
}
