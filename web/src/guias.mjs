/**
 * Guias de estudio: de un tema a un PDF, pasando por el material del alumno.
 *
 * ───────── Quien decide que ─────────
 *
 * El reparto es el mismo que ya defiende el chat, llevado un paso mas lejos:
 *
 *   1. El CODIGO busca el material (`canvas_study_sources`), arma el esqueleto
 *      de secciones y le asigna a cada una sus citas.
 *   2. El MODELO redacta UNA seccion por llamada, con el material de esa seccion
 *      y nada mas, y devuelve prosa. No devuelve estructura, no elige fuentes y
 *      no escribe las citas.
 *   3. El CODIGO valida, escribe la nota con `canvas_write_study_guide` y compila
 *      el PDF.
 *
 * El punto 2 es el que importa. `canvas_write_study_guide` falla si una seccion
 * declara una cita que no corresponde a material sincronizado, y eso es a
 * proposito: es lo que hace la guia auditable. Si las citas las escribiera el
 * modelo, esa validacion seria una fuente constante de fallos; poniendolas el
 * codigo, no puede fallar nunca por una cita inventada.
 *
 * ───────── Por que no se usa `format: "json"` de Ollama ─────────
 *
 * Se penso y se descarto. El modo JSON garantiza JSON sintactico, no un esquema
 * correcto: con un modelo de 8B se puede esperar que pierda una clave o anide
 * distinto. Pero sobre todo, aca no queda NADA que estructurar: los encabezados
 * y las citas ya los decide el codigo. Pedir JSON solo gastaria la atencion del
 * modelo en comillas y llaves, y la prosa sale peor. Es la misma leccion que ya
 * esta escrita en agente.mjs sobre los tool_calls.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MODELO, armarBloques, limpiarTema, redactarProsa } from "./agente.mjs";
import { llamar } from "./canvas.mjs";
import { compilar, documentoDeGuia } from "./latex.mjs";
import { carpetaDelRamo } from "./vault.mjs";

/** Seis secciones son seis llamadas al modelo; con 8B, eso ya son minutos. */
export const MAXIMO_SECCIONES = 6;

/** Debajo de esto no es un parrafo, es el modelo carraspeando. */
export const MINIMO_PROSA = 40;

/* Lo que ve el modelo por seccion. Deliberadamente poco: ver agente.mjs. */
const PRESUPUESTO_SECCION = 2400;
const TOPE_POR_FUENTE_SECCION = 1200;

/* Dos fuentes mas cortas que esto se juntan en una sola seccion. */
const SECCION_CORTA = 1200;

