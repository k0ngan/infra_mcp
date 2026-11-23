/**
 * Puente en proceso con el MCP de Canvas.
 *
 * El servidor MCP expone `createHandler(config)`, que recibe un mensaje JSON-RPC
 * y devuelve la respuesta. Entonces no hace falta levantar un subproceso stdio ni
 * reimplementar el protocolo: se le habla por llamada de funcion, en el mismo
 * proceso, y cada usuario tiene su propio handler con su propia configuracion.
 *
 * La lista de herramientas permitidas esta escrita a mano y a proposito. La
 * division no es "lee" contra "escribe", porque ordenar el vault de Obsidian y
 * dejar una guia de estudio tambien escriben: la division es DONDE escriben.
 *
 *   - Libre: escribir en el vault del usuario, en su propio disco.
 *   - Con permiso explicito: escribir en Canvas, que es irreversible.
 *
 * Esa segunda categoria tiene una sola herramienta, `canvas_submit_assignment`,
 * y durante un buen rato no existio: estaba simplemente prohibida. La pantalla
 * ahora permite entregar, en dos pasos, asi que la regla se volvio mas estrecha
 * en vez de desaparecer. Esta explicado donde se define la categoria, mas abajo.
 */

export const HERRAMIENTAS_PERMITIDAS = new Set([
  "canvas_test_connection",
  "canvas_vault_status",
  "canvas_list_courses",
  "canvas_list_active_tasks",
  "canvas_list_course_assignments",
  "canvas_course_inventory",
  "canvas_course_updates",
  "canvas_sync_course",
  "canvas_sync_all_courses",
  "canvas_download_course_files",
  "canvas_download_pdf",
  "canvas_export_course_sources",
  "canvas_study_sources",
  "canvas_write_study_guide",
  // Entregar. La unica que escribe en Canvas, y por eso tiene su propio
  // guardian mas abajo: estar aca no alcanza para poder invocarla.
  "canvas_submit_assignment",
]);

/**
 * Las que escriben en Canvas. Hoy es una sola, y pide permiso explicito.
 *
 * Durante un buen rato `canvas_submit_assignment` estuvo simplemente prohibida y
 * la plataforma presumia de no escribir en Canvas nunca. Ahora la pantalla si
 * permite entregar, asi que la regla cambio — pero no desaparecio, se volvio mas
 * estrecha:
 *
 *   - `llamar` la rechaza salvo que quien llama pida `escribirEnCanvas: true`.
 *     Una ruta que se agregue manana no puede entregar por descuido.
 *   - no esta en `HERRAMIENTAS_DEL_AGENTE`, asi que el modelo no la ve ni con el
 *     canal de herramientas prendido. Entregar lo decide una persona.
 *   - el propio MCP exige `confirm: true` para entregar de verdad; sin eso solo
 *     valida y devuelve el plan. La pantalla usa ese paso como la primera mitad
 *     de la confirmacion, no se inventa una propia.
 *   - `CANVAS_UPLOAD_DIR` acota de donde puede salir el archivo: ver usuarios.mjs.
 *
 * Sigue siendo cierto lo importante: nada sale hacia Canvas sin que una persona
 * lo haya visto y lo haya confirmado.
 */
export const HERRAMIENTAS_QUE_ESCRIBEN_EN_CANVAS = new Set(["canvas_submit_assignment"]);

/**
 * Lo que puede ver un MODELO, si algun dia se le dan herramientas.
 *
 * Es un subconjunto estricto de las permitidas, y mas chico por dos razones que
 * no se parecen entre si:
 *
 *   - `canvas_sync_*` y `canvas_download_*` son minutos de red y de disco. Que un
 *     modelo las dispare porque le parecio buena idea es una espera larguisima
 *     que el estudiante no pidio.
 *   - `canvas_write_study_guide` queda fuera por una razon de fondo: toda la
 *     auditabilidad de una guia depende de que las citas las escriba el codigo.
 *     Si el modelo pudiera escribir la guia, esa garantia se cae.
 *
 * Lo que queda es buscar y mirar: lo que de verdad necesita para responder.
 */
