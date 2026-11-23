/**
 * El modelo local, corriendo en Ollama en esta misma maquina.
 *
 * Cual exactamente lo dice `PLATAFORMA_MODELO`, y lo que ese modelo aguanta lo
 * declara el registro de perfiles de mas abajo. Por defecto `gemma4:e4b`, que no
 * se eligio de oido: gano un banco de pruebas sobre esta misma tarea, con el
 * material real del vault. Esta en `scripts/banco-de-modelos.mjs` y se corre con
 * `npm run banco`.
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
 *
 * Ojo con el alcance de ese hallazgo: era `llama3.1:8b` sobre **Ollama 0.21.2**.
 * Los modelos del registro de abajo si emiten `tool_calls`, asi que el canal
 * existe otra vez detras de `PLATAFORMA_TOOLS`, apagado por defecto. Lo que NO
 * cambia es el reparto: incluso con herramientas disponibles, quien elige el
 * material es el codigo. La bandera sirve para probar el canal, no para
 * devolverle la decision al modelo.
 */
import { listarHerramientas, llamar } from "./canvas.mjs";

const OLLAMA = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
export const MODELO = process.env.PLATAFORMA_MODELO || "gemma4:e4b";

/*
 * ───────── Perfiles de modelo ─────────
 *
 * Esto eran constantes sueltas calibradas a mano para llama3.1:8b, y cambiar de
 * modelo significaba editar codigo. Ahora cada modelo declara lo que aguanta y
 * `PLATAFORMA_MODELO` elige; un nombre que no este en el registro cae al perfil
 * generico, que es conservador a proposito.
 *
 * ── `contexto` arregla un error que estaba vivo ──
 *
 * `num_ctx` no se mandaba nunca, asi que el modelo corria con la ventana que
 * trajera su modelfile (el default de Ollama son 4096 tokens). Y lo que sobra no
 * da error: Ollama lo corta por ADELANTE. Justo por adelante van los anuncios,
 * que `armarBloques` pone primero a proposito, y la pregunta va al final. O sea
 * que el recorte se comia exactamente el material que el orden estaba cuidando,
 * y el modelo contestaba desde la cola. Sin aviso de ninguna clase.
 *
 * Las cuentas de hoy: 8000 caracteres de material (~2300 tokens de espanol) mas
 * cuatro turnos de historial de 2000 (~2300) mas el sistema (~200) mas 700 de
 * salida son ~5500 tokens contra una ventana de 4096. **Ya se estaba truncando
 * con llama3.1.** Por eso el perfil lo pide explicito. No se pide el maximo del
 * modelo porque `num_ctx` reserva cache en la VRAM, y 16K sobra: el prompt mas
 * grande que arma esta plataforma no llega a 6000 tokens.
 *
 * ── Por que los presupuestos de caracteres NO subieron ──
 *
 * Con 12.000 caracteres, llama3.1:8b se perdia: el anuncio que decia "Prueba 1,
 * contenidos Unidad I y Unidad II" estaba ahi, en los primeros 700 caracteres, y
 * el modelo igual contestaba suposiciones sobre un libro de automatas que venia
 * detras. Ese hallazgo es sobre ATENCION, no sobre tamano de ventana, y un 4B no
 * sostiene contextos largos mejor que un 8B. Lo que se arregla aca es que el
 * material quepa entero; cuanto material entra sigue siendo poco y bien elegido,
 * que es la tesis de toda la plataforma: el codigo selecciona.
 */
const PERFIL_GENERICO = {
  contexto: 16_384,
  presupuesto: 8000,
  topeFuente: 1800,
  presupuestoSeccion: 2400,
  topeFuenteSeccion: 1200,
  tokensChat: 700,
  tokensProsa: 450,
  historialTurnos: 4,
  historialCaracteres: 2000,
  buscarAvisos: 12_000,
  buscarGeneral: 36_000,
  espera: 180_000,
  razona: false,
  herramientas: false,
};

