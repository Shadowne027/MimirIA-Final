/** POST /api/login — { username, password } → { user } */
import crypto from "node:crypto";
import {
  clientKey, displayId, getDb, mongoHint, normalizeUsername, preflight, rateCount, rateLimit,
  readBody, send, signToken, tooMany, verifyPassword, hashPassword,
} from "./_lib.js";

const FAILS_PER_USER = 8;     // fallos por (usuario + IP) en la ventana
const IP_ATTEMPTS = 300;      // intentos totales por IP en la ventana (un colegio comparte IP)
const WINDOW_SEC = 900;       // 15 minutos

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== "POST") return send(res, 405, { error: "Método no permitido" });

  try {
    const { username, password } = await readBody(req);
    if (!username || !password) {
      return send(res, 400, { error: "Escribe tu usuario y tu contraseña." });
    }

    const db = await getDb();
    const ip = clientKey(req);

    // 1) Tope amplio por IP: frena scripts sin castigar a un salón que comparte conexión.
    const ipLimit = await rateLimit(db, `login-ip:${ip}`, IP_ATTEMPTS, WINDOW_SEC);
    if (!ipLimit.allowed) return tooMany(res, ipLimit, "Demasiados intentos de inicio de sesión desde esta conexión.");

    // 2) Fuerza bruta contra UNA cuenta: sólo cuentan los FALLOS, y por (usuario + IP),
    //    así nadie desde otra conexión puede bloquear la cuenta de un compañero.
    const normalized = normalizeUsername(username);
    const userKey = crypto.createHash("sha256").update(normalized.toLowerCase()).digest("hex").slice(0, 16);
    const failKey = `login-fail:${ip}:${userKey}`;
    const fails = await rateCount(db, failKey, WINDOW_SEC);
    if (fails.count >= FAILS_PER_USER) {
      return tooMany(res, { retryAfter: fails.retryAfter }, "Demasiados intentos fallidos con este usuario.");
    }

    const users = db.collection("users");
    let user = await users.findOne({ usernameLower: normalized.toLowerCase() });
    // Cuentas antiguas se registraron sin normalizar espacios/acentos.
    const legacy = String(username).trim().toLowerCase();
    if (!user && legacy !== normalized.toLowerCase()) user = await users.findOne({ usernameLower: legacy });

    // Mismo mensaje y mismo coste para "no existe" y "clave incorrecta": si el usuario
    // no existe también se calcula un hash, para que el tiempo no delate qué cuentas hay.
    let valid = false;
    if (user) {
      valid = await verifyPassword(password, user.salt, user.passwordHash);
    } else {
      await hashPassword(password, "mimir-sin-usuario");
    }

    if (!valid) {
      await rateLimit(db, failKey, FAILS_PER_USER, WINDOW_SEC); // suma un fallo
      return send(res, 401, { error: "Usuario o contraseña incorrectos." });
    }

    // signToken añade `exp`: los tokens del código original no caducaban nunca.
    const token = signToken({ userId: user.userId, username: user.username });

    return send(res, 200, {
      user: {
        userId: user.userId,
        id: user.displayId || displayId(user.userId),
        username: user.username,
        token,
      },
    });
  } catch (error) {
    console.error("[LOGIN] Error:", error);
    return send(res, 500, { error: mongoHint(error) });
  }
}
