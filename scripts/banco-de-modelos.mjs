/**
 * Banco de pruebas de modelos, sobre la tarea de esta plataforma.
 *
 * Los benchmarks publicos miden codigo, matematica y razonamiento. Nada de eso
 * es lo que aca se le pide al modelo, que es bastante mas estrecho:
 *
 *   redactar en espanol de Chile, a partir de pasajes que ya le dieron,
 *   sin inventar nada y obedeciendo instrucciones negativas
 *   (no escribas el encabezado, no pongas una linea "Fuentes:", no uses markdown).
 *
 * Asi que se mide eso, con el material real del vault y con `SISTEMA_GUIA`, el
 * prompt de verdad importado de guias.mjs.
 *
 *   node scripts/banco-de-modelos.mjs                        todos los candidatos
 *   node scripts/banco-de-modelos.mjs gemma4:e4b qwen3.5:4b  solo esos, en ese orden
 *
 * ───────── Como se puntua, y por que asi ─────────
 *
 * Los defectos no pesan igual, porque la plataforma no los trata igual:
 *
 *   1. FIDELIDAD. Una cifra o una cita que el modelo invento LLEGA AL PDF y
 *      envenena la guia. Si una guia dice que la prueba es el 28 cuando el
 *      anuncio dice 27, el estudiante llega un dia tarde. Es lo unico
 *      verdaderamente grave y pesa como tal.
 *   2. UTILIDAD. Si tras limpiar no queda prosa, la seccion cae a extracto
 *      literal: el modelo no aporto nada y mejor seria no haberlo llamado.
 *      Tambien cuenta aca si el modelo parafrasea las cifras hasta deshacerlas
 *      ("sala tres cero uno" en vez de "sala 301"), porque una guia de estudio
 *      sirve justamente por los datos duros.
 *   3. FORMATO. Markdown, preambulos y encabezados repetidos los limpia el
 *      codigo, asi que no llegan al PDF. Pesan poco, pero se miden: son el
 *      indicador mas directo de si el modelo sigue instrucciones.
 *   4. VELOCIDAD. Por debajo de cierto umbral da igual; por encima, molesta.
 *      No es una carrera: un modelo que tarda 3 s y uno que tarda 5 valen lo
 *      mismo para quien espera una guia.
 */
import process from "node:process";

import { SISTEMA_GUIA, armarEsqueleto, limpiarProsa } from "../web/src/guias.mjs";
import { llamar } from "../web/src/canvas.mjs";
import { obtenerUsuario } from "../web/src/usuarios.mjs";

const OLLAMA = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const USUARIO = process.env.BANCO_USUARIO || "franpintoabraham";

/* Los mismos parametros que manda la plataforma: ver agente.mjs. */
const CONTEXTO = 16_384;
const TOKENS = 450;
const TEMPERATURA = 0.2;

/** Candidatos. Todos tienen que caber en la VRAM o se mide el castigo. */
const CANDIDATOS = [
  "granite4:latest",
  "qwen3.5:4b-q4_K_M",
  "gemma4:e2b-it-qat",
  "llama3.1:latest",
  "qwen3:8b",
  "qwen3.5:9b-q4_K_M",
  "gemma4:e4b",
  "gemma4:12b",
];

/** De donde sale el material: ramos reales del vault, con temas reales. */
const CASOS = [
  { course_id: 31151, tema: "prueba automatas" },
  { course_id: 31192, tema: "modelo relacional" },
  { course_id: 30679, tema: "metodos numericos" },
];

/* ───────── Las mediciones ───────── */

const PREAMBULOS = /^(aqui|aquí|claro|por supuesto|perfecto|entendido|bien|ok)\b/i;

/** Las cifras de dos o mas digitos: fechas, salas, ids, porcentajes. */
const cifrasDe = texto => new Set(String(texto).match(/\d[\d.,]*\d|\d{2,}/g) || []);

const MESES = /\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/gi;

/*
 * Los datos duros por los que existe una guia de estudio: fechas, horas y
 * codigos de sala.
 *
 * Al principio esto medía "cuantas cifras del material sobreviven textuales", y
 * estaba mal. El material viene rotulado por el codigo con "[anuncio:131609 —
 * titulo]", asi que los ids de cita entraban al denominador y el modelo quedaba
 * castigado por NO repetirlos, que es exactamente lo que tiene que hacer. Y un
 * modelo que resume veintidos cifras en dos parrafos tampoco deberia perder por
 * dejar fuera las que no venian al caso.
 *
 * Asi que se miden solo los datos que si tienen que sobrevivir, que ademas son
 * pocos y hacen que la proporcion signifique algo.
 */