/*
 * El `razona` de cada perfil NO es una suposicion: esta medido.
 *
 * Importa en las dos direcciones, y las dos se comprobaron contra el Ollama de
 * esta maquina:
 *
 *   - A los que razonan hay que mandarles `think: false`. Sin eso se gastan el
 *     presupuesto de tokens pensando y devuelven `content` VACIO, asi que cada
 *     seccion de cada guia caeria a extracto literal sin explicar por que.
 *   - A los que no razonan NO se les puede mandar el campo: Ollama responde 400
 *     con `"llama3.1:latest" does not support thinking`.
 *
 * O sea que equivocarse en este booleano rompe la plataforma de un lado o del
 * otro. Si se agrega un modelo, se mide antes:
 *
 *   curl -s http://127.0.0.1:11434/api/chat -d '{"model":"<modelo>",
 *     "stream":false,"think":true,"messages":[{"role":"user","content":"hola"}]}'
 *
 * Si contesta con `message.thinking`, razona. Si contesta 400, no.
 */
const PERFILES = {
  /*
   * El que viene puesto: 6,1 GiB, y gano el banco de pruebas con 98,7 sobre 100.
   *
   * Gano por velocidad entre los que NO inventan nada. Cuatro candidatos
   * llegaron a fidelidad perfecta; de esos, este es seis veces mas rapido que el
   * siguiente, y encima es el que mejor conserva los datos duros (99% de las
   * fechas, horas y salas, contra 94-95% de los otros dos grandes).
   *
   * Entra completo en los 8 GB de la RTX 3070 con 16K de contexto, asi que va a
   * ~149 tok/s: una guia de seis secciones son segundos, no minutos. Y la nota
   * compuesta varia +-1 o 2 puntos entre corridas, asi que lo que decidio no fue
   * el decimal sino esas dos columnas, que si son reproducibles.
   */
  "gemma4:e4b": { ...PERFIL_GENERICO, espera: 120_000, razona: true, herramientas: true },

  /* 4,0 GiB, cuantizacion entrenada (QAT). Mas chico y casi igual de rapido que
   * el e4b, pero inventa algo en 1 de cada 9 secciones donde el e4b no inventa
   * nada: 94,8 contra 98,7. Es el repuesto si hace falta VRAM para otra cosa. */
  "gemma4:e2b-it-qat": { ...PERFIL_GENERICO, espera: 120_000, razona: true, herramientas: true },

  /*
   * 7,5 GiB: el mas capaz del banco en abstracto y aun asi perdio.
   *
   * Llena la VRAM de una tarjeta de 8 GB sin dejar aire, y a 18 tok/s tarda 7,3
   * s por seccion contra 1,0 del e4b. Queda como perfil por si corre en una
   * tarjeta mas grande, donde la cuenta cambia.
   */
  "gemma4:12b": { ...PERFIL_GENERICO, espera: 300_000, razona: true, herramientas: true },

  /* 3,1 GiB, el default anterior. 95,1 en el banco: correcto y rapido, pero
   * inventa mas que los gemma y deshace cifras en palabras. */
  "qwen3.5:4b": { ...PERFIL_GENERICO, espera: 120_000, razona: true, herramientas: true },

  /* 6,1 GiB. Se derrama a la CPU (84% en VRAM) y por eso tarda 7,7 s por
   * seccion, sin ganar nada a cambio: 94,3. Esta por completitud. */
  "qwen3.5:9b": {
    ...PERFIL_GENERICO,
    presupuesto: 10_000,
    topeFuente: 2200,
    espera: 300_000,
    razona: true,
    herramientas: true,
  },

  /*
   * Lo que corria antes de medir nada, y el ultimo del banco: 91,5.
   *
   * Invento datos en 2 de 11 secciones, el peor de los ocho candidatos, y
   * ademas se derrama a la CPU. Se queda como perfil probado para poder volver
   * atras con una linea del .env, no porque convenga. No razona y no emite
   * tool_calls: ver el docblock de arriba.
   */
  "llama3.1": { ...PERFIL_GENERICO },

  /* 2,0 GiB, el mas chico que se midio. 94,2, y el unico que fallaba formato:
   * escribia markdown y 8 o 9 parrafos donde el prompt pide 2 a 5. */
  "granite4": { ...PERFIL_GENERICO, espera: 120_000 },
};

