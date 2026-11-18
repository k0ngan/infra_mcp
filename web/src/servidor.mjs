/**
 * Servidor de la plataforma. http nativo de Node, sin framework y sin
 * dependencias: el MCP que envuelve tampoco tiene, y es lo que hace que
 * "ambiente reproducible" sea verdad y no una promesa.
 *
 *   node web/src/servidor.mjs
 *
 * Escucha en 127.0.0.1 salvo que se declare PLATAFORMA_HOST a proposito. La
 * plataforma guarda sesiones de Canvas de personas reales; no se expone a la
 * red por accidente.
 *
 * Todo lo que no sea iniciar sesion exige una sesion abierta, y el usuario sale
 * SIEMPRE de esa sesion, nunca de un parametro de la URL. Es la diferencia
 * entre "elige con que vault trabajar" y "entra al tuyo": con el usuario en la
 * query, cualquiera leeria el material de otro cambiando una palabra.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ROL_ADMIN,
  ROL_ESTUDIANTE,
  abrirSesion,
  cabeceraDeCookie,
  cabeceraDeCookieVacia,
  cerrarSesion,
  leerCookieDeSesion,
  leerSesion,
} from "./auth.mjs";
import {
  autenticar,
  cargarUsuarios,
  crearUsuario,
  eliminarUsuario,
  hayUsuarios,
  listarUsuarios,
  obtenerUsuario,
  publico,
  RAIZ,
} from "./usuarios.mjs";
import { ErrorDeCanvas, listarHerramientas, llamar } from "./canvas.mjs";
import { EVENTOS, PREGUNTAS, encuestaDe, guardarEncuesta, registrar, resumen } from "./metricas.mjs";
import { estadoDelModelo, responder } from "./agente.mjs";
import { archivoDeGuia, generarGuia, listarGuias } from "./guias.mjs";
import { sincronizarCursos } from "./sincronizacion.mjs";
import { consultar, enCurso, lanzar } from "./trabajos.mjs";
import { archivoDescargado, contenidoDelRamo, grafoDelRamo, grafoDelVault, notaDelRamo } from "./vault.mjs";
import { estado as estadoDeCookie, estadoDeArchivo, guardar as guardarCookie } from "./cookie.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const PUBLICO = path.resolve(AQUI, "..", "public");

const PUERTO = Number.parseInt(process.env.PLATAFORMA_PUERTO || "8080", 10);
const HOST = process.env.PLATAFORMA_HOST || "127.0.0.1";

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".tex": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".sql": "text/plain; charset=utf-8",
  ".ipynb": "application/json; charset=utf-8",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
};

/* Lo que el navegador muestra sin descargar. El resto va como adjunto. */
const SE_VEN_EN_EL_NAVEGADOR = new Set([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".txt", ".md", ".csv"]);

function responderJson(res, estado, cuerpo, cabeceras = {}) {
  const texto = JSON.stringify(cuerpo, null, 2);
  res.writeHead(estado, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(texto),
    "cache-control": "no-store",
    ...cabeceras,
  });
  res.end(texto);
}

function responderError(res, error) {
  const cuerpo = { error: error?.message || "Error interno" };
  if (error?.sesionVencida) {
    cuerpo.sesion_canvas_vencida = true;
    cuerpo.como_arreglarlo =
      "Canvas rechazo la sesion. Pega una cookie nueva en Usuarios y cookies. " +
      "El material que ya esta en el vault se sigue viendo sin tocar nada.";
  }
  responderJson(res, error?.estado || 500, cuerpo);
}

async function leerCuerpo(req, maximo = 1_000_000) {
  const trozos = [];
  let total = 0;
  for await (const trozo of req) {
    total += trozo.length;
    if (total > maximo) throw Object.assign(new Error("Cuerpo demasiado grande"), { estado: 413 });
    trozos.push(trozo);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(trozos).toString("utf8"));
  } catch {
    throw Object.assign(new Error("El cuerpo no es JSON valido"), { estado: 400 });
  }
}