const DATOS_CLAVE = [
  /\b\d{1,2}\s+de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/gi,
  /\b\d{1,2}[:.]\d{2}\b/g,
  /\b[A-Z]\d{1,2}-\d{2,3}\b/g,
  /\bsala\s+\d{2,4}\b/gi,
];

const datosClaveDe = texto => new Set(
  DATOS_CLAVE.flatMap(re => String(texto).match(re) || []).map(d => d.toLowerCase().replace(/\s+/g, " ")),
);

/** El material sin los rotulos "[cita — titulo]" que pone el codigo. */
const sinRotulos = material => String(material).replace(/^\[[^\]]*\]\s*$/gm, "");

/* Palabras funcionales del espanol. Si la respuesta no las trae, no esta en
 * espanol: pasaba con modelos que derivaban al ingles o al portugues. */
const ESPANOL = ["de", "la", "el", "que", "en", "los", "las", "para", "con", "se", "del", "por", "una", "es"];

/* Igual que en guias.mjs: sin acentos, sin mayusculas y sin signos. */
const comparable = texto => String(texto || "")
  .toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9 ]/g, " ")
  .replace(/\s+/g, " ")
  .trim();

function medir({ crudo, limpio, material, citasPermitidas, encabezado }) {
  const lineas = crudo.split("\n").map(l => l.trim()).filter(Boolean);
  const palabras = limpio.toLowerCase().match(/[a-záéíóúñü]+/g) || [];
  const enEspanol = palabras.filter(p => ESPANOL.includes(p)).length;

  const permitidas = new Set(citasPermitidas);
  const citasCrudas = [...crudo.matchAll(/\(([a-z]+:[0-9]+)\)/gi)].map(m => m[1]);

  // Para "inventada" se compara contra el material ENTERO, rotulos incluidos:
  // ahi conviene ser permisivo, porque un falso positivo acusaria de inventar a
  // un modelo que solo copio bien.
  const delMaterial = cifrasDe(material);
  const deLaRespuesta = cifrasDe(limpio);
  const inventadas = [...deLaRespuesta].filter(c => !delMaterial.has(c));

  // Para "conservado" se mira solo el contenido y solo los datos duros.
  const claveMaterial = datosClaveDe(sinRotulos(material));
  const claveRespuesta = datosClaveDe(limpio);
  const conservadas = [...claveMaterial].filter(d => claveRespuesta.has(d));

  const mesesMaterial = new Set((material.match(MESES) || []).map(m => m.toLowerCase()));
  const mesesInventados = [...new Set((limpio.match(MESES) || []).map(m => m.toLowerCase()))]
    .filter(m => !mesesMaterial.has(m));

  return {
    // Fidelidad
    cifras_inventadas: inventadas,
    meses_inventados: mesesInventados,
    citas_inventadas: citasCrudas.filter(c => !permitidas.has(c)),
    // Utilidad
    vacia: limpio.length === 0,
    cifras_del_material: claveMaterial.size,
    cifras_conservadas: conservadas.length,
    caracteres: limpio.length,
    // Formato
    razonamiento: /<\/?(think|thinking|reasoning|reflection)\b/i.test(crudo),
    markdown: /(^|\n)#{1,6}\s/.test(crudo) || crudo.includes("**") || crudo.includes("```"),
    preambulo: lineas.length > 0 && PREAMBULOS.test(lineas[0]),
    /*
     * Repetir el encabezado, que el prompt prohibe expresamente.
     *
     * Esta medicion faltaba en la primera version del banco, y por eso el banco
     * dio 100% de formato a un modelo que lo repetia en cada seccion. Se
     * compara contra las tres primeras lineas y no solo la primera porque a
     * veces va despues de un preambulo.
     */
    encabezado_repetido: lineas
      .slice(0, 3)
      .some(l => comparable(l) === comparable(encabezado)),
    linea_fuentes: /^\s*(fuentes?|citas?)\s*:/im.test(crudo),
    parrafos: limpio ? limpio.split(/\n\s*\n/).filter(Boolean).length : 0,
    // Idioma
    ratio_espanol: palabras.length ? enEspanol / palabras.length : 0,
  };
}

/* ───────── La llamada ───────── */

