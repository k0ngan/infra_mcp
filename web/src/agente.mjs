/**
 * El modelo local: llama3.1 corriendo en Ollama, en esta misma maquina.
 *
 * ───────── Por que el codigo busca y el modelo solo redacta ─────────
 *
 * La idea original era darle las herramientas del MCP a un agente para que el
 * decidiera cuales llamar. No se pudo, y conviene que quede escrito por que:
 * `llama3.1:8b` sobre Ollama 0.21.2 **no emite tool_calls**. Devuelve el JSON
 * como texto suelto en el contenido, confunde el nombre de la herramienta con
 * su descripcion y llega a escribir `<nil>`, que ni siquiera es JSON valido.
 * Probado en espanol y en ingles, con el mismo resultado.
 *
 * Asi que el reparto es el que ya defendia el resto de la plataforma, solo que
 * ahora por necesidad ademas de por diseno:
 *
 *   1. El CODIGO elige que material entra, con `canvas_study_sources`. Es
 *      deterministico y busca en el vault del usuario, no en internet.
 *   2. El MODELO solo redacta a partir de ese material.
 *
 * Sale ganando: el modelo nunca decide que leer ni que herramienta disparar, y
 * cada respuesta queda amarrada a pasajes que existen en el vault. Si el
 * material no cubre la pregunta, la respuesta lo dice en vez de inventar.
 */
import { llamar } from "./canvas.mjs";

const OLLAMA = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
export const MODELO = process.env.PLATAFORMA_MODELO || "llama3.1:latest";

/*
 * Cuanto material se le pasa al modelo.
 *
 * Deliberadamente poco. Con 12.000 caracteres, llama3.1:8b se perdia: el
 * anuncio que decia "Prueba 1, contenidos Unidad I y Unidad II" estaba ahi, en
 * los primeros 700 caracteres, y el modelo igual contestaba suposiciones sobre
 * un libro de automatas que venia detras. Un modelo de 8B no sostiene la
 * atencion sobre contextos largos; con menos material y mejor elegido, acierta.
 *
 * Si algun dia se cambia a un modelo mas grande, esto se puede subir.
 */
const PRESUPUESTO_CARACTERES = 8000;

// Tope por fuente, para que un PDF largo no se coma el presupuesto entero.
const TOPE_POR_FUENTE = 1800;

const ESPERA_MS = Number.parseInt(process.env.PLATAFORMA_MODELO_TIMEOUT || "180000", 10);

// Palabras que estan en todos los documentos y no distinguen nada. El buscador
// del MCP parte el tema en terminos; dejar "que" o "en" adentro hace que calce
// cualquier cosa y el material relevante quede sepultado.
const VACIAS = new Set([
  "que", "cual", "cuales", "cuando", "donde", "como", "cuanto", "cuanta",
  "el", "la", "los", "las", "un", "una", "unos", "unas", "lo", "al", "del",
  "de", "en", "para", "por", "con", "sin", "sobre", "y", "o", "e", "u",
  "es", "son", "fue", "ser", "esta", "este", "esto", "estos", "estas",
  "se", "su", "sus", "me", "mi", "mis", "te", "tu", "tus", "yo",
  "hay", "hace", "tiene", "entra", "entran", "sale", "pide", "piden",
  "favor", "porfa", "dime", "dame", "explica", "explicame",
]);

/**
 * Deja solo los terminos que de verdad buscan algo.
 *
 * "que entra en la prueba 1" -> "prueba 1". Si no queda nada, se devuelve el
 * texto original: es mejor buscar de mas que no buscar.
 */
export function limpiarTema(texto) {
  const terminos = String(texto)
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t && !VACIAS.has(t));
  return terminos.length ? terminos.join(" ") : String(texto);
}

const SISTEMA = [
  "Eres un ayudante de estudio de un estudiante de la UTEM.",
  "Respondes SOLO con el MATERIAL que viene en el mensaje. No agregas conocimiento propio.",
  "Nunca inventas datos, formulas, fechas ni nombres que no esten en el material.",
  "Citas la clave entre parentesis cuando uses un pasaje, copiandola TAL CUAL aparece entre corchetes, por ejemplo (anuncio:131609). No le cambies el prefijo.",
  // El modelo tendia a devolver "no entiendo tu pregunta, reformulala" cuando el
  // material no cuadraba. Eso es inutil: la persona pregunto bien, lo que fallo
  // fue el material. Que diga lo que SI encontro y nombre de donde salio.
  "NUNCA pides que reformulen la pregunta ni dices que no la entiendes.",
  // Esta regla estaba redactada como una plantilla ("resumes en una linea que
  // SI hay...") y el modelo la copiaba literal dentro de la respuesta. Escrita
  // como una condicion, no como una frase, deja de filtrarse.
  "Cuando el material no alcance: primera frase 'Eso no esta en tu material.', segunda frase los titulos de los documentos que si llegaron. Nada mas.",
  "Escribes en espanol de Chile, directo y sin rodeos. Preferible corto.",
].join(" ");