function servirEstatico(res, nombre) {
  // Se resuelve y se comprueba que siga dentro de public/: sin esto, un ".." en
  // la URL leeria cualquier archivo de la maquina.
  const destino = path.resolve(PUBLICO, `.${path.posix.normalize(nombre)}`);
  if (destino !== PUBLICO && !destino.startsWith(PUBLICO + path.sep)) {
    responderJson(res, 403, { error: "Ruta fuera de public/" });
    return;
  }
  const archivo = fs.existsSync(destino) && fs.statSync(destino).isDirectory()
    ? path.join(destino, "index.html")
    : destino;
  if (!fs.existsSync(archivo)) {
    responderJson(res, 404, { error: `No existe ${nombre}` });
    return;
  }
  const cuerpo = fs.readFileSync(archivo);
  res.writeHead(200, {
    "content-type": TIPOS[path.extname(archivo).toLowerCase()] || "application/octet-stream",
    "content-length": cuerpo.length,
  });
  res.end(cuerpo);
}

/**
 * Lo que necesita la pantalla de material.
 *
 * El vault se lee siempre, porque esta en disco y no depende de Canvas. La
 * consulta en vivo se intenta aparte y, si la sesion esta vencida, se devuelve
 * el motivo junto con el material igual. Una cookie caida no deja la pagina en
 * blanco: deja la pagina con lo sincronizado y un aviso arriba.
 */
async function material(usuario) {
  const estado = await llamar(usuario, "canvas_vault_status");

  const cursos = (estado.carpetas_de_curso || []).map(carpeta => {
    const nombre = path.basename(carpeta);
    const partes = nombre.split("-");
    const id = Number.parseInt(partes[0], 10);
    return {
      carpeta,
      course_id: Number.isFinite(id) ? id : null,
      titulo: (Number.isFinite(id) ? partes.slice(1).join("-") : nombre).replace(/-/g, " ").trim(),
      semestral: carpeta.split("/").length > 2,
    };
  });

  const respuesta = {
    usuario: publico(usuario),
    vault: estado.configuracion.vault_dir,
    subdir: estado.configuracion.subdir,
    cursos_en_vault: cursos,
    sesion: { viva: false, mensaje: null },
  };

  try {
    const prueba = await llamar(usuario, "canvas_test_connection");
    respuesta.sesion = { viva: true, mensaje: null, detalle: prueba };
  } catch (error) {
    respuesta.sesion = { viva: false, mensaje: error.message, vencida: Boolean(error.sesionVencida) };
  }
  return respuesta;
}

function conEstadoDeCookie(usuario) {
  const archivo = estadoDeArchivo(usuario);
  return {
    ...publico(usuario),
    cookie: { ruta: archivo.ruta, existe: archivo.existe, modificado: archivo.modificado },
  };
}

/* ───────── Rutas publicas: lo unico accesible sin sesion ───────── */

const PUBLICAS = {
  /**
   * Latido para el healthcheck del contenedor. No dice nada de nadie: solo que
   * el proceso esta en pie y desde cuando.
   */
  "GET /api/salud": async () => ({ vivo: true, desde: Math.round(process.uptime()) }),

  "GET /api/estado": async (_cuerpo, _url, _usuario, token) => {
    const sesion = leerSesion(token);
    const usuario = sesion ? await obtenerUsuario(sesion.usuarioId).catch(() => null) : null;
    return {
      hay_usuarios: await hayUsuarios(),
      autenticado: Boolean(usuario),
      usuario: usuario ? publico(usuario) : null,
    };
  },

  "POST /api/sesion": async cuerpo => {
    const usuario = await autenticar(cuerpo.correo, cuerpo.contrasena);
    // Un solo mensaje para correo inexistente y clave equivocada: decir cual de
    // los dos fallo le regala al que prueba la mitad de la respuesta.
    if (!usuario) throw Object.assign(new Error("Correo o contrasena incorrectos."), { estado: 401 });
    // Solo las que entran: un intento fallido no es uso, y registrarlo
    // convertiria el archivo en un rastro de quien falla la clave.
    registrar(usuario.id, EVENTOS.SESION);
    return { usuario: publico(usuario), _token: abrirSesion(usuario.id) };
  },

  /**
   * Primer administrador. Solo funciona mientras no haya ningun usuario: una
   * vez creado el primero, esta ruta queda cerrada para siempre.
   */
  "POST /api/bootstrap": async cuerpo => {
    if (await hayUsuarios()) {
      throw Object.assign(new Error("La plataforma ya tiene usuarios."), { estado: 409 });
    }
    const usuario = await crearUsuario({ ...cuerpo, rol: ROL_ADMIN });
    registrar(usuario.id, EVENTOS.ALTA, { via: "bootstrap" });
    return { usuario: publico(usuario), _token: abrirSesion(usuario.id) };
  },

  /**
   * Registro propio. Crea un estudiante y lo deja adentro, con su vault vacio
   * esperando la cookie.
   *
   * Esta abierto porque el servidor escucha en 127.0.0.1: quien puede llegar a
   * esta pantalla ya esta sentado frente a la maquina. Si alguna vez se publica
   * a una red, se cierra con PLATAFORMA_REGISTRO=cerrado y los usuarios los crea
   * un administrador.
   */
  "POST /api/registro": async cuerpo => {
    if (/^(cerrado|no|false|0)$/i.test(process.env.PLATAFORMA_REGISTRO || "")) {
      throw Object.assign(new Error("El registro esta cerrado: pideselo a un administrador."), {
        estado: 403,
      });
    }
    const usuario = await crearUsuario({ ...cuerpo, rol: ROL_ESTUDIANTE });
    registrar(usuario.id, EVENTOS.ALTA, { via: "registro" });
    return { usuario: publico(usuario), _token: abrirSesion(usuario.id) };
  },
};

