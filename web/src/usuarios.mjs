/**
 * Usuarios: correo, contrasena y rol, al modo del proyecto ODS; y, encima de
 * eso, una configuracion y un vault de Obsidian propios para cada uno.
 *
 * El MCP de Canvas no necesita ningun cambio para esto: `loadConfig(env)` recibe
 * el entorno como argumento y `createHandler(config)` recibe la configuracion ya
 * armada. Entonces un usuario no es mas que un entorno distinto, y dos usuarios
 * nunca comparten estado porque nunca comparten configuracion.
 *
 * El entorno que se arma aqui deja fuera CANVAS_UPLOAD_DIR a proposito. Sin esa
 * variable el MCP deja `uploadDir` en null y la entrega de tareas queda imposible
 * por construccion, no por una bandera que alguien pueda dar vuelta despues. Esta
 * plataforma es solo para estudiar: no escribe en Canvas.
 *
 * El hash de la contrasena vive en usuarios.json, que no se versiona. Nunca sale
 * por la API: `publico()` es la unica forma en que un usuario cruza al cliente.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ROLES,
  ROL_ADMIN,
  ROL_ESTUDIANTE,
  cerrarSesionesDe,
  hashearContrasena,
  verificarContrasena,
} from "./auth.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
export const RAIZ = path.resolve(AQUI, "..", "..");

const ID_VALIDO = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const CORREO_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/*
 * Donde vive el MCP de Canvas, en orden.
 *
 * El camino normal es la dependencia npm (`mcp-canvas`, fijada por commit en
 * package.json): es lo que hace que clonar el repositorio y correrlo sea verdad.
 * Antes el unico camino era la carpeta hermana `utem/Pruebas/mcp/mcp_canvas`,
 * que solo existe en la maquina donde se escribio esto; se conserva de ultima
 * para seguir desarrollando contra el MCP sin reinstalar nada en cada cambio.
 */
const MCP_HERMANO = path.resolve(RAIZ, "..", "utem", "Pruebas", "mcp", "mcp_canvas");

function mcpDelPaquete() {
  try {
    // El paquete declara `exports: { ".": "./src/server.mjs" }`, asi que un
    // import profundo de config.mjs esta bloqueado. Resolviendo la ruta y
    // cargando el archivo directo, se puede igual.
    const servidor = fileURLToPath(import.meta.resolve("mcp-canvas"));
    return path.resolve(path.dirname(servidor), "..");
  } catch {
    return null;
  }
}

let cache = null;

function fallo(mensaje, estado = 400) {
  return Object.assign(new Error(mensaje), { estado });
}

function rutaDelArchivo() {
  return path.resolve(process.env.PLATAFORMA_USUARIOS || path.join(RAIZ, "usuarios.json"));
}

/** Archivo recien inicializado: existe la plataforma, todavia no hay nadie. */
function archivoVacio() {
  return { canvas_base_url: "https://utem.instructure.com", usuarios: {} };
}

function leerArchivo(ruta = rutaDelArchivo()) {
  if (!fs.existsSync(ruta)) return archivoVacio();
  try {
    const datos = JSON.parse(fs.readFileSync(ruta, "utf8"));
    datos.usuarios = datos.usuarios || {};
    return datos;
  } catch (error) {
    throw new Error(`No se pudo leer ${ruta}: ${error.message}`);
  }
}

function escribirArchivo(datos, ruta = rutaDelArchivo()) {
  fs.writeFileSync(ruta, `${JSON.stringify(datos, null, 2)}\n`, "utf8");
}

/** Valida el archivo entero antes de usarlo, para fallar temprano y claro. */
function revisar(datos, ruta) {
  const baseUrl = String(datos.canvas_base_url || "").trim();
  if (!baseUrl) throw new Error(`Falta "canvas_base_url" en ${ruta}.`);

  const vaultsVistos = new Map();
  const correosVistos = new Map();

  for (const [id, bruto] of Object.entries(datos.usuarios)) {
    if (!ID_VALIDO.test(id)) {
      throw new Error(`Id de usuario invalido: "${id}". Usa minusculas, digitos, guion y guion bajo.`);
    }
    if (!bruto || typeof bruto !== "object") throw new Error(`El usuario "${id}" no es un objeto.`);
    if (!bruto.vault || !String(bruto.vault).trim()) {
      throw new Error(`El usuario "${id}" no declara "vault".`);
    }

    const correo = String(bruto.correo || "").trim().toLowerCase();
    if (!CORREO_VALIDO.test(correo)) throw new Error(`El usuario "${id}" no tiene un correo valido.`);
    const correoPrevio = correosVistos.get(correo);
    if (correoPrevio) throw new Error(`Los usuarios "${correoPrevio}" y "${id}" usan el correo ${correo}.`);
    correosVistos.set(correo, id);

    if (bruto.rol && !ROLES.has(bruto.rol)) {
      throw new Error(`El usuario "${id}" tiene un rol desconocido: "${bruto.rol}".`);
    }

    // Dos usuarios apuntando al mismo vault significa que uno lee las notas del
    // otro. Es un error de configuracion, no una preferencia.
    const vault = path.resolve(String(bruto.vault).trim());
    const duenoPrevio = vaultsVistos.get(vault.toLowerCase());
    if (duenoPrevio) throw new Error(`Los usuarios "${duenoPrevio}" y "${id}" comparten el vault ${vault}.`);
    vaultsVistos.set(vault.toLowerCase(), id);
  }

  return baseUrl;
}