async function pedir(modelo, { sistema, instruccion, material, pensar }) {
  const cuerpo = {
    model: modelo,
    stream: false,
    keep_alive: "15m",
    options: { temperature: TEMPERATURA, num_predict: TOKENS, num_ctx: CONTEXTO },
    messages: [
      { role: "system", content: sistema },
      { role: "user", content: `MATERIAL:\n${material}\n\n${instruccion}` },
    ],
  };
  if (pensar === false) cuerpo.think = false;

  const respuesta = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(600_000),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text().catch(() => "");
    const error = new Error(`HTTP ${respuesta.status}: ${detalle.slice(0, 200)}`);
    error.estado = respuesta.status;
    error.detalle = detalle;
    throw error;
  }
  return respuesta.json();
}

/** Igual que la plataforma: `think:false` si el modelo lo acepta, y si no, sin el. */
async function pedirTolerante(modelo, peticion) {
  try {
    return { datos: await pedir(modelo, { ...peticion, pensar: false }), thinkAceptado: true };
  } catch (error) {
    if (!/think/i.test(error.detalle || "")) throw error;
    return { datos: await pedir(modelo, { ...peticion, pensar: undefined }), thinkAceptado: false };
  }
}

/**
 * Deja la tarjeta vacia antes de medir el modelo siguiente.
 *
 * Sin esto el banco se estorbaba a si mismo y daba numeros falsos, que es el
 * peor defecto posible en un banco de pruebas. El banco manda `keep_alive:
 * "15m"` porque es lo que manda la plataforma, asi que al pasar al modelo
 * siguiente el anterior seguia residente: el nuevo entraba a la VRAM que
 * sobraba y Ollama le mandaba el resto a la CPU.
 *
 * El sintoma que lo delato fue `gemma4:e4b` midiendo 35 s por seccion y 5 tok/s
 * cuando solo era capaz de 1,0 s y 146 tok/s: habia quedado `gemma4:12b`
 * ocupando la tarjeta y dejando 221 MiB libres. Eso tambien explica por que la
 * misma nota se movia hasta ocho puntos entre corridas segun el ORDEN en que se
 * midieran los modelos.
 *
 * `keep_alive: 0` le dice a Ollama que lo descargue ahora.
 */
async function vaciarLaTarjeta() {
  let cargados = [];
  try {
    const r = await fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(8000) });
    cargados = (await r.json()).models || [];
  } catch {
    return;
  }

  for (const m of cargados) {
    await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: m.name, keep_alive: 0, messages: [] }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => {});
  }

  // Descargar no es instantaneo; se espera a que /api/ps quede vacio.
  for (let intento = 0; intento < 40; intento += 1) {
    try {
      const r = await fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(8000) });
      if (!((await r.json()).models || []).length) return;
    } catch {
      return;
    }
    await new Promise(listo => setTimeout(listo, 500));
  }
}

async function repartoEnVram(modelo) {
  try {
    const r = await fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(8000) });
    const { models = [] } = await r.json();
    const m = models.find(x => x.name === modelo || x.model === modelo);
    if (!m?.size) return null;
    return { total: m.size, vram: m.size_vram || 0, porcentaje: Math.round(100 * (m.size_vram || 0) / m.size) };
  } catch {
    return null;
  }
}

/* ───────── El conjunto de prueba ───────── */

async function armarSecciones(usuario) {
  const secciones = [];

  for (const caso of CASOS) {
    const paquete = await llamar(usuario, "canvas_study_sources", {
      course_id: caso.course_id,
      tema: caso.tema,
      max_chars: 40_000,
    }).catch(error => ({ error: error.message }));

    if (paquete.error) {
      console.log(`  ! ramo ${caso.course_id}: ${paquete.error}`);
      continue;
    }

    const esqueleto = armarEsqueleto(paquete.fuentes || [], { maximo: 4 });
    for (const seccion of esqueleto) {
      if (!seccion.material?.trim()) continue;
      secciones.push({ ...seccion, tema: caso.tema, course_id: caso.course_id });
    }
    console.log(`  ramo ${caso.course_id} "${caso.tema}": ${esqueleto.length} secciones`);
  }

  return secciones;
}

/* ───────── Puntuacion ───────── */

/**
 * De las mediciones a una nota de 0 a 100.
 *
 * Las ponderaciones estan arriba, en el docblock, con el razonamiento. Aca solo
 * se aplican. Fidelidad 50, utilidad 30, formato 15, velocidad 5: un modelo
 * rapido que invente cifras tiene que perder contra uno lento que no.
 */
