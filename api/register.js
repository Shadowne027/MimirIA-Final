/** POST /api/register — { username, password } → { user } */
import {
  USERNAME_RE, clientKey, displayId, ensureUserIndexes, getDb, hashPassword, mongoHint,
  nextUserId, normalizeUsername, preflight, rateLimit, readBody, send, signToken, tooMany,
} from "./_lib.js";
import crypto from "node:crypto";

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== "POST") return send(res, 405, { error: "Método no permitido" });

  try {
    const body = await readBody(req);
    const username = normalizeUsername(body.username);
    const password = String(body.password || "");

    if (username.length < 2) {
      return send(res, 400, { error: "El nombre de usuario debe tener al menos 2 caracteres." });
    }
    if (username.length > 40) {
      return send(res, 400, { error: "El nombre de usuario es demasiado largo (máx. 40 caracteres)." });
    }
    if (!USERNAME_RE.test(username)) {
      return send(res, 400, {
        error: "El nombre de usuario solo puede tener letras, números, espacios y los signos . _ - '",
      });
    }
    if (password.length < 6) {
      return send(res, 400, { error: "La contraseña debe tener al menos 6 caracteres." });
    }

    const db = await getDb();
    const users = db.collection("users");

    // Freno al registro masivo de cuentas. En un colegio muchos estudiantes comparten
    // la misma IP (una sala de sistemas puede registrar un curso entero), así que el
    // tope por IP es alto: sólo frena a un script, no a un salón.
    const limit = await rateLimit(db, `register:${clientKey(req)}`, 120, 3600);
    if (!limit.allowed) return tooMany(res, limit, "Se crearon demasiadas cuentas desde esta conexión.");

    // Índice único (se crea una sola vez por instancia, no en cada registro):
    // sin él, dos registros simultáneos con el mismo nombre creaban duplicados.
    await ensureUserIndexes(db);

    const usernameLower = username.toLowerCase();
    if (await users.findOne({ usernameLower })) {
      return send(res, 409, { error: "Ese nombre de usuario ya está registrado." });
    }

    const userId = await nextUserId(db);
    const salt = crypto.randomBytes(16).toString("hex");

    try {
      await users.insertOne({
        userId,
        displayId: displayId(userId),
        username,
        usernameLower,
        salt,
        passwordHash: await hashPassword(password, salt),
        createdAt: Date.now(),
      });
    } catch (e) {
      if (e?.code === 11000) {
        return send(res, 409, { error: "Ese nombre de usuario ya está registrado." });
      }
      throw e;
    }

    const token = signToken({ userId, username });

    return send(res, 201, {
      user: { userId, id: displayId(userId), username, token },
    });
  } catch (error) {
    console.error("[REGISTER] Error:", error);
    return send(res, 500, { error: mongoHint(error) });
  }
}
