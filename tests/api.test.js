/**
 * Pruebas de las funciones puras del backend.
 * Ejecutar con:  npm test   (necesita `npm install` hecho, por el driver de mongodb)
 */
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

process.env.TOKEN_SECRET = "x".repeat(48);

const lib = await import("../api/_lib.js");
const { chooseModel, parseTutorReply, salvageText } = await import("../api/_ai.js");
const { extractText } = await import("../api/_extract.js");

/* ---------------- Tokens ---------------- */
test("token: ida y vuelta válida", () => {
  const t = lib.signToken({ userId: 7, username: "ana" });
  const p = lib.verifyToken(t);
  assert.equal(p.userId, 7);
});

test("token: firma alterada se rechaza", () => {
  const t = lib.signToken({ userId: 7 });
  const [body, sig] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ userId: 1, exp: Date.now() + 1e9 })).toString("base64url");
  assert.equal(lib.verifyToken(`${forged}.${sig}`), null);
  assert.equal(lib.verifyToken(`${body}.AAAA`), null);
  assert.equal(lib.verifyToken("basura"), null);
});

test("token: caducado se rechaza", () => {
  const t = lib.signToken({ userId: 7 }, -1);
  assert.equal(lib.verifyToken(t), null);
});

test("sin TOKEN_SECRET (o muy corta) el servidor se niega a firmar", () => {
  const prev = process.env.TOKEN_SECRET;
  process.env.TOKEN_SECRET = "corta";
  assert.throws(() => lib.signToken({ userId: 1 }), /TOKEN_SECRET/);
  delete process.env.TOKEN_SECRET;
  assert.throws(() => lib.getTokenSecret(), /TOKEN_SECRET/);
  assert.equal(lib.verifyToken("a.b"), null); // sin secreto, nada se valida
  process.env.TOKEN_SECRET = prev;
});

/* ---------------- Contraseñas ---------------- */
test("contraseña: acierta y falla", async () => {
  const h = await lib.hashPassword("secreta1", "salt");
  assert.equal(await lib.verifyPassword("secreta1", "salt", h), true);
  assert.equal(await lib.verifyPassword("otra", "salt", h), false);
  assert.equal(await lib.verifyPassword("x", "salt", ""), false);
});

test("nombre de usuario: se normaliza y se valida", () => {
  assert.equal(lib.normalizeUsername("  Ana   María  "), "Ana María");
  assert.equal(lib.normalizeUsername("Jose\u0301"), "José"); // NFC
  assert.equal(lib.USERNAME_RE.test("Ana_María-2"), true);
  assert.equal(lib.USERNAME_RE.test("ana\u200Bx"), false);   // carácter invisible
  assert.equal(lib.USERNAME_RE.test("<script>"), false);
  assert.equal(lib.USERNAME_RE.test("a"), false);
});

/* ---------------- URLs de fuentes ---------------- */
test("safeUrl: sólo http(s)", () => {
  assert.equal(lib.safeUrl("https://es.wikipedia.org/wiki/Sol"), "https://es.wikipedia.org/wiki/Sol");
  assert.equal(lib.safeUrl("javascript:alert(1)"), null);
  assert.equal(lib.safeUrl("data:text/html,<script>1</script>"), null);
  assert.equal(lib.safeUrl("no es url"), null);
});

test("sanitizeSources: el servidor construye enlaces de búsqueda (sin URLs inventadas)", () => {
  const out = lib.sanitizeSources([
    { label: "Fotosíntesis", site: "wikipedia", query: "fotosíntesis" },
    { label: "x", site: "sitio_inventado", query: "algo" },        // sitio no permitido
    { label: "y", site: "khan_academy", query: "" },               // sin tema
    { label: "Mate", site: "wolfram_alpha", query: "x^2+1=5" },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].url, "https://es.wikipedia.org/w/index.php?search=fotos%C3%ADntesis&go=Go");
  assert.equal(out[1].url, "https://www.wolframalpha.com/input?i=x%5E2%2B1%3D5");
});