export const HERRAMIENTAS_DEL_AGENTE = new Set([
  "canvas_study_sources",
  "canvas_list_courses",
  "canvas_list_active_tasks",
  "canvas_course_inventory",
]);

let siguienteId = 1;

export class ErrorDeCanvas extends Error {
  constructor(mensaje, { herramienta, estado = 502 } = {}) {
    super(mensaje);
    this.name = "ErrorDeCanvas";
    this.herramienta = herramienta;
    this.estado = estado;
  }
}

function clasificar(mensaje) {
  // El MCP devuelve el 401 de Canvas como texto. Vale la pena distinguirlo: no es
  // una falla de la plataforma, es la cookie de sesion vencida, y el usuario tiene
  // que saber que la renueve en vez de mirar una pantalla en blanco.
  if (/\b401\b/.test(mensaje)) {
    return { estado: 401, sesionVencida: true };
  }
  if (/\b403\b/.test(mensaje)) {
    return { estado: 403, sesionVencida: true };
  }
  return { estado: 502, sesionVencida: false };
}

/**
 * Llama una herramienta del MCP con la configuracion de un usuario.
 *
 * @param {{id: string, handler: Function}} usuario
 * @param {string} herramienta
 * @param {object} argumentos
 */
export async function llamar(usuario, herramienta, argumentos = {}, { escribirEnCanvas = false } = {}) {
  if (HERRAMIENTAS_QUE_ESCRIBEN_EN_CANVAS.has(herramienta) && !escribirEnCanvas) {
    throw new ErrorDeCanvas(
      `${herramienta} escribe en Canvas y no se deshace: hay que pedirlo explicitamente.`,
      { herramienta, estado: 403 },
    );
  }
  if (!HERRAMIENTAS_PERMITIDAS.has(herramienta)) {
    throw new ErrorDeCanvas(`Herramienta no permitida: ${herramienta}`, { herramienta, estado: 400 });
  }

  const respuesta = await usuario.handler({
    jsonrpc: "2.0",
    id: siguienteId++,
    method: "tools/call",
    params: { name: herramienta, arguments: argumentos },
  });

  if (!respuesta) {
    throw new ErrorDeCanvas(`El MCP no respondio a ${herramienta}.`, { herramienta });
  }
  if (respuesta.error) {
    throw new ErrorDeCanvas(respuesta.error.message || "Error del MCP", { herramienta });
  }

  const resultado = respuesta.result || {};
  if (resultado.isError) {
    const texto = resultado.content?.[0]?.text || "Error sin detalle";
    const { estado, sesionVencida } = clasificar(texto);
    const error = new ErrorDeCanvas(texto, { herramienta, estado });
    error.sesionVencida = sesionVencida;
    throw error;
  }

  // `structuredContent` trae el objeto ya armado; el texto es la misma cosa
  // serializada, y solo hace falta si el servidor no mando el estructurado.
  if (resultado.structuredContent !== undefined) return resultado.structuredContent;
  const texto = resultado.content?.[0]?.text;
  if (texto === undefined) return null;
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

/**
 * Las herramientas que esta plataforma expone, para poder auditarlas desde afuera.
 *
 * `esquema` se incluye porque es lo que necesita el canal de `tool_calls` para
 * declararle al modelo que argumentos acepta cada herramienta. Va aparte del
 * nombre y la descripcion para que la respuesta de `/api/herramientas`, que es
 * humana, se siga leyendo igual.
 */
export async function listarHerramientas(usuario, { soloDelAgente = false } = {}) {
  const respuesta = await usuario.handler({
    jsonrpc: "2.0",
    id: siguienteId++,
    method: "tools/list",
  });
  const permitidas = soloDelAgente ? HERRAMIENTAS_DEL_AGENTE : HERRAMIENTAS_PERMITIDAS;
  const todas = respuesta?.result?.tools || [];
  return todas
    .filter(herramienta => permitidas.has(herramienta.name))
    .map(({ name, description, inputSchema }) => ({
      nombre: name,
      descripcion: description,
      esquema: inputSchema,
    }));
}