/* ───────── Rutas privadas: el usuario sale de la sesion ───────── */

function soloAdmin(usuario) {
  if (usuario.rol !== ROL_ADMIN) {
    throw Object.assign(new Error("Hace falta ser administrador."), { estado: 403 });
  }
}

const PRIVADAS = {
  "POST /api/sesion/cerrar": async (_cuerpo, _url, _usuario, token) => {
    cerrarSesion(token);
    return { cerrada: true };
  },

  "GET /api/yo": async (_cuerpo, _url, usuario) => conEstadoDeCookie(usuario),

  "GET /api/material": async (_cuerpo, _url, usuario) => material(usuario),

  /**
   * Trae los ramos de Canvas al vault del usuario.
   *
   * Es el paso que faltaba: guardar la cookie conecta la sesion, pero no mueve
   * nada. Sin esto la pantalla de material se queda vacia y parece que la
   * cookie no hubiera servido.
   *
   * Por defecto NO descarga los adjuntos: son cientos de megas y la primera
   * sincronizacion se haria eterna. Los PDF se bajan despues, cuando hagan
   * falta para una guia.
   */
  /**
   * Trae los ramos de Canvas al vault del usuario.
   *
   * Es el paso que faltaba: guardar la cookie conecta la sesion, pero no mueve
   * nada. Sin esto la pantalla de material se queda vacia y parece que la
   * cookie no hubiera servido.
   *
   * Va ramo por ramo y con reintentos, porque Canvas devuelve 524 cuando se le
   * piden muchas cosas seguidas. Ver sincronizacion.mjs.
   *
   * Por defecto NO descarga los adjuntos: son cientos de megas y la primera
   * sincronizacion se haria eterna.
   */
  /**
   * Lanza la sincronizacion y responde de inmediato con un identificador.
   *
   * NO espera a que termine. Con la peticion abierta, un tunel de Cloudflare
   * corta a los 100 segundos y devuelve 524; con adjuntos el trabajo dura
   * minutos. Asi ninguna peticion dura mas de un parpadeo y el trabajo puede
   * tardar lo que tenga que tardar.
   */
  "POST /api/sincronizar": async (cuerpo, _url, usuario) => {
    const yaVa = enCurso(usuario.id, "sincronizacion");
    if (yaVa) return { trabajo: yaVa, ya_estaba: true };

    const descargarArchivos = cuerpo.descargar_archivos === true;
    const cursoId = Number.isInteger(cuerpo.course_id) ? cuerpo.course_id : null;

    const trabajo = lanzar(usuario.id, "sincronizacion", async reportar => {
      const hecho = await sincronizarCursos(usuario, { descargarArchivos, cursoId, reportar });
      // Dentro del trabajo y despues del await: la ruta solo encola, asi que
      // registrar aqui afuera contaria intentos en vez de sincronizaciones.
      registrar(usuario.id, EVENTOS.SINCRONIZACION);
      return hecho;
    });
    return { trabajo, ya_estaba: false };
  },

  "GET /api/trabajo": async (_cuerpo, url, usuario) =>
    consultar(usuario.id, url.searchParams.get("id")),

  /**
   * Arma una guia de estudio sobre un tema de un ramo.
   *
   * Se lanza igual que la sincronizacion y por el mismo motivo: son seis
   * llamadas al modelo mas una compilacion de LaTeX, o sea minutos. La pagina
   * pregunta por el avance con GET /api/trabajo, que ya existe.
   */
  "POST /api/guia": async (cuerpo, _url, usuario) => {
    if (!Number.isInteger(cuerpo.course_id)) {
      throw Object.assign(new Error("Falta el ramo."), { estado: 400 });
    }
    if (!String(cuerpo.tema || "").trim()) {
      throw Object.assign(new Error("Falta el tema de la guia."), { estado: 400 });
    }

    const yaVa = enCurso(usuario.id, "guia");
    if (yaVa) return { trabajo: yaVa, ya_estaba: true };

    const trabajo = lanzar(usuario.id, "guia", async reportar => {
      const guia = await generarGuia(usuario, cuerpo, reportar);
      // Si generarGuia lanza, no se registra: "termino el recorrido" tiene que
      // significar que hubo una guia, no que se intento.
      registrar(usuario.id, EVENTOS.GUIA);
      return guia;
    });
    return { trabajo, ya_estaba: false };
  },

  /** Las guias que ya estan en el vault. Sin course_id, las de todos los ramos. */
  "GET /api/guias": async (_cuerpo, url, usuario) => {
    const crudo = url.searchParams.get("course_id");
    if (crudo === null || crudo === "" || crudo === "todos") return listarGuias(usuario);

    const id = Number.parseInt(crudo, 10);
    if (!Number.isInteger(id)) throw Object.assign(new Error("course_id invalido."), { estado: 400 });
    return listarGuias(usuario, id);
  },

  /**
   * Entrega el PDF, el .tex o la nota de una guia.
   *
   * Segunda excepcion a que toda la API responda JSON, por lo mismo que la de
   * adjuntos: para que el PDF se abra en el navegador. Pasa por la sesion igual
   * que todo lo demas, y el nombre que llega por la URL nunca construye una ruta.
   */
  "GET /api/guia/archivo": async (_cuerpo, url, usuario, _token, res) => {
    const courseId = Number.parseInt(url.searchParams.get("course_id"), 10);
    if (!Number.isInteger(courseId)) {
      throw Object.assign(new Error("Falta course_id."), { estado: 400 });
    }

    const { archivo, nombre, tipo } = await archivoDeGuia(
      usuario,
      courseId,
      url.searchParams.get("base"),
      url.searchParams.get("formato") || "pdf",
    );
    const cuerpo = fs.readFileSync(archivo);

    res.writeHead(200, {
      "content-type": tipo,
      "content-length": cuerpo.length,
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(nombre)}`,
      // Corto a proposito: una guia se vuelve a armar con el mismo nombre y el
      // navegador no puede quedarse mostrando la version vieja.
      "cache-control": "private, max-age=60",
    });
    res.end(cuerpo);
    return null;   // ya se respondio
  },

  /** Que hay en un ramo: notas por tipo y que adjuntos no tienen texto extraido. */
  "GET /api/ramo": async (_cuerpo, url, usuario) => {
    const id = Number.parseInt(url.searchParams.get("course_id"), 10);
    if (!Number.isInteger(id)) throw Object.assign(new Error("Falta course_id."), { estado: 400 });
    return contenidoDelRamo(usuario, id);
  },

  /** El contenido de una nota, para abrirla al pulsar su punto en el grafo. */
  "GET /api/nota": async (_cuerpo, url, usuario) => {
    const id = Number.parseInt(url.searchParams.get("course_id"), 10);
    if (!Number.isInteger(id)) throw Object.assign(new Error("Falta course_id."), { estado: 400 });
    return notaDelRamo(usuario, id, url.searchParams.get("nodo"));
  },

  /**
   * El grafo de notas. Sin course_id devuelve el vault entero, que es el modo
   * normal; con course_id, solo ese ramo.
   */
  "GET /api/grafo": async (_cuerpo, url, usuario) => {
    const crudo = url.searchParams.get("course_id");
    if (crudo === null || crudo === "" || crudo === "todos") return grafoDelVault(usuario);

    const id = Number.parseInt(crudo, 10);
    if (!Number.isInteger(id)) throw Object.assign(new Error("course_id invalido."), { estado: 400 });
    return grafoDelRamo(usuario, id);
  },

  /**
   * Entrega un adjunto ya descargado del vault.
   *
   * Es una excepcion a que toda la API responda JSON: aqui va el archivo tal
   * cual, para que el PDF se abra en el navegador en vez de bajarse a ciegas.
   * No es una ruta estatica: pasa por la sesion igual que todo lo demas, asi
   * que nadie lee los adjuntos de otro.
   */
  "GET /api/archivo": async (_cuerpo, url, usuario, _token, res) => {
    const courseId = Number.parseInt(url.searchParams.get("course_id"), 10);
    const fileId = Number.parseInt(url.searchParams.get("file_id"), 10);
    if (!Number.isInteger(courseId) || !Number.isInteger(fileId)) {
      throw Object.assign(new Error("Falta course_id o file_id."), { estado: 400 });
    }

    const { archivo, nombre } = await archivoDescargado(usuario, courseId, fileId);
    const extension = path.extname(nombre).toLowerCase();
    const cuerpo = fs.readFileSync(archivo);

    res.writeHead(200, {
      "content-type": TIPOS[extension] || "application/octet-stream",
      "content-length": cuerpo.length,
      "content-disposition":
        `${SE_VEN_EN_EL_NAVEGADOR.has(extension) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(nombre)}`,
      "cache-control": "private, max-age=300",
    });
    res.end(cuerpo);
    return null;   // ya se respondio
  },

  "GET /api/herramientas": async (_cuerpo, _url, usuario) =>
    ({ herramientas: await listarHerramientas(usuario) }),

  /** Si el modelo local esta vivo y tiene el modelo que se le pide. */
  "GET /api/modelo": async () => estadoDelModelo(),

  /**
   * Preguntar sobre un ramo.
   *
   * El material lo elige el codigo con canvas_study_sources y el modelo solo
   * redacta a partir de eso; el por que esta escrito en la cabecera de
   * agente.mjs. Aqui no se decide nada: se pasa la consulta y se devuelve la
   * respuesta con sus citas.
   */
  "POST /api/chat": async (cuerpo, _url, usuario) => {
    registrar(usuario.id, EVENTOS.CHAT);
    return responder(usuario, {
      course_id: cuerpo.course_id,
      pregunta: cuerpo.pregunta,
      // Un historial que no sea arreglo se ignora: mejor responder sin memoria
      // que reventar dentro del agente por un cuerpo mal armado.
      historial: Array.isArray(cuerpo.historial) ? cuerpo.historial : [],
    });
  },

  // Cada quien maneja su propia cookie. Un administrador tampoco pega la de
  // otro: nadie deberia estar tocando la credencial de una persona ajena.
  "GET /api/cookie": async (_cuerpo, _url, usuario) => estadoDeCookie(usuario),
  "POST /api/cookie": async (cuerpo, _url, usuario) => {
    const estado = await guardarCookie(usuario, cuerpo.cookie);
    // Se registra que la pego, no si Canvas la acepto: el paso del recorrido es
    // haberla pegado, y si esta vencida eso ya se le informa en pantalla.
    registrar(usuario.id, EVENTOS.COOKIE);
    return estado;
  },

  "GET /api/usuarios": async (_cuerpo, _url, usuario) => {
    if (usuario.rol !== ROL_ADMIN) return { usuarios: [conEstadoDeCookie(usuario)] };
    const todos = await listarUsuarios();
    return { usuarios: todos.map(conEstadoDeCookie) };
  },

  "POST /api/usuarios": async (cuerpo, _url, usuario) => {
    soloAdmin(usuario);
    const creado = await crearUsuario(cuerpo);
    registrar(creado.id, EVENTOS.ALTA, { via: "admin" });
    return { creado: publico(creado) };
  },

  "POST /api/usuarios/eliminar": async (cuerpo, _url, usuario) => {
    soloAdmin(usuario);
    if (cuerpo.usuario === usuario.id) {
      throw Object.assign(new Error("No puedes quitarte a ti mismo."), { estado: 409 });
    }
    return eliminarUsuario(cuerpo.usuario);
  },

  /* ───────── Adopcion: la encuesta y el cuadro ───────── */

  /**
   * La encuesta que ve cada quien: las preguntas, y lo que ya respondio si ya
   * la respondio. Se puede volver a responder; se guarda la ultima y se
   * conserva la fecha de la primera.
   */
  "GET /api/encuesta": async (_cuerpo, _url, usuario) => ({
    preguntas: PREGUNTAS,
    mia: encuestaDe(usuario.id),
  }),

  "POST /api/encuesta": async (cuerpo, _url, usuario) => ({
    guardada: guardarEncuesta(usuario.id, cuerpo.respuestas || {}),
  }),

  /**
   * El cuadro de adopcion: quien termino el recorrido, cuanto usa, si vuelve y
   * si respondio la encuesta.
   *
   * **Solo administradores.** Son datos personales de companeros de curso: quien
   * entro, cuando y cuantas veces. Un estudiante ve su propia encuesta en
   * GET /api/encuesta y nada mas.
   */
  "GET /api/metricas": async (_cuerpo, _url, usuario) => {
    soloAdmin(usuario);
    return resumen(await listarUsuarios());
  },

  "POST /api/llamar": async (cuerpo, _url, usuario) => {
    if (!cuerpo.herramienta) {
      throw Object.assign(new Error('Falta "herramienta" en el cuerpo'), { estado: 400 });
    }
    return llamar(usuario, cuerpo.herramienta, cuerpo.argumentos || {});
  },
};

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const clave = `${req.method} ${url.pathname}`;
  const token = leerCookieDeSesion(req.headers.cookie);

  try {
    const cuerpo = req.method === "POST" ? await leerCuerpo(req) : {};

    if (PUBLICAS[clave]) {
      const resultado = await PUBLICAS[clave](cuerpo, url, null, token);
      // El token sale por Set-Cookie, nunca en el JSON: asi el JavaScript de la
      // pagina no puede leerlo ni guardarlo donde no corresponde.
      if (resultado?._token) {
        const { _token, ...limpio } = resultado;
        responderJson(res, 200, limpio, { "set-cookie": cabeceraDeCookie(_token) });
        return;
      }
      responderJson(res, 200, resultado);
      return;
    }

    if (PRIVADAS[clave]) {
      const sesion = leerSesion(token);
      if (!sesion) throw Object.assign(new Error("Inicia sesion."), { estado: 401 });
      const usuario = await obtenerUsuario(sesion.usuarioId);

      const resultado = await PRIVADAS[clave](cuerpo, url, usuario, token, res);
      // Una ruta puede escribir la respuesta ella misma (y devolver null); es
      // lo que hace la que entrega archivos, que no responde JSON.
      if (resultado === null) return;
      if (clave === "POST /api/sesion/cerrar") {
        responderJson(res, 200, resultado, { "set-cookie": cabeceraDeCookieVacia() });
        return;
      }
      responderJson(res, 200, resultado);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      responderJson(res, 404, { error: `Ruta desconocida: ${clave}` });
      return;
    }
    if (req.method !== "GET") {
      responderJson(res, 405, { error: "Metodo no permitido" });
      return;
    }
    servirEstatico(res, url.pathname === "/" ? "/index.html" : url.pathname);
  } catch (error) {
    if (!(error instanceof ErrorDeCanvas) && !error?.estado) console.error(error);
    responderError(res, error);
  }
});

// Se carga la configuracion antes de escuchar: si usuarios.json esta mal, es
// mejor saberlo ahora que en la primera peticion.
try {
  const { ruta, porId } = await cargarUsuarios();
  servidor.listen(PUERTO, HOST, () => {
    console.log(`Plataforma de estudio en http://${HOST}:${PUERTO}`);
    console.log(
      porId.size === 0
        ? "Sin usuarios todavia: la primera pantalla crea el administrador."
        : `Usuarios (${porId.size}) leidos de ${ruta}`,
    );
    console.log(`Raiz del proyecto: ${RAIZ}`);
  });
} catch (error) {
  console.error(`No se pudo arrancar: ${error.message}`);
  process.exit(1);
}