function fallo(mensaje, estado = 502) {
  return Object.assign(new Error(mensaje), { estado });
}

/**
 * Arma el bloque de material a partir de lo que devolvio canvas_study_sources.
 *
 * Dos reglas: cada fuente aporta como mucho TOPE_POR_FUENTE caracteres, y los
 * anuncios y tareas van primero. Un anuncio dice "la prueba 1 es el 12 y entra
 * hasta la unidad 2"; un libro de teoria, no. Cuando la pregunta es sobre
 * fechas o temarios, el anuncio es la fuente y el libro es el ruido.
 */
const PESO_POR_TIPO = { anuncio: 0, tarea: 1, pagina: 2, modulo: 3, archivo: 4, curso: 5 };

/**
 * El mismo armado, con el presupuesto como argumento.
 *
 * Las guias arman una seccion por vez y le pasan al modelo mucho menos material
 * que el chat (una seccion, un tema), asi que necesitan los mismos topes con
 * otros numeros. Lo que no se toca es el criterio: anuncios y tareas primero,
 * nadie se come el presupuesto entero.
 */
export function armarBloques(fuentes, { presupuesto = PRESUPUESTO_CARACTERES, tope = TOPE_POR_FUENTE } = {}) {
  const ordenadas = [...fuentes].sort(
    (a, b) => (PESO_POR_TIPO[a.tipo] ?? 9) - (PESO_POR_TIPO[b.tipo] ?? 9),
  );

  const trozos = [];
  let usados = 0;

  for (const fuente of ordenadas) {
    let texto = (fuente.pasajes || []).join("\n").trim();
    if (!texto) continue;
    if (texto.length > tope) texto = `${texto.slice(0, tope)}…`;

    const bloque = `[${fuente.cita} — ${fuente.titulo}]\n${texto}`;
    if (usados + bloque.length > presupuesto) continue;
    trozos.push(bloque);
    usados += bloque.length;
  }
  return trozos;
}

const armarMaterial = fuentes => armarBloques(fuentes);

async function preguntarAlModelo(mensajes, { tokens = 700 } = {}) {
  let respuesta;
  try {
    respuesta = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODELO,
        stream: false,
        options: { temperature: 0.2, num_predict: tokens },
        messages: mensajes,
      }),
      signal: AbortSignal.timeout(ESPERA_MS),
    });
  } catch (error) {
    // El modelo corre local: si no contesta, casi siempre es que Ollama esta
    // apagado. Vale la pena decirlo asi y no con un error de red a secas.
    throw fallo(
      `No se pudo hablar con Ollama en ${OLLAMA}. Comprueba que este corriendo (${error.message}).`,
      503,
    );
  }

  if (!respuesta.ok) {
    const detalle = await respuesta.text().catch(() => "");
    if (respuesta.status === 404) {
      throw fallo(`Ollama no tiene el modelo "${MODELO}". Bajalo con: ollama pull ${MODELO}`, 503);
    }
    throw fallo(`Ollama respondio ${respuesta.status}. ${detalle.slice(0, 200)}`);
  }

  const datos = await respuesta.json();
  const texto = datos?.message?.content?.trim();
  if (!texto) throw fallo("El modelo respondio vacio.");
  return texto;
}

/**
 * Responde una pregunta sobre un ramo, con el material de ese ramo.
 *
 * @param {object} usuario   usuario de la sesion, con su handler del MCP
 * @param {object} consulta  { course_id, pregunta, historial }
 */