/**
 * Si dos nombres apuntan al mismo modelo.
 *
 * Ollama registra el modelo con el tag completo y asi lo devuelve `/api/tags`:
 * `qwen3.5:4b-q4_K_M`. Si la configuracion dice `qwen3.5:4b`, la comparacion
 * exacta falla y la pantalla anuncia "falta el modelo" teniendolo bajado, lo que
 * manda al estudiante al modo de extractos literales sin ninguna necesidad.
 *
 * Se aceptan tres formas de ser el mismo: igual, el `:latest` implicito, y un
 * sufijo de tag pegado con `:` o con `-` (`llama3.1` ↔ `llama3.1:8b`,
 * `qwen3.5:4b` ↔ `qwen3.5:4b-q4_K_M`). El separador es lo que evita el falso
 * positivo que importa: `llama3` NO es `llama3.1`.
 */
export function mismoModelo(a, b) {
  const limpio = n => String(n || "").trim().toLowerCase().replace(/:latest$/, "");
  const x = limpio(a);
  const y = limpio(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const prefijo = (largo, corto) => largo.startsWith(`${corto}:`) || largo.startsWith(`${corto}-`);
  return prefijo(x, y) || prefijo(y, x);
}

/** El perfil del modelo configurado, o el generico si no esta en el registro. */
export function perfilDe(nombre = MODELO) {
  for (const [clave, perfil] of Object.entries(PERFILES)) {
    if (mismoModelo(nombre, clave)) return { clave, ...perfil };
  }
  return { clave: "generico", ...PERFIL_GENERICO };
}

export const PERFIL = perfilDe(MODELO);

/* El env sigue mandando sobre el perfil: es la valvula para una maquina lenta. */
const ESPERA_MS = Number.parseInt(
  process.env.PLATAFORMA_MODELO_TIMEOUT || String(PERFIL.espera),
  10,
);

/*
 * Cuanto se queda el modelo cargado en la VRAM entre llamadas.
 *
 * Una guia son hasta seis llamadas seguidas. Ollama descarga el modelo despues
 * de unos minutos sin uso, y volver a subir los pesos a la tarjeta es lo mas
 * caro de todo el ciclo: sin esto, una guia puede pagar esa carga seis veces.
 */
const KEEP_ALIVE = process.env.PLATAFORMA_MODELO_KEEP_ALIVE || "15m";

/*
 * El canal de herramientas, apagado por defecto.
 *
 * Prenderlo NO le devuelve al modelo la decision de que material entra: habilita
 * el envio de `tools` y la lectura de `tool_calls`, nada mas. Ver el docblock.
 */
export const HERRAMIENTAS = process.env.PLATAFORMA_TOOLS === "1" && PERFIL.herramientas;

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
 * Dos reglas: cada fuente aporta como mucho el tope del perfil en caracteres, y los
 * anuncios y tareas van primero. Un anuncio dice "la prueba 1 es el 12 y entra
 * hasta la unidad 2"; un libro de teoria, no. Cuando la pregunta es sobre
 * fechas o temarios, el anuncio es la fuente y el libro es el ruido.
 */
const PESO_POR_TIPO = { anuncio: 0, tarea: 1, pagina: 2, modulo: 3, archivo: 4, curso: 5 };

/*
 * El indice de un libro no es materia.
 *
 * Esto no hacia falta mientras los adjuntos no se extraian: las fuentes eran
 * notas cortas. Desde que `scripts/extraer-texto.py` convierte los PDF en texto,
 * una fuente puede ser un libro de trescientas paginas, y su primer pasaje es
 * casi siempre el indice: lineas de puntos conductores terminadas en un numero
 * de pagina. Como el tope por fuente recorta POR EL PRINCIPIO, ese indice
 * desplazaba al contenido de verdad y la seccion salia enumerando titulos en vez
 * de explicarlos.
 *
 * Se descarta por la forma, no por la posicion: un indice puede estar en
 * cualquier parte de un PDF mal armado.
 *
 * El umbral no se eligio a ojo, se midio sobre el indice del libro de automatas
 * del ramo de Grafos. Al principio la regla miraba solo los puntos conductores y
 * no servia: el indice tenia 30% de lineas con puntos, justo por debajo de
 * cualquier umbral razonable. La senal fuerte era otra, la de al lado: el 61% de
 * sus lineas son SOLO un numero, porque el extractor deja la numeracion de
 * seccion y el numero de pagina cada una en su linea. Sumando las dos, ese
 * indice da 90% y los dos pasajes de materia que venian detras dan 5% y 0%. Con
 * una separacion asi, 50% queda lejos de los dos lados.
 */
const PUNTOS_CONDUCTORES = /\.\s?\.\s?\.\s?\./;
const SOLO_UN_NUMERO = /^\s*\d+(?:\.\d+)*\.?\s*$/;

export function esIndice(pasaje) {
  const lineas = String(pasaje || "").split("\n").filter(l => l.trim());
  if (lineas.length < 5) return false;
  const sospechosas = lineas.filter(
    l => PUNTOS_CONDUCTORES.test(l) || SOLO_UN_NUMERO.test(l),
  ).length;
  return sospechosas / lineas.length >= 0.5;
}

/**
 * El mismo armado, con el presupuesto como argumento.
 *
 * Las guias arman una seccion por vez y le pasan al modelo mucho menos material
 * que el chat (una seccion, un tema), asi que necesitan los mismos topes con
 * otros numeros. Lo que no se toca es el criterio: anuncios y tareas primero,
 * nadie se come el presupuesto entero.
 */
export function armarBloques(fuentes, { presupuesto = PERFIL.presupuesto, tope = PERFIL.topeFuente } = {}) {
  const ordenadas = [...fuentes].sort(
    (a, b) => (PESO_POR_TIPO[a.tipo] ?? 9) - (PESO_POR_TIPO[b.tipo] ?? 9),
  );

  const trozos = [];
  let usados = 0;

  for (const fuente of ordenadas) {
    const pasajes = fuente.pasajes || [];
    // Si TODO lo que vino es indice, se deja igual: un indice es mejor que una
    // fuente que desaparece sin que nadie sepa por que.
    const utiles = pasajes.filter(p => !esIndice(p));
    let texto = (utiles.length ? utiles : pasajes).join("\n").trim();
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

/**
 * Saca el razonamiento del texto del modelo.
 *
 * Los modelos que razonan devuelven el pensamiento aparte, en
 * `message.thinking`, y con `think: false` ni deberian producirlo. Pero hay
 * builds y plantillas donde se cuela dentro de `content`, y un bloque de
 * pensamiento impreso en el PDF seria lo peor de los dos mundos: ni es prosa ni
 * es material citable. Peor todavia: el razonamiento suele repetir las claves de
 * cita que acaba de leer, y esas claves SI estan en la lista permitida, asi que
 * el filtro de `limpiarProsa` no las borraria. De ahi que esto corra antes.
 *
 * `<` y `>` tampoco los escapa el generador de LaTeX, asi que un `<think>` que
 * se escape se imprime tal cual.
 */
export function sinRazonamiento(texto) {
  return String(texto || "")
    // El bloque completo, en las etiquetas que usan los modelos conocidos.
    .replace(/<(think|thinking|reasoning|reflection)>[\s\S]*?<\/\1>/gi, "")
    // Abierto y sin cerrar: la generacion se corto en medio del pensamiento. Lo
    // que viene despues es pensamiento a medias, no prosa, y se descarta entero.
    .replace(/<(think|thinking|reasoning|reflection)>[\s\S]*$/i, "")
    // Cierre huerfano: el bloque se abrio antes del primer token que nos llego.
    .replace(/^[\s\S]*?<\/(think|thinking|reasoning|reflection)>/i, "")
    .trim();
}

/** La llamada cruda a Ollama. Devuelve el `message` completo. */
async function invocar(mensajes, { tokens = PERFIL.tokensChat, tools = null } = {}) {
  const cuerpo = {
    model: MODELO,
    stream: false,
    keep_alive: KEEP_ALIVE,
    options: {
      temperature: 0.2,
      num_predict: tokens,
      num_ctx: PERFIL.contexto,
    },
    messages: mensajes,
  };

  // Solo a los modelos que razonan: a los que no, hay builds de Ollama que
  // rechazan el campo con un 400.
  if (PERFIL.razona) cuerpo.think = false;
  if (tools && HERRAMIENTAS) cuerpo.tools = tools;

  let respuesta;
  try {
    respuesta = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpo),
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
  return datos?.message || {};
}

async function preguntarAlModelo(mensajes, opciones = {}) {
  const mensaje = await invocar(mensajes, opciones);
  const texto = sinRazonamiento(mensaje.content);
  if (!texto) {
    // Distinguir las dos causas, porque el remedio es distinto: si lo unico que
    // vino fue razonamiento, el presupuesto de tokens se gasto pensando.
    const penso = String(mensaje.thinking || mensaje.content || "").trim().length > 0;
    throw fallo(
      penso
        ? "El modelo se gasto el presupuesto razonando y no alcanzo a redactar."
        : "El modelo respondio vacio.",
    );
  }
  return texto;
}

/**
 * Las herramientas del MCP en el formato que entiende Ollama.
 *
 * Solo las del agente, que son un subconjunto estricto y mas chico que las que
 * expone la plataforma: ver `HERRAMIENTAS_DEL_AGENTE` en canvas.mjs, donde esta
 * escrito por que queda fuera cada una.
 */
export async function herramientasParaElModelo(usuario) {
  const disponibles = await listarHerramientas(usuario, { soloDelAgente: true });
  return disponibles.map(herramienta => ({
    type: "function",
    function: {
      name: herramienta.nombre,
      description: herramienta.descripcion,
      parameters: herramienta.esquema || { type: "object", properties: {} },
    },
  }));
}

/**
 * La misma llamada, devolviendo tambien las herramientas que pidio el modelo.
 *
 * Existe para poder probar el canal de `tool_calls` de punta a punta sin tocar
 * el camino que usa la plataforma. Nadie la llama todavia: `responder()` y las
 * guias siguen con el material que elige el codigo.
 */
export async function preguntarConHerramientas(mensajes, { tokens, tools } = {}) {
  if (!HERRAMIENTAS) {
    throw fallo("El canal de herramientas esta apagado. Se prende con PLATAFORMA_TOOLS=1.", 409);
  }
  const mensaje = await invocar(mensajes, { tokens, tools });
  return {
    texto: sinRazonamiento(mensaje.content),
    herramientas: Array.isArray(mensaje.tool_calls) ? mensaje.tool_calls : [],
  };
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
      max_chars: PERFIL.buscarAvisos,
    }).catch(() => ({ fuentes: [] })),
    llamar(usuario, "canvas_study_sources", {
      course_id,
      tema,
      // Se pide mas de lo que cabe: el recorte fino lo hace armarMaterial(), que
      // sabe priorizar y limitar lo que aporta cada fuente.
      max_chars: PERFIL.buscarGeneral,
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
      max_chars: PERFIL.buscarGeneral,
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

  // El historial se recorta: una conversacion larga desplaza al material y el
  // modelo empieza a responder de memoria. Cuanto, lo dice el perfil.
  const recientes = historial.slice(-PERFIL.historialTurnos).map(m => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, PERFIL.historialCaracteres),
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
export async function redactarProsa({ sistema, instruccion, material, tokens = PERFIL.tokensProsa }) {
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
    // Comparacion tolerante al tag: ver `mismoModelo`. Con `includes` exacto,
    // tener `qwen3.5:4b-q4_K_M` bajado y `qwen3.5:4b` configurado daba "falta el
    // modelo", y la pantalla mandaba a usar extractos literales sin necesidad.
    const disponible = nombres.some(n => mismoModelo(n, MODELO));

    /*
     * La lista completa de modelos instalados ya no se devuelve.
     *
     * Estaba en la respuesta y nadie la consumia: ni la pantalla ni los tests. Lo
     * que si vale de esa lista es esto, y solo cuando falta el modelo: decir si
     * hay otro de la misma familia bajado, que es el error de dedo mas comun
     * (tener el 9b y haber configurado el 4b).
     */
    const familia = String(MODELO).split(":")[0].toLowerCase();
    const parecidos = disponible
      ? []
      : nombres.filter(n => n.toLowerCase().startsWith(`${familia}:`));

    return {
      vivo: true,
      modelo: MODELO,
      perfil: PERFIL.clave,
      disponible,
      mensaje: disponible
        ? null
        : parecidos.length
          ? `Falta "${MODELO}". De esa familia tienes: ${parecidos.join(", ")}. Bajalo con: ollama pull ${MODELO}`
          : `Falta el modelo: ollama pull ${MODELO}`,
    };
  } catch (error) {
    return { vivo: false, modelo: MODELO, mensaje: `Ollama no responde en ${OLLAMA}` };
  }
}