function puntuar(filas, segundosPorSeccion) {
  const n = filas.length;
  if (!n) return null;

  const promedio = f => filas.reduce((s, x) => s + f(x), 0) / n;

  // Fidelidad: proporcion de secciones sin NADA inventado.
  const limpias = promedio(m =>
    m.cifras_inventadas.length === 0 && m.meses_inventados.length === 0 && m.citas_inventadas.length === 0 ? 1 : 0);

  // Utilidad: que no quede vacia, y que las cifras del material sobrevivan.
  const utiles = promedio(m => (m.vacia ? 0 : 1));
  const cifras = promedio(m =>
    m.cifras_del_material === 0 ? 1 : m.cifras_conservadas / m.cifras_del_material);

  // Formato: cinco reglas, cuantas respeta en promedio.
  const formato = promedio(m => {
    const reglas = [m.razonamiento, m.markdown, m.preambulo, m.linea_fuentes, m.encabezado_repetido];
    const fallos = reglas.filter(Boolean).length;
    return (reglas.length - fallos) / reglas.length;
  });

  // Espanol: por debajo de 0.15 de palabras funcionales no esta en espanol.
  const espanol = promedio(m => (m.ratio_espanol >= 0.15 ? 1 : 0));

  /* Velocidad con umbral, no lineal: 4 s o menos es perfecto, 20 s o mas es
   * cero, y en medio baja recto. Tres segundos y cinco valen lo mismo para
   * quien espera; treinta no. */
  const velocidad = Math.max(0, Math.min(1, (20 - segundosPorSeccion) / 16));

  const nota =
    50 * (limpias * 0.7 + espanol * 0.3) +
    30 * (utiles * 0.6 + cifras * 0.4) +
    15 * formato +
    5 * velocidad;

  return { nota, limpias, utiles, cifras, formato, espanol, velocidad };
}

/* ───────── Corrida ───────── */

const pedidos = process.argv.slice(2);
const modelos = pedidos.length ? pedidos : CANDIDATOS;

console.log("Armando el conjunto de prueba con material real del vault...");
const usuario = await obtenerUsuario(USUARIO);
if (!usuario) {
  console.error(`No existe el usuario "${USUARIO}". Usa BANCO_USUARIO=<id>.`);
  process.exit(1);
}

const secciones = await armarSecciones(usuario);
if (secciones.length < 2) {
  console.error("Hacen falta al menos dos secciones con material. ¿Esta sincronizado el vault?");
  process.exit(1);
}
console.log(`\n${secciones.length} secciones x ${modelos.length} modelos = ${secciones.length * modelos.length} llamadas\n`);

const resultados = [];
const muestras = {};