const FORMATOS = { pdf: "application/pdf", tex: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8" };

const AVISOS = new Set(["anuncio", "tarea"]);

function fallo(mensaje, estado = 400) {
  return Object.assign(new Error(mensaje), { estado });
}

/* ───────── Nombres y titulos ───────── */

/*
 * Espejo de `sanitizeName` del MCP (src/vault.mjs). No se importa el modulo
 * interno a proposito: todo lo que esta plataforma le pide al MCP pasa por
 * `llamar`. Lo que si hace falta es saber como va a quedar el nombre del archivo
 * para encontrar el PDF al lado de la nota, y un test amarra que los dos sigan
 * de acuerdo.
 */
const ILEGALES = /[<>:"/\\|?*\x00-\x1f]/g;

export function nombreDeGuia(titulo) {
  const limpio = String(titulo ?? "")
    .replace(ILEGALES, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 150);
  return limpio || "sin-nombre";
}

/** Un titulo que se entiende en una lista de veinte: tema y fecha. */
export function tituloPorDefecto({ tema, fecha = new Date() } = {}) {
  const dia = [
    fecha.getFullYear(),
    String(fecha.getMonth() + 1).padStart(2, "0"),
    String(fecha.getDate()).padStart(2, "0"),
  ].join("-");
  const asunto = String(tema || "").trim();
  return asunto ? `Guia - ${asunto} - ${dia}` : `Guia de estudio - ${dia}`;
}

/** "512099 - 143867_EJERCICIOSSEMANA7.pdf" -> "Ejerciciossemana7". */
export function tituloDeFuente(fuente) {
  // La vista general del curso se llama "Curso" en el vault, que como titulo de
  // seccion no dice nada.
  if (fuente.tipo === "curso") return "Vista general del ramo";

  const crudo = String(fuente.titulo || fuente.cita || "")
    .replace(/^\d+\s*-\s*/, "")
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/^\d+_/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!crudo) return "Material del ramo";
  const corto = crudo.length > 70 ? `${crudo.slice(0, 70).trim()}…` : crudo;
  return corto.charAt(0).toUpperCase() + corto.slice(1);
}

/* ───────── El esqueleto ───────── */

function material(fuentes) {
  return armarBloques(fuentes, {
    presupuesto: PRESUPUESTO_SECCION,
    tope: TOPE_POR_FUENTE_SECCION,
  }).join("\n\n");
}

const largoDe = fuente => (fuente.pasajes || []).join("\n").trim().length;

/**
 * Que secciones tiene la guia y con que material se escribe cada una.
 *
 * Tres reglas, y las tres salen de lo que ya se aprendio con el chat:
 *
 *   - Anuncios y tareas van JUNTOS en la primera seccion. Un anuncio es el que
 *     dice "la prueba 2 entra hasta la unidad IV"; repartido entre secciones de
 *     contenido, ese dato se diluye y la guia deja de responder lo que mas se
 *     pregunta.
 *   - Los modulos describen como viene organizada la materia, que es una seccion
 *     por si sola y no se mezcla con el contenido.
 *   - El resto va una seccion por fuente, fusionando las cortas para no producir
 *     secciones de tres frases.
 *
 * Las fuentes sin pasajes se descartan antes de todo: un adjunto sin texto
 * extraido existe, pero no aporta ni una palabra.
 */
export function armarEsqueleto(fuentes, { maximo = MAXIMO_SECCIONES } = {}) {
  const utiles = (fuentes || []).filter(f => largoDe(f) > 0);
  if (!utiles.length) return [];

  const secciones = [];

  const avisos = utiles.filter(f => AVISOS.has(f.tipo));
  if (avisos.length) {
    secciones.push({
      encabezado: "Lo que dijo el profesor: fechas y alcance",
      fuentes: avisos.map(f => f.cita),
      material: material(avisos),
    });
  }

  const modulos = utiles.filter(f => f.tipo === "modulo");
  if (modulos.length) {
    secciones.push({
      encabezado: "Como viene organizada la materia",
      fuentes: modulos.map(f => f.cita),
      material: material(modulos),
    });
  }

  const contenido = utiles.filter(f => !AVISOS.has(f.tipo) && f.tipo !== "modulo");
  let acumuladas = [];

  const cerrar = () => {
    if (!acumuladas.length) return;
    secciones.push({
      encabezado: acumuladas.length === 1
        ? tituloDeFuente(acumuladas[0])
        : `${tituloDeFuente(acumuladas[0])} y otros apuntes`,
      fuentes: acumuladas.map(f => f.cita),
      material: material(acumuladas),
    });
    acumuladas = [];
  };

  for (const fuente of contenido) {
    acumuladas.push(fuente);
    const juntas = acumuladas.reduce((suma, f) => suma + largoDe(f), 0);
    if (juntas >= SECCION_CORTA) cerrar();
  }
  cerrar();

  return secciones.slice(0, maximo);
}

/* ───────── Validacion ───────── */

/**
 * Cinturon y tirantes antes de llamar al MCP.
 *
 * Por construccion las citas las pone el codigo, asi que esto no deberia
 * descartar nunca nada: si lo hace, es un error nuestro y queda anotado. Una
 * seccion que se queda sin ninguna cita se elimina, porque el MCP la rechazaria
 * entera con "no declara fuentes" y se perderia la guia completa por una
 * seccion.
 */
export function validarCitas(secciones, citasValidas) {
  const validas = new Set(citasValidas || []);
  const descartadas = [];
  const limpias = [];

  for (const seccion of secciones || []) {
    const fuentes = (seccion.fuentes || []).filter(cita => {
      if (validas.has(cita)) return true;
      descartadas.push({ seccion: seccion.encabezado, cita });
      return false;
    });
    if (fuentes.length) limpias.push({ ...seccion, fuentes });
  }

  return { secciones: limpias, descartadas };
}

/* ───────── La prosa del modelo ───────── */

const SISTEMA_GUIA = [
  "Escribes UNA seccion de una guia de estudio para un estudiante de la UTEM.",
  "Usas SOLO el MATERIAL que viene en el mensaje. No agregas conocimiento propio.",
  "Nunca inventas datos, formulas, fechas ni nombres que no esten en el material.",
  // Un 8B escribe el encabezado igual si no se le prohibe, y despues sale
  // repetido en el PDF debajo del \section que ya puso el codigo.
  "NO escribes el encabezado de la seccion: ya esta puesto.",
  "NO escribes una linea 'Fuentes:': las citas las pone la plataforma.",
  "NO usas markdown: nada de #, ##, ** ni bloques de codigo.",
  "Escribes 2 a 5 parrafos cortos, o una lista con viñetas que empiezan con '- '.",
  "Si el material no alcanza para la seccion, lo dices en una frase y paras.",
  "Español de Chile, directo y sin rodeos.",
].join(" ");

const PREAMBULOS = /^(aqui|aquí|claro|por supuesto|perfecto|entendido|bien)\b[^\n]*:\s*$/i;

/**
 * Deja la respuesta del modelo en prosa limpia.
 *
 * Todo lo que se quita aca es algo que llama3.1:8b filtra igual aunque el prompt
 * se lo prohiba. La parte que no es cosmetica es la ultima: una cita inline que
 * el modelo se invento se borra, porque un `(archivo:999)` impreso en el PDF es
 * exactamente lo que esta plataforma promete no hacer.
 */
export function limpiarProsa(texto, citasPermitidas = []) {
  const permitidas = new Set(citasPermitidas);

  let limpio = String(texto || "")
    .replace(/\r\n/g, "\n")
    .replace(/^\s*```[a-z]*\s*$/gim, "")
    .trim();

  const lineas = limpio.split("\n");
  while (lineas.length) {
    const primera = lineas[0].trim();
    if (!primera || PREAMBULOS.test(primera) || /^#{1,6}\s/.test(primera) || /^\*\*[^*]+\*\*:?$/.test(primera)) {
      lineas.shift();
      continue;
    }
    break;
  }
  while (lineas.length && /^\s*(fuentes?|citas?)\s*:/i.test(lineas[lineas.length - 1])) lineas.pop();

  limpio = lineas.join("\n")
    .replace(/\*\*/g, "")
    .replace(/\(([a-z]+:[0-9]+)\)/gi, (todo, cita) => (permitidas.has(cita) ? todo : ""))
    // Quitar una cita deja un hueco antes del punto: "pero no ." se lee peor
    // que la cita que acabamos de sacar.
    .replace(/[ \t]+([.,;:])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return limpio.length >= MINIMO_PROSA ? limpio : "";
}

/** Cuando el modelo no sirve o no esta: el material tal cual, rotulado. */
function extractoLiteral(seccion) {
  const texto = String(seccion.material || "")
    // Los bloques vienen rotulados "[cita — titulo]"; en el PDF la cita ya va al
    // pie de la seccion, asi que el rotulo sobra.
    .replace(/^\[[^\]]+\]\n/gm, "")
    .trim();
  return `Extracto literal de tu material:\n\n${texto}`;
}

/* ───────── Lo que quedo fuera ───────── */

/*
 * Los motivos los escribe el MCP en singular ("no menciona el tema"), y al
 * contarlos quedan pegados a un sujeto plural. Son cuatro motivos posibles y
 * conocidos: concordarlos a mano sale mas barato que un conjugador.
 */
const EN_PLURAL = [
  [/^no menciona\b/, "no mencionan"],
  [/^no cabia\b/i, "no cabian"],
  [/^no cabía\b/i, "no cabían"],
  [/^vacia$/i, "vacias"],
  [/^vacía$/i, "vacías"],
];

/** "4 fuentes sin texto extraido", y no una lista de cuarenta lineas. */
export function resumirExcluidas(excluidas) {
  const porMotivo = new Map();
  for (const item of excluidas || []) {
    const motivo = String(item.motivo || "sin motivo").trim();
    porMotivo.set(motivo, (porMotivo.get(motivo) || 0) + 1);
  }

  return [...porMotivo].map(([motivo, cuantas]) => {
    if (cuantas === 1) return `1 fuente ${motivo}`;
    const regla = EN_PLURAL.find(([patron]) => patron.test(motivo));
    return `${cuantas} fuentes ${regla ? motivo.replace(regla[0], regla[1]) : motivo}`;
  });
}

/* ───────── El pipeline ───────── */

async function buscarFuentes(usuario, courseId, tema) {
  /*
   * Dos busquedas, por el mismo motivo que en el chat: `canvas_study_sources`
   * devuelve pocas fuentes ordenadas por su propia relevancia y los PDF largos
   * ganan siempre, asi que al anuncio que responde la pregunta hay que
   * reservarle un cupo aparte.
   */
  const [avisos, general] = await Promise.all([
    llamar(usuario, "canvas_study_sources", {
      course_id: courseId,
      tema,
      tipos: ["anuncio", "tarea"],
      max_chars: 20_000,
    }).catch(() => ({ fuentes: [] })),
    // Una guia puede permitirse mucho mas material que una respuesta de chat: lo
    // que limita al modelo es el presupuesto POR SECCION, no el total.
    llamar(usuario, "canvas_study_sources", { course_id: courseId, tema, max_chars: 60_000 }),
  ]);

  const vistas = new Set();
  const juntar = lista => (lista || []).filter(f => {
    if (vistas.has(f.cita)) return false;
    vistas.add(f.cita);
    return true;
  });

  let paquete = general;
  let fuentes = [...juntar(avisos.fuentes), ...juntar(general.fuentes)];

  // Respaldo para temas que no calzan con casi nada: la vista general del curso
  // es justo lo que responde "de que se trata esto".
  if (fuentes.filter(f => largoDe(f) > 0).length < 2) {
    const generica = await llamar(usuario, "canvas_study_sources", {
      course_id: courseId,
      max_chars: 60_000,
    }).catch(() => null);
    if (generica) {
      fuentes = [...fuentes, ...juntar(generica.fuentes)];
      paquete = generica;
    }
  }

  return { fuentes, paquete };
}

/**
 * Arma una guia completa. Pensada para correr dentro de `trabajos.mjs`.
 *
 * @param {object}   usuario   el de la sesion, con su handler del MCP
 * @param {object}   peticion  { course_id, tema, titulo, fecha_prueba, hora, sala, sin_modelo }
 * @param {Function} reportar  avance, como en sincronizarCursos
 */
export async function generarGuia(usuario, peticion = {}, reportar = () => {}) {
  const courseId = Number.parseInt(peticion.course_id, 10);
  if (!Number.isInteger(courseId)) throw fallo("Falta el ramo sobre el que armar la guia.");

  const tema = String(peticion.tema || "").trim();
  if (!tema) throw fallo("Falta el tema de la guia.");

  const sinModelo = peticion.sin_modelo === true;
  const maximo = Number.isInteger(peticion.secciones_max)
    ? Math.min(Math.max(peticion.secciones_max, 1), MAXIMO_SECCIONES)
    : MAXIMO_SECCIONES;

  const avisosDeLaGuia = [];

  reportar({ hechos: 0, total: maximo + 3, paso: "buscando material" });
  const { fuentes, paquete } = await buscarFuentes(usuario, courseId, limpiarTema(tema));

  reportar({ hechos: 1, paso: "armando las secciones" });

  /*
   * Un ramo donde lo unico con texto es la ficha del curso es un ramo vacio en
   * Canvas, y de ahi no sale una guia: sale una pagina diciendo que no hay nada.
   * Pasa de verdad (INFB6074 tiene 0 modulos, 0 tareas y 0 anuncios), y es mejor
   * decirlo aca que gastar el modelo para que lo diga el.
   */
  const conTexto = fuentes.filter(f => largoDe(f) > 0);
  if (conTexto.length === 1 && conTexto[0].tipo === "curso") {
    throw fallo(
      "De este ramo solo esta sincronizada la ficha del curso, sin modulos, tareas ni anuncios. " +
      "Sincronizalo de nuevo desde Material; si sigue igual, es que el ramo esta vacio en Canvas.",
      404,
    );
  }

  const esqueleto = armarEsqueleto(fuentes, { maximo });

  if (!esqueleto.length) {
    // Nunca una guia vacia: se falla diciendo que paso y no se escribe nada.
    const resumen = resumirExcluidas(paquete?.excluidas);
    throw fallo(
      `No encontre material con texto sobre "${tema}" en este ramo.` +
      (resumen.length ? ` Quedo fuera: ${resumen.join(", ")}.` : "") +
      " Sincroniza el ramo con los adjuntos, o prueba con otro tema.",
      404,
    );
  }

  const sobrantes = armarEsqueleto(fuentes, { maximo: Number.MAX_SAFE_INTEGER }).length - esqueleto.length;
  if (sobrantes > 0) {
    avisosDeLaGuia.push(`${sobrantes} ${sobrantes === 1 ? "seccion quedo" : "secciones quedaron"} fuera por el tope de ${maximo}.`);
  }

  const total = esqueleto.length + 3;
  const redactadas = [];

  for (const [indice, seccion] of esqueleto.entries()) {
    reportar({
      hechos: indice + 1,
      total,
      paso: sinModelo
        ? `extrayendo "${seccion.encabezado}"`
        : `redactando "${seccion.encabezado}" (${indice + 1} de ${esqueleto.length})`,
    });

    let cuerpo = "";
    let origen = "extracto";

    if (!sinModelo) {
      // Un reintento y nada mas. Si el modelo no colabora dos veces seguidas,
      // el material tal cual es mejor que seguir insistiendo.
      for (let intento = 0; intento < 2 && !cuerpo; intento += 1) {
        try {
          const prosa = await redactarProsa({
            sistema: SISTEMA_GUIA,
            instruccion: `Escribe la seccion "${seccion.encabezado}" de una guia sobre "${tema}".`,
            material: seccion.material,
          });
          cuerpo = limpiarProsa(prosa, seccion.fuentes);
          if (cuerpo) origen = "modelo";
        } catch (error) {
          // Ollama caido a mitad no bota el trabajo: lo que ya se redacto se
          // conserva y el resto sale como extracto.
          avisosDeLaGuia.push(`El modelo dejo de responder: ${error.message}`);
          intento = 2;
        }
      }
    }

    if (!cuerpo) {
      cuerpo = extractoLiteral(seccion);
      if (!sinModelo) {
        avisosDeLaGuia.push(`La seccion "${seccion.encabezado}" quedo como extracto literal.`);
      }
    }

    redactadas.push({ encabezado: seccion.encabezado, cuerpo, fuentes: seccion.fuentes, origen });
  }

  reportar({ hechos: esqueleto.length + 1, total, paso: "validando citas y escribiendo la nota" });

  const { secciones, descartadas } = validarCitas(redactadas, paquete?.citas_validas || fuentes.map(f => f.cita));
  if (!secciones.length) throw fallo("Ninguna seccion quedo con citas validas. No se escribio nada.", 500);
  if (descartadas.length) {
    avisosDeLaGuia.push(`${descartadas.length} citas no correspondian a este ramo y se quitaron.`);
  }

  const titulo = String(peticion.titulo || "").trim() || tituloPorDefecto({ tema });

  const escrita = await llamar(usuario, "canvas_write_study_guide", {
    course_id: courseId,
    titulo,
    tema,
    secciones: secciones.map(s => ({ encabezado: s.encabezado, cuerpo: s.cuerpo, fuentes: s.fuentes })),
    tags: ["guia", "plataforma"],
    ...(peticion.fecha_prueba ? { fecha_prueba: String(peticion.fecha_prueba) } : {}),
    ...(peticion.hora ? { hora: String(peticion.hora) } : {}),
    ...(peticion.sala ? { sala: String(peticion.sala) } : {}),
  });

  if (escrita.estado === "cuerpo_preservado" || escrita.estado === "sin_cambios") {
    avisosDeLaGuia.push(
      "Ya existia una nota con este titulo y se respeto lo que escribiste en ella; el PDF si se armo con la version nueva.",
    );
  }

  reportar({ hechos: esqueleto.length + 2, total, paso: "compilando el PDF" });

  const base = path.basename(escrita.guia, ".md");
  const { absoluta } = await carpetaDelRamo(usuario, courseId);

  // El PDF se arma con las secciones en memoria y NUNCA releyendo el .md: si la
  // nota ya existia con el cuerpo preservado, ese .md no tiene lo nuevo.
  const fuente = documentoDeGuia({
    titulo,
    ramo: escrita.curso?.name || `curso ${courseId}`,
    courseId,
    tema,
    fechaPrueba: peticion.fecha_prueba || null,
    hora: peticion.hora || null,
    sala: peticion.sala || null,
    secciones,
    // De la lista juntada, no de la ultima busqueda: `paquete` es solo el ultimo
    // paquete que devolvio el MCP y no trae las fuentes de las busquedas
    // anteriores.
    citas: fuentes
      .filter(f => secciones.some(s => s.fuentes.includes(f.cita)))
      .map(f => ({ cita: f.cita, titulo: tituloDeFuente(f), tipo: f.tipo })),
    modelo: sinModelo ? null : MODELO,
    avisos: [...resumirExcluidas(paquete?.excluidas).map(t => `${t}.`), ...avisosDeLaGuia],
  });

  // El .tex se guarda junto a la nota: es la evidencia de que el PDF salio de
  // LaTeX y permite recompilarlo a mano. Los auxiliares, no.
  fs.writeFileSync(path.join(absoluta, `${base}.tex`), fuente, "utf8");

  const directorio = path.join(
    process.env.PLATAFORMA_TRABAJOS || path.resolve(os.tmpdir(), "plataforma-estudio"),
    "latex",
    crypto.randomBytes(6).toString("hex"),
  );

  let latex;
  try {
    const resultado = await compilar(fuente, { directorio });
    if (resultado.ok) {
      fs.copyFileSync(resultado.pdf, path.join(absoluta, `${base}.pdf`));
      latex = { ok: true, motor: resultado.motor, pasadas: resultado.pasadas, ms: resultado.ms, mensaje: null };
    } else {
      latex = { ok: false, motor: null, mensaje: resultado.motivo, log: resultado.log };
    }
  } finally {
    // Pase lo que pase, el .aux y el .log se quedan fuera del vault.
    fs.rmSync(directorio, { recursive: true, force: true });
  }

  reportar({ hechos: total, total, paso: "listo" });

  return {
    course_id: courseId,
    curso: escrita.curso || null,
    titulo,
    tema,
    base,
    nota: escrita.guia,
    tex: `${base}.tex`,
    estado_nota: escrita.estado,
    secciones: secciones.map(s => ({
      encabezado: s.encabezado,
      fuentes: s.fuentes,
      caracteres: s.cuerpo.length,
      origen: s.origen,
    })),
    citas: escrita.citas || [],
    excluidas: paquete?.excluidas || [],
    avisos: avisosDeLaGuia,
    latex,
    modelo: sinModelo ? null : MODELO,
  };
}

/* ───────── Leer lo que ya esta armado ───────── */

/**
 * Frontmatter en quince lineas.
 *
 * No se importa el parser del MCP: todo lo que esta plataforma le pide al MCP
 * pasa por `llamar`, y para saber si una nota es una guia basta con leer dos
 * claves.
 */
function frontmatter(texto) {
  if (!texto.startsWith("---")) return {};
  const fin = texto.indexOf("\n---", 3);
  if (fin === -1) return {};

  const datos = {};
  let clave = null;

  for (const linea of texto.slice(3, fin).split(/\r?\n/)) {
    const lista = linea.match(/^\s+-\s+(.*)$/);
    if (lista && clave) {
      (datos[clave] = Array.isArray(datos[clave]) ? datos[clave] : []).push(lista[1].trim());
      continue;
    }
    const par = linea.match(/^([a-z_]+):\s*(.*)$/i);
    if (!par) continue;
    clave = par[1];
    datos[clave] = par[2].trim().replace(/^["']|["']$/g, "");
  }
  return datos;
}

async function carpetasDeGuias(usuario, courseId) {
  if (Number.isInteger(courseId)) {
    const { absoluta } = await carpetaDelRamo(usuario, courseId);
    return [{ courseId, absoluta }];
  }

  const estado = await llamar(usuario, "canvas_vault_status");
  const base = estado.configuracion.vault_dir;
  return (estado.carpetas_de_curso || [])
    .map(carpeta => {
      const id = Number.parseInt(path.basename(carpeta).split("-")[0], 10);
      return Number.isFinite(id) ? { courseId: id, absoluta: path.resolve(base, carpeta) } : null;
    })
    .filter(Boolean);
}

/**
 * Las guias que ya existen en el vault.
 *
 * Se reconocen por el frontmatter (`tipo: guia_estudio`) y viven en la raiz de
 * la carpeta del ramo; las notas sincronizadas de Canvas estan en subcarpetas.
 */
export async function listarGuias(usuario, courseId = null) {
  const guias = [];

  for (const { courseId: id, absoluta } of await carpetasDeGuias(usuario, courseId)) {
    if (!fs.existsSync(absoluta)) continue;

    for (const archivo of fs.readdirSync(absoluta)) {
      if (!archivo.toLowerCase().endsWith(".md")) continue;

      const completa = path.join(absoluta, archivo);
      let texto;
      try {
        texto = fs.readFileSync(completa, "utf8");
      } catch {
        continue;
      }

      const datos = frontmatter(texto);
      if (datos.tipo !== "guia_estudio") continue;

      const base = archivo.replace(/\.md$/i, "");
      guias.push({
        course_id: id,
        titulo: base,
        base,
        tema: datos.tema || null,
        fecha_prueba: datos.fecha_prueba || null,
        citas: Array.isArray(datos.fuentes) ? datos.fuentes : [],
        pdf: fs.existsSync(path.join(absoluta, `${base}.pdf`)),
        tex: fs.existsSync(path.join(absoluta, `${base}.tex`)),
        modificado: fs.statSync(completa).mtimeMs,
      });
    }
  }

  guias.sort((a, b) => b.modificado - a.modificado);
  return { guias };
}

/**
 * Un archivo de una guia, para servirlo.
 *
 * `base` llega del navegador y NUNCA construye una ruta: se rechaza si trae
 * separadores, y despues se busca el nombre en el readdir de la carpeta. La
 * comparacion es en NFC porque los titulos llevan acentos y en Windows la misma
 * "i" con tilde puede venir de dos formas distintas.
 */
export async function archivoDeGuia(usuario, courseId, base, formato) {
  const tipo = FORMATOS[String(formato || "").toLowerCase()];
  if (!tipo) throw fallo("Formato invalido: pdf, tex o md.");

  const pedido = String(base || "").trim();
  if (!pedido || /[\\/]|\.\./.test(pedido)) throw fallo("Nombre de guia invalido.");

  const { absoluta } = await carpetaDelRamo(usuario, courseId);
  const extension = String(formato).toLowerCase();
  const buscado = `${pedido}.${extension}`.normalize("NFC");

  const encontrado = fs.readdirSync(absoluta).find(n => n.normalize("NFC") === buscado);
  if (!encontrado) {
    throw fallo(
      extension === "pdf"
        ? "Esa guia no tiene PDF: puede que LaTeX no estuviera disponible cuando se armo."
        : "No encuentro esa guia en tu vault.",
      404,
    );
  }

  return { archivo: path.join(absoluta, encontrado), nombre: encontrado, tipo };
}