test("sanitizeSources: descarta peligrosas y limita", () => {
  const out = lib.sanitizeSources([
    { label: "Ok", url: "https://khanacademy.org" },
    { label: "Mala", url: "javascript:alert(1)" },
    null,
    { url: "http://a.edu" },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[1].label, "http://a.edu/");
  assert.equal(lib.sanitizeSources("x").length, 0);
});

/* ---------------- Caché ---------------- */
test("caché: variantes triviales comparten clave", () => {
  const a = lib.cacheKey("¿Qué es la fotosíntesis?");
  assert.ok(a);
  assert.equal(a, lib.cacheKey("QUE ES LA FOTOSINTESIS!!"));
  assert.equal(a, lib.cacheKey("Oye, ¿qué es la fotosíntesis?"));
  assert.notEqual(a, lib.cacheKey("¿Por qué llueve?"));
  assert.equal(lib.cacheKey("hola"), null);
});

/* ---------------- Elección de modelo ---------------- */
test("modelo: nano para lo simple, mini para razonar y adjuntos", () => {
  assert.equal(chooseModel("Hola").model, "gpt-5-nano");
  assert.equal(chooseModel("¿Cuál es la capital de Colombia?").model, "gpt-5-nano");
  assert.equal(chooseModel("Resuelve esta ecuación paso a paso").model, "gpt-5-mini");
  assert.equal(chooseModel("¿Qué es la fotosíntesis?").model, "gpt-5-mini"); // no confundir con "tesis"
  assert.equal(chooseModel("hola", { hasAttachments: true }).model, "gpt-5-mini");
});

test("modelo: el presupuesto de tokens incluye el razonamiento (ya no 2000)", () => {
  for (const q of ["Hola", "¿Qué es la fotosíntesis?", "Resuelve 2x+3=9", "Hazme un plan de estudio de matemáticas"]) {
    const c = chooseModel(q);
    assert.ok(c.maxTokens >= 3000, `${q}: ${c.maxTokens}`);
    assert.ok(["minimal", "low", "medium"].includes(c.effort));
  }
  assert.equal(chooseModel("Hola").effort, "minimal");
  assert.equal(chooseModel("Resuelve 2x+3=9").effort, "medium");
});

test("planes de estudio: se detectan con muchas formulaciones", () => {
  const plans = [
    "Hazme un plan de estudio para el ICFES",
    "Necesito organizar mi estudio de química, tengo examen en 3 semanas",
    "crea un cronograma para repasar matemáticas",
    "¿Cómo me preparo para el examen de inglés?",
    "Prepárame para el Saber 11",
    "quiero una rutina de estudio para física",
    "armame un horario de estudio",
    "dame una ruta de aprendizaje de programación",
  ];
  for (const q of plans) {
    const c = chooseModel(q);
    assert.equal(c.intent, "plan", q);
    assert.equal(c.model, "gpt-5-mini", q);
    assert.ok(c.maxTokens >= 10000, q);
  }
  for (const q of ["¿Qué es un plan de negocios?", "Explícame la fotosíntesis", "Hola", "resuelve x+1=2"]) {
    assert.notEqual(chooseModel(q).intent, "plan", q);
  }
});

test("planes: una modificación posterior sigue en modo plan solo si ya había un plan", () => {
  const prevPlan = "**Objetivo**: aprobar\n**Semana 1 — Álgebra**\nLunes (45 min): ...";
  const c = chooseModel("hazlo de 3 semanas", { historyLength: 2, lastAssistant: prevPlan });
  assert.equal(c.intent, "plan");
  const d = chooseModel("hazlo de 3 semanas", { historyLength: 2, lastAssistant: "Hola, ¿en qué te ayudo?" });
  assert.notEqual(d.intent, "plan");
});

/* ---------------- Lectura de la respuesta del modelo ---------------- */
test("parseTutorReply: JSON válido", () => {
  const raw = JSON.stringify({
    text: "Explicación",
    sources: [{ label: "W", site: "wikipedia", query: "sol" }],
    followups: ["¿Y la luna?", "", 5],
  });
  const r = parseTutorReply(raw, "stop");
  assert.equal(r.valid, true);
  assert.equal(r.text, "Explicación");
  assert.equal(r.sources.length, 1);
  assert.deepEqual(r.followups, ["¿Y la luna?"]);
});

test("parseTutorReply: JSON cortado se rescata en vez de mostrarse crudo", () => {
  const cut = '{"text":"Semana 1: repasa fracciones.\\nSemana 2: decimales y porcen';
  assert.equal(salvageText(cut), "Semana 1: repasa fracciones.\nSemana 2: decimales y porcen");
  const r = parseTutorReply(cut, "length");
  assert.equal(r.valid, false);
  assert.equal(r.truncated, true);
  assert.match(r.text, /Semana 1: repasa fracciones/);
  assert.match(r.text, /continúa/i);
  assert.ok(!r.text.includes('"text"'));
});

test("parseTutorReply: vacío o JSON roto sin texto no se muestra crudo", () => {
  assert.equal(parseTutorReply("", "length").text, "");
  assert.equal(parseTutorReply('{"sources":[', "length").text, "");
  assert.equal(parseTutorReply("Hola, texto plano", "stop").text, "Hola, texto plano");
});

/* ---------------- Caché y datos personales ---------------- */
test("isCacheable: no se comparte lo que trae datos personales", () => {
  assert.equal(lib.isCacheable("¿Qué es la fotosíntesis?"), true);
  assert.equal(lib.isCacheable("Me llamo Juan y no entiendo las fracciones"), false);
  assert.equal(lib.isCacheable("Mi profesor dijo que la nota es 3"), false);
  assert.equal(lib.isCacheable("mi correo es ana@mail.com, explícame"), false);
  assert.equal(lib.isCacheable("llámame al 3001234567"), false);
  assert.equal(lib.isCacheable("Soy Carlos, ayúdame con álgebra"), false);
  assert.equal(lib.isCacheable("a".repeat(301)), false);
  assert.equal(lib.isCacheable("Explica la ley de Ohm"), true);
});

/* ---------------- Extracción y zip bomb ---------------- */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const local = Buffer.concat([lh, nameBuf, comp]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, nameBuf]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test("docx normal: se extrae el texto", () => {
  const xml = "<w:document><w:body><w:p><w:r><w:t>Hola mundo, texto de prueba</w:t></w:r></w:p></w:body></w:document>";
  const zip = makeZip([["word/document.xml", Buffer.from(xml)]]);
  const r = extractText({ name: "a.docx", data: zip });
  assert.equal(r.ok, true);
  assert.match(r.text, /Hola mundo/);
});

test("zip bomb: no revienta la memoria y se rechaza con elegancia", () => {
  // ~12 MB de relleno comprimen a unos KB, pero superan el tope de 8 MB por entrada.
  // Empieza con texto legible a propósito: si el límite NO existiera, la extracción
  // tendría éxito (ok: true) y esta prueba fallaría.
  const head = Buffer.from("<w:t>Texto legible de la bomba</w:t>");
  const bomb = Buffer.concat([head, Buffer.alloc(12 * 1024 * 1024, 0x20)]);
  const zip = makeZip([["word/document.xml", bomb]]);
  assert.ok(zip.length < 100_000, "el ZIP de prueba debe ser pequeño");
  const r = extractText({ name: "bomba.docx", data: zip });
  assert.equal(r.ok, false);
});

/* ---------------- Límite de uso ---------------- */
function fakeDb() {
  const rows = new Map();
  return {
    collection: () => ({
      createIndex: async () => {},
      findOneAndUpdate: async ({ _id }) => {
        const row = rows.get(_id) || { count: 0 };
        row.count += 1;
        rows.set(_id, row);
        return row; // el driver v6+ devuelve el documento directamente
      },
    }),
  };
}

test("rateLimit: permite hasta el límite y bloquea después", async () => {
  const db = fakeDb();
  for (let i = 1; i <= 3; i++) {
    const r = await lib.rateLimit(db, "u:1", 3, 3600);
    assert.equal(r.allowed, true, `intento ${i}`);
  }
  const blocked = await lib.rateLimit(db, "u:1", 3, 3600);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter > 0);
  // otro usuario no se ve afectado
  assert.equal((await lib.rateLimit(db, "u:2", 3, 3600)).allowed, true);
});

test("rateLimit: si Mongo falla, no bloquea al usuario", async () => {
  const broken = { collection: () => { throw new Error("caído"); } };
  assert.equal((await lib.rateLimit(broken, "u:1", 1, 60)).allowed, true);
});

/* ---------------- CORS ---------------- */
function fakeRes() {
  const headers = {};
  return { headers, setHeader: (k, v) => { headers[k] = v; } };
}

test("CORS: ya no es '*'; sólo orígenes permitidos", () => {
  const evil = fakeRes();
  lib.cors(evil, { headers: { origin: "https://evil.example" } });
  assert.equal(evil.headers["Access-Control-Allow-Origin"], undefined);

  const ok = fakeRes();
  lib.cors(ok, { headers: { origin: "https://mimiria.vercel.app" } });
  assert.equal(ok.headers["Access-Control-Allow-Origin"], "https://mimiria.vercel.app");

  const same = fakeRes(); // petición del mismo origen: sin cabecera Origin
  lib.cors(same, { headers: {} });
  assert.equal(same.headers["Access-Control-Allow-Origin"], undefined);
});
