/**
 * Entregar una tarea en Canvas, en dos pasos.
 *
 * Es lo unico de esta plataforma que escribe en Canvas, y es irreversible: en
 * varios ramos consume un intento. Asi que el camino es deliberadamente mas
 * largo que un boton.
 *
 * ───────── Los dos pasos ─────────
 *
 *   1. `revisar()` llama al MCP SIN `confirm`. El MCP valida y devuelve el plan:
 *      el nombre real de la tarea, el vencimiento, si ya hay un envio previo y
 *      que archivos subiria. No manda nada.
 *   2. `entregar()` repite con `confirm: true`. Recien ahi sale a Canvas.
 *
 * El paso 1 no es una invencion de esta plataforma: el propio MCP lo exige, y la
 * pantalla lo usa como la primera mitad de la confirmacion en vez de inventarse
 * una propia. La ventaja de apoyarse en el es que lo que se le muestra a la
 * persona son los datos que Canvas devolvio, no lo que la pantalla creia.
 *
 * ───────── Que acota el riesgo ─────────
 *
 *   - El archivo tiene que haberse subido por la pantalla y vive en la carpeta
 *     de entregas de ESE usuario (ver `carpetaDeEntregas` en usuarios.mjs). El
 *     MCP rechaza cualquier ruta fuera de ahi, asi que no hay forma de entregar
 *     un archivo arbitrario del disco ni el de otra persona.
 *   - El nombre se normaliza antes de escribirlo: nada de "..", ni rutas, ni
 *     separadores. Un nombre con "../" no puede salir de la carpeta.
 *   - Las extensiones las decide el MCP (`.pdf`, `.sql`, `.pbix` por defecto) y
 *     esta plataforma NO las amplia. Si una tarea pide otra cosa, se dice; no se
 *     fuerza.
 *   - El modelo nunca ve esta herramienta: no esta en `HERRAMIENTAS_DEL_AGENTE`.
 *     Entregar lo decide una persona, siempre.
 */
import fs from "node:fs";
import path from "node:path";

import { llamar } from "./canvas.mjs";
import { carpetaDeEntregas } from "./usuarios.mjs";

/** Lo que el MCP acepta subir. Se lee de su configuracion, no se duplica aca. */
function extensionesPermitidas(usuario) {
  const descrito = usuario.describir?.() || {};
  const lista = descrito.subida_extensiones || [];
  return lista.length ? lista : [".pdf", ".sql", ".pbix"];
}

function fallo(mensaje, estado = 400) {
  return Object.assign(new Error(mensaje), { estado });
}

/**
 * Deja el nombre en algo que no puede escapar de la carpeta.
 *
 * Se descarta la ruta entera y se queda solo con el nombre base, asi un
 * "../../.ollama/models" o un "C:\Windows\x.pdf" terminan siendo un nombre
 * suelto adentro de la carpeta del usuario.
 */