/**
 * El identificador interno: lo que nombra la carpeta del vault y la del archivo
 * de cookie.
 *
 * Nadie deberia tener que inventarselo. Si alguien ya dio su correo, pedirle
 * ademas un "identificador" es preguntarle dos veces lo mismo con otras
 * palabras, y la primera vez que lo probamos se escribio el correo en los dos
 * campos. Asi que se deriva, y solo se acepta uno explicito cuando viene de
 * usuarios.json o del panel de administracion.
 */
function normalizarId(valor) {
  return String(valor || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")   // puntos, signos y acentos pasan a guion
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function derivarId(correo, usuariosExistentes = {}) {
  const base = normalizarId(correo.split("@")[0]) || "usuario";
  if (!usuariosExistentes[base]) return base;

  // Dos personas pueden tener el mismo nombre antes de la arroba en dominios
  // distintos. El correo ya es unico; el identificador solo tiene que no chocar.
  for (let n = 2; n < 1000; n += 1) {
    const candidato = `${base.slice(0, 28)}-${n}`;
    if (!usuariosExistentes[candidato]) return candidato;
  }
  throw fallo("No se pudo derivar un identificador libre.", 409);
}

/**
 * Donde vive la cookie de sesion de Canvas de un usuario.
 *
 * Fuera del repositorio siempre. Si usuarios.json no declara una ruta, cada
 * usuario tiene la suya bajo %LOCALAPPDATA%\plataforma-estudio\<id>\, que es la
 * misma convencion que ya usa el MCP para la suya.
 */
export function rutaDeCookie(id, usuario) {
  if (usuario.cookie && String(usuario.cookie).trim()) {
    return path.resolve(String(usuario.cookie).trim());
  }
  const localAppData =
    process.env.LOCALAPPDATA ||
    path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), "AppData", "Local");
  return path.join(localAppData, "plataforma-estudio", id, "canvas_session");
}

/**
 * Entorno del MCP para un usuario. Deliberadamente corto: cada variable que se
 * agregue aqui es una capacidad que se le concede.
 */
function entornoDe(baseUrl, id, usuario) {
  return {
    CANVAS_BASE_URL: baseUrl,
    CANVAS_VAULT_DIR: path.resolve(usuario.vault),
    CANVAS_SUBDIR: usuario.subdir || "Canvas",
    CANVAS_COOKIE_FILE: rutaDeCookie(id, usuario),
    // CANVAS_UPLOAD_DIR no se declara nunca. Ver el comentario de arriba.
  };
}

/** La primera ruta de la lista que tenga de verdad el paquete adentro. */
function elegirMcp(declarado) {
  const candidatos = [
    declarado ? path.resolve(RAIZ, String(declarado)) : null,
    mcpDelPaquete(),
    MCP_HERMANO,
  ].filter(Boolean);

  const encontrado = candidatos.find(d => fs.existsSync(path.join(d, "src", "server.mjs")));
  if (encontrado) return encontrado;

  throw new Error(
    "No encuentro el MCP de Canvas. Corre `npm ci` para instalarlo, o declara " +
    `"mcp_canvas" en usuarios.json con la ruta al paquete. Busque en: ${candidatos.join(", ")}`,
  );
}

async function cargarModulosDelMcp(directorio) {
  const server = path.join(directorio, "src", "server.mjs");
  const config = path.join(directorio, "src", "config.mjs");
  const [{ createHandler }, { loadConfig, describeConfig }] = await Promise.all([
    import(pathToFileURL(server).href),
    import(pathToFileURL(config).href),
  ]);
  return { createHandler, loadConfig, describeConfig };
}

/** Lee la configuracion una vez y deja un handler del MCP por usuario. */
export async function cargarUsuarios() {
  if (cache) return cache;

  const ruta = rutaDelArchivo();
  const datos = leerArchivo(ruta);
  const baseUrl = revisar(datos, ruta);

  const directorioMcp = elegirMcp(datos.mcp_canvas);
  const { createHandler, loadConfig, describeConfig } = await cargarModulosDelMcp(directorioMcp);

  const porId = new Map();
  for (const [id, bruto] of Object.entries(datos.usuarios)) {
    const config = loadConfig(entornoDe(baseUrl, id, bruto));
    porId.set(id, {
      id,
      nombre: bruto.nombre || id,
      correo: String(bruto.correo).trim().toLowerCase(),
      rol: bruto.rol || ROL_ESTUDIANTE,
      contrasena: bruto.contrasena || null,
      config,
      describir: () => describeConfig(config),
      handler: createHandler(config),
    });
  }

  cache = { ruta, directorioMcp, baseUrl, porId };
  return cache;
}