for (const modelo of modelos) {
  console.log(`═══ ${modelo} ═══`);
  const filas = [];
  let msGenerando = 0;
  let tokens = 0;
  let segundosDeCarga = 0;
  let thinkAceptado = null;
  let caidas = 0;

  // Cada modelo se mide con la tarjeta para el solo, o el banco mide el orden
  // en que se corrio en vez de medir los modelos.
  await vaciarLaTarjeta();

  // Calentamiento: la carga de los pesos a la VRAM no es parte de la tarea, y
  // se mide aparte porque es lo que justifica el keep_alive de la plataforma.
  try {
    const t0 = Date.now();
    const { datos, thinkAceptado: ok } = await pedirTolerante(modelo, {
      sistema: SISTEMA_GUIA,
      instruccion: "Escribe una frase.",
      material: secciones[0].material.slice(0, 500),
    });
    segundosDeCarga = (Date.now() - t0) / 1000;
    thinkAceptado = ok;
    void datos;
  } catch (error) {
    console.log(`  no arranco: ${error.message}\n`);
    resultados.push({ modelo, error: error.message });
    continue;
  }

  const reparto = await repartoEnVram(modelo);

  for (const [i, seccion] of secciones.entries()) {
    let crudo = "";
    try {
      const t0 = Date.now();
      const { datos } = await pedirTolerante(modelo, {
        sistema: SISTEMA_GUIA,
        instruccion: `Escribe la seccion "${seccion.encabezado}" de una guia sobre "${seccion.tema}".`,
        material: seccion.material,
      });
      msGenerando += Date.now() - t0;
      tokens += datos.eval_count || 0;
      crudo = datos.message?.content || "";
      // El pensamiento que Ollama devuelve aparte cuenta como razonamiento
      // filtrado para la medicion de formato: el modelo lo produjo igual.
      if ((datos.message?.thinking || "").trim()) crudo = `<think>${datos.message.thinking}</think>${crudo}`;
    } catch (error) {
      caidas += 1;
      console.log(`  seccion ${i + 1}: cayo (${error.message.slice(0, 80)})`);
      continue;
    }

    const limpio = limpiarProsa(crudo, seccion.fuentes, seccion.encabezado);
    const m = medir({
      crudo,
      limpio,
      material: seccion.material,
      citasPermitidas: seccion.fuentes,
      encabezado: seccion.encabezado,
    });
    filas.push(m);

    if (i === 0) muestras[modelo] = { encabezado: seccion.encabezado, limpio, crudo };

    const banderas = [
      m.vacia && "VACIA",
      m.cifras_inventadas.length && `cifras:${m.cifras_inventadas.join("/")}`,
      m.meses_inventados.length && `meses:${m.meses_inventados.join("/")}`,
      m.citas_inventadas.length && `citas:${m.citas_inventadas.join("/")}`,
      m.razonamiento && "razona",
      m.markdown && "markdown",
      m.preambulo && "preambulo",
      m.encabezado_repetido && "ENCABEZADO-REPETIDO",
      m.linea_fuentes && "fuentes:",
      m.ratio_espanol < 0.15 && "NO-ESPANOL",
    ].filter(Boolean);

    console.log(`  ${String(i + 1).padStart(2)}. ${String(m.caracteres).padStart(4)} car  ${m.parrafos}p  cifras ${m.cifras_conservadas}/${m.cifras_del_material}  ${banderas.join(" ") || "limpio"}`);
  }

  const segundos = filas.length ? msGenerando / 1000 / filas.length : Infinity;
  const nota = puntuar(filas, segundos);
  resultados.push({ modelo, filas: filas.length, caidas, segundos, tokens, msGenerando, segundosDeCarga, reparto, thinkAceptado, ...nota });

  console.log(`  → ${segundos.toFixed(1)} s/seccion | ${(tokens / (msGenerando / 1000)).toFixed(0)} tok/s | carga ${segundosDeCarga.toFixed(0)}s | VRAM ${reparto ? reparto.porcentaje + "%" : "?"} | nota ${nota ? nota.nota.toFixed(1) : "-"}\n`);
}

/* ───────── Tabla final ───────── */

const ok = resultados.filter(r => r.nota !== undefined && r.nota !== null);
ok.sort((a, b) => b.nota - a.nota);

console.log("\n══════ RESULTADO ══════\n");
console.log("modelo                       nota  fiel  util  cifr  form  esp   s/sec  tok/s  VRAM  think");
console.log("─".repeat(94));
for (const r of ok) {
  console.log(
    `${r.modelo.padEnd(26)} ${r.nota.toFixed(1).padStart(5)} ` +
    `${(100 * r.limpias).toFixed(0).padStart(4)}% ${(100 * r.utiles).toFixed(0).padStart(4)}% ` +
    `${(100 * r.cifras).toFixed(0).padStart(4)}% ${(100 * r.formato).toFixed(0).padStart(4)}% ` +
    `${(100 * r.espanol).toFixed(0).padStart(4)}% ` +
    `${r.segundos.toFixed(1).padStart(6)} ${(r.tokens / (r.msGenerando / 1000)).toFixed(0).padStart(6)} ` +
    `${String(r.reparto ? r.reparto.porcentaje + "%" : "?").padStart(5)} ${r.thinkAceptado ? "si" : "NO"}`,
  );
}
for (const r of resultados.filter(x => x.error)) console.log(`${r.modelo.padEnd(26)} NO ARRANCO: ${r.error.slice(0, 50)}`);

console.log("\nfiel = secciones sin cifra, mes ni cita inventada   util = no quedo vacia tras limpiar");
console.log("cifr = cifras del material que sobreviven textuales  form = reglas de formato respetadas");

if (ok.length) {
  console.log(`\nGana: ${ok[0].modelo} (${ok[0].nota.toFixed(1)})`);
  const m = muestras[ok[0].modelo];
  if (m) {
    console.log(`\n─── muestra de "${m.encabezado}" ───`);
    console.log(m.limpio.slice(0, 900));
  }
}
