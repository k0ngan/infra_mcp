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
 *   - Permitido: escribir en el vault del usuario, en su propio disco.
 *   - Prohibido: escribir en Canvas.
 *
 * Por eso `canvas_submit_assignment` no esta. Es la unica herramienta del MCP que
 * manda algo de vuelta a Canvas, no se deshace y en varios ramos consume un
 * intento. Esta plataforma es para estudiar.
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
]);

/** La que nunca se expone, nombrada para que se vea en el codigo y en los tests. */
export const HERRAMIENTA_PROHIBIDA = "canvas_submit_assignment";

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
export async function llamar(usuario, herramienta, argumentos = {}) {
  if (herramienta === HERRAMIENTA_PROHIBIDA) {
    throw new ErrorDeCanvas(
      "Esta plataforma no entrega tareas: solo ordena material y arma guias de estudio.",
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

/** Las herramientas que esta plataforma expone, para poder auditarlas desde afuera. */
export async function listarHerramientas(usuario) {
  const respuesta = await usuario.handler({
    jsonrpc: "2.0",
    id: siguienteId++,
    method: "tools/list",
  });
  const todas = respuesta?.result?.tools || [];
  return todas
    .filter(herramienta => HERRAMIENTAS_PERMITIDAS.has(herramienta.name))
    .map(({ name, description }) => ({ nombre: name, descripcion: description }));
}