/** La unica forma en que un usuario cruza al cliente. Sin hash, nunca. */
export function publico(usuario) {
  return {
    id: usuario.id,
    nombre: usuario.nombre,
    correo: usuario.correo,
    rol: usuario.rol,
    vault: usuario.config.vaultDir,
  };
}

export async function hayUsuarios() {
  const { porId } = await cargarUsuarios();
  return porId.size > 0;
}

export async function obtenerUsuario(id) {
  const { porId } = await cargarUsuarios();
  const usuario = porId.get(String(id || "").trim());
  if (!usuario) throw fallo(`Usuario desconocido: "${id}".`, 404);
  return usuario;
}

export async function listarUsuarios() {
  const { porId } = await cargarUsuarios();
  return [...porId.values()];
}

/**
 * Comprueba correo y contrasena.
 *
 * Si el correo no existe igual se gasta el tiempo de una verificacion, para que
 * el que prueba no pueda distinguir "ese correo no existe" de "la clave esta
 * mala" midiendo cuanto demora la respuesta.
 */
export async function autenticar(correo, contrasena) {
  const { porId } = await cargarUsuarios();
  const buscado = String(correo || "").trim().toLowerCase();
  const usuario = [...porId.values()].find(u => u.correo === buscado);

  if (!usuario || !usuario.contrasena) {
    await verificarContrasena(String(contrasena || ""), "scrypt$16384$8$1$00$00");
    return null;
  }
  const correcta = await verificarContrasena(String(contrasena || ""), usuario.contrasena);
  return correcta ? usuario : null;
}

/** Solo para las pruebas: obliga a releer el archivo en la proxima llamada. */
export function olvidarCache() {
  cache = null;
}

/**
 * Crea un usuario y lo deja escrito en usuarios.json.
 *
 * Si no se declara un vault, se le arma uno propio bajo vaults/<id>. La cookie
 * de Canvas no se pide aqui: se pega despues, desde la pantalla de Usuarios, y
 * vive fuera del repositorio.
 */
export async function crearUsuario({ id, nombre, correo, contrasena, rol, vault, subdir } = {}) {
  const correoNormalizado = String(correo || "").trim().toLowerCase();
  if (!CORREO_VALIDO.test(correoNormalizado)) throw fallo("El correo no es valido.");

  const datos = leerArchivo();
  const identificador = String(id || "").trim()
    ? normalizarId(id)
    : derivarId(correoNormalizado, datos.usuarios);
  if (!ID_VALIDO.test(identificador)) {
    throw fallo("El identificador usa minusculas, digitos, guion y guion bajo, y parte con letra o digito.");
  }

  const rolPedido = rol || ROL_ESTUDIANTE;
  if (!ROLES.has(rolPedido)) throw fallo(`Rol desconocido: "${rolPedido}".`);

  if (datos.usuarios[identificador]) throw fallo(`Ya existe un usuario "${identificador}".`, 409);

  // El correo si se revisa aqui, para decirlo con claridad en vez de dejar que
  // la validacion del archivo entero lo reporte como un choque entre dos ids.
  const duenoDelCorreo = Object.entries(datos.usuarios)
    .find(([, otro]) => String(otro.correo || "").toLowerCase() === correoNormalizado);
  if (duenoDelCorreo) throw fallo("Ya hay una cuenta con ese correo.", 409);

  const carpeta = vault && String(vault).trim()
    ? path.resolve(String(vault).trim())
    : path.join(RAIZ, "vaults", identificador);

  datos.usuarios[identificador] = {
    nombre: (nombre && String(nombre).trim()) || identificador,
    correo: correoNormalizado,
    rol: rolPedido,
    contrasena: await hashearContrasena(contrasena),
    vault: carpeta,
    subdir: (subdir && String(subdir).trim()) || "Canvas",
  };

  // Se valida el archivo completo ANTES de escribirlo: asi un correo o un vault
  // repetido se rechaza en vez de dejar la configuracion en un estado que no carga.
  revisar(datos, rutaDelArchivo());

  fs.mkdirSync(carpeta, { recursive: true });
  escribirArchivo(datos);
  olvidarCache();
  return obtenerUsuario(identificador);
}

/**
 * Saca un usuario de la configuracion.
 *
 * Borra la entrada y cierra sus sesiones, nada mas: el vault y el archivo de
 * cookie quedan donde estan. Esta plataforma no borra el material de nadie.
 */
export async function eliminarUsuario(id) {
  const identificador = String(id || "").trim().toLowerCase();
  const datos = leerArchivo();

  if (!datos.usuarios[identificador]) throw fallo(`No existe un usuario "${identificador}".`, 404);

  const quedanAdmins = Object.entries(datos.usuarios).some(
    ([otroId, otro]) => otroId !== identificador && (otro.rol || ROL_ESTUDIANTE) === ROL_ADMIN,
  );
  if (!quedanAdmins) {
    throw fallo("Es el ultimo administrador: sin ninguno, nadie podria volver a crear usuarios.", 409);
  }

  const { vault } = datos.usuarios[identificador];
  delete datos.usuarios[identificador];
  escribirArchivo(datos);
  cerrarSesionesDe(identificador);
  olvidarCache();
  return { id: identificador, vault_conservado: vault };
}