export async function responder(usuario, { course_id, pregunta, historial = [] } = {}) {
  const texto = String(pregunta || "").trim();
  if (!texto) throw fallo("Falta la pregunta.", 400);
  if (!Number.isInteger(course_id)) throw fallo("Falta el ramo sobre el que preguntar.", 400);

  const tema = limpiarTema(texto);

  /*
   * Dos busquedas, y no es por gusto.
   *
   * `canvas_study_sources` devuelve a lo mas 7 fuentes, ordenadas por su propia
   * relevancia, y los PDF largos ganan siempre. Buscando "prueba 1" en Grafos
   * devolvia 6 archivos y un modulo: el anuncio "Fecha Prueba 1", que era
   * justo el que respondia, no entraba. Reordenar despues no sirve, porque lo
   * que no vino no se puede priorizar.
   *
   * Asi que se le reserva un cupo: una busqueda solo entre anuncios y tareas, y
   * otra general. Despues se juntan sin repetir.
   */
  const [avisos, general] = await Promise.all([
    llamar(usuario, "canvas_study_sources", {
      course_id,
      tema,
      tipos: ["anuncio", "tarea"],
      max_chars: 12_000,
    }).catch(() => ({ fuentes: [] })),
    llamar(usuario, "canvas_study_sources", {
      course_id,
      tema,
      // Se pide mas de lo que cabe: el recorte fino lo hace armarMaterial(), que
      // sabe priorizar y limitar lo que aporta cada fuente.
      max_chars: 36_000,
    }),
  ]);

  const vistas = new Set();
  const juntar = lista => (lista || []).filter(f => {
    if (vistas.has(f.cita)) return false;
    vistas.add(f.cita);
    return true;
  });

  let material = general;
  let fuentes = [...juntar(avisos.fuentes), ...juntar(general.fuentes)];
  const conTexto = f => (f.pasajes || []).join("").trim().length > 0;

  /*
   * Respaldo para preguntas generales.
   *
   * Preguntar "que es esta materia" deja el tema en "materia", que no calza con
   * casi nada, y el ayudante contestaba "eso no esta en tu material" teniendo el
   * syllabus del ramo ahi mismo. Cuando la busqueda por termino trae poco, se
   * pide el curso sin tema: devuelve la vista general, que es justo lo que
   * responde ese tipo de pregunta.
   */
  if (fuentes.filter(conTexto).length < 3) {
    const general2 = await llamar(usuario, "canvas_study_sources", {
      course_id,
      max_chars: 36_000,
    }).catch(() => null);
    if (general2) {
      fuentes = [...fuentes, ...juntar(general2.fuentes)];
      material = general2;
    }
  }
  const bloques = armarMaterial(fuentes);

  // Sin material no se le pregunta al modelo. Una respuesta sin fuentes seria
  // justo lo que esta plataforma promete no hacer.
  if (bloques.length === 0) {
    return {
      respuesta:
        "No encontre nada sobre eso en el material que tienes sincronizado de este ramo. " +
        "Puede que falte sincronizar, o que el profesor no lo haya subido.",
      citas: [],
      sin_material: true,
      modelo: MODELO,
      excluidas: material.excluidas || [],
    };
  }

  // El historial se recorta: con 8B, una conversacion larga desplaza al
  // material y el modelo empieza a responder de memoria.
  const recientes = historial.slice(-4).map(m => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, 2000),
  }));

  const respuesta = await preguntarAlModelo([
    { role: "system", content: SISTEMA },
    ...recientes,
    { role: "user", content: `MATERIAL:\n${bloques.join("\n\n")}\n\nPREGUNTA: ${texto}` },
  ]);

  return {
    respuesta,
    citas: fuentes.filter(f => (f.pasajes || []).length).map(f => ({
      cita: f.cita,
      titulo: f.titulo,
      tipo: f.tipo,
    })),
    sin_material: false,
    modelo: MODELO,
    excluidas: material.excluidas || [],
  };
}

/**
 * Redactar un trozo de prosa a partir de material ya elegido.
 *
 * Es lo que usan las guias. La diferencia con `responder()` no es el modelo, es
 * quien manda: aca el llamador ya decidio que material entra y que se pide, y el
 * modelo no elige nada. Se reutiliza la misma conexion y los mismos mensajes de
 * error de Ollama en vez de escribir otros peores al lado.
 */
export async function redactarProsa({ sistema, instruccion, material, tokens = 450 }) {
  const texto = await preguntarAlModelo(
    [
      { role: "system", content: sistema },
      { role: "user", content: `MATERIAL:\n${material}\n\n${instruccion}` },
    ],
    { tokens },
  );
  return texto;
}

/** Estado del modelo local, para poder decirlo en pantalla sin adivinar. */
export async function estadoDelModelo() {
  try {
    const respuesta = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!respuesta.ok) return { vivo: false, modelo: MODELO, mensaje: `Ollama respondio ${respuesta.status}` };

    const { models = [] } = await respuesta.json();
    const nombres = models.map(m => m.name);
    return {
      vivo: true,
      modelo: MODELO,
      disponible: nombres.includes(MODELO),
      instalados: nombres,
      mensaje: nombres.includes(MODELO) ? null : `Falta el modelo: ollama pull ${MODELO}`,
    };
  } catch (error) {
    return { vivo: false, modelo: MODELO, mensaje: `Ollama no responde en ${OLLAMA}` };
  }
}