export function nombreSeguro(bruto) {
  const base = path.basename(String(bruto || "").replace(/\\/g, "/"));
  const limpio = base
    .replace(/[^\w.\- áéíóúñüÁÉÍÓÚÑÜ]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  if (!limpio || limpio === "_") throw fallo("El archivo no tiene un nombre usable.");
  if (limpio.length > 120) return limpio.slice(-120);
  return limpio;
}

/**
 * Guarda en la carpeta de entregas del usuario un archivo subido por la pantalla.
 *
 * Llega en base64 dentro del JSON y no como multipart. El servidor entero es una
 * tabla de rutas JSON; escribir un parser de multipart a mano para una pantalla
 * seria mas codigo y mas superficie que el 33% que infla el base64.
 */
export function guardarArchivo(usuario, { nombre, contenido_base64 }) {
  const seguro = nombreSeguro(nombre);
  const extension = path.extname(seguro).toLowerCase();
  const permitidas = extensionesPermitidas(usuario);

  if (!extension) throw fallo("El archivo no tiene extension.");
  if (!permitidas.includes(extension)) {
    throw fallo(
      `Canvas no acepta "${extension}" por esta via. Las permitidas son: ${permitidas.join(", ")}. ` +
      "Convierte el archivo, o entrega a mano en Canvas.",
      415,
    );
  }

  let datos;
  try {
    datos = Buffer.from(String(contenido_base64 || ""), "base64");
  } catch {
    throw fallo("El contenido del archivo no se pudo leer.");
  }
  if (!datos.length) throw fallo("El archivo llego vacio.");

  const carpeta = carpetaDeEntregas(usuario.id);
  fs.mkdirSync(carpeta, { recursive: true });
  const destino = path.join(carpeta, seguro);
  fs.writeFileSync(destino, datos);

  return { archivo: seguro, bytes: datos.length, carpeta };
}

/** Los archivos que este usuario tiene listos para entregar. */
export function archivosListos(usuario) {
  const carpeta = carpetaDeEntregas(usuario.id);
  if (!fs.existsSync(carpeta)) return [];
  return fs.readdirSync(carpeta)
    .filter(nombre => fs.statSync(path.join(carpeta, nombre)).isFile())
    .map(nombre => {
      const { size, mtimeMs } = fs.statSync(path.join(carpeta, nombre));
      return { archivo: nombre, bytes: size, cuando: new Date(mtimeMs).toISOString() };
    })
    .sort((a, b) => b.cuando.localeCompare(a.cuando));
}

/** Borra un archivo que se subio y ya no se va a entregar. */
export function olvidarArchivo(usuario, nombre) {
  const seguro = nombreSeguro(nombre);
  const destino = path.join(carpetaDeEntregas(usuario.id), seguro);
  if (!fs.existsSync(destino)) throw fallo("Ese archivo no esta subido.", 404);
  fs.rmSync(destino, { force: true });
  return { archivo: seguro, borrado: true };
}

function rutaDelArchivo(usuario, nombre) {
  const seguro = nombreSeguro(nombre);
  const destino = path.join(carpetaDeEntregas(usuario.id), seguro);
  if (!fs.existsSync(destino)) {
    throw fallo(`No tienes subido "${seguro}". Subelo primero.`, 404);
  }
  return destino;
}

function argumentos(usuario, peticion) {
  const course_id = Number(peticion.course_id);
  const assignment_id = Number(peticion.assignment_id);
  if (!Number.isInteger(course_id) || course_id < 1) throw fallo("Falta el ramo.");
  if (!Number.isInteger(assignment_id) || assignment_id < 1) throw fallo("Falta la tarea.");

  const nombres = Array.isArray(peticion.archivos) ? peticion.archivos : [peticion.archivo];
  const rutas = nombres.filter(Boolean).map(nombre => rutaDelArchivo(usuario, nombre));
  if (!rutas.length) throw fallo("Falta el archivo que quieres entregar.");

  const args = { course_id, assignment_id };
  if (rutas.length === 1) args.file_path = rutas[0];
  else args.file_paths = rutas;
  const comentario = String(peticion.comentario || "").trim();
  if (comentario) args.comment = comentario.slice(0, 2000);
  return args;
}

/**
 * Paso 1: validar y devolver el plan. No manda nada a Canvas.
 *
 * Lo que vuelve es lo que la pantalla tiene que mostrar antes de pedir el visto
 * bueno: tarea, vencimiento, envio previo y archivos.
 */
export async function revisar(usuario, peticion = {}) {
  const plan = await llamar(usuario, "canvas_submit_assignment", argumentos(usuario, peticion), {
    escribirEnCanvas: true,
  });
  return { paso: "revision", confirmado: false, plan };
}

/**
 * Paso 2: entregar de verdad.
 *
 * Exige `confirmar: true` en la peticion ademas del `confirm: true` que se le
 * manda al MCP. Son dos banderas distintas a proposito: la de la peticion dice
 * que una persona apreto el segundo boton, la del MCP dice que esta llamada si
 * escribe. Que una ruta nueva se equivoque y pase una no alcanza para entregar.
 */
export async function entregar(usuario, peticion = {}) {
  if (peticion.confirmar !== true) {
    throw fallo("Falta la confirmacion. Revisa la entrega primero y confirma despues.", 428);
  }
  const resultado = await llamar(
    usuario,
    "canvas_submit_assignment",
    { ...argumentos(usuario, peticion), confirm: true },
    { escribirEnCanvas: true },
  );
  return { paso: "entregado", confirmado: true, resultado };
}
