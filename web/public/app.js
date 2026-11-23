/**
 * Frontend de la plataforma. JavaScript a mano, sin framework y sin paso de
 * compilacion: se abre el archivo y es lo que corre.
 *
 * Dos cosas que no viven aqui, a proposito:
 *
 *   - El token de sesion. Va en una cookie HttpOnly que este codigo no puede
 *     leer; el navegador la manda sola en cada peticion.
 *   - El usuario con el que se trabaja. Lo decide el servidor a partir de la
 *     sesion. Aca no hay forma de pedir el vault de otro.
 */

const $ = s => document.querySelector(s);
const estado = { yo: null, modo: "entrar", primerUsuario: false, chat: [], ramoAbierto: null };

async function pedir(ruta, opciones) {
  const respuesta = await fetch(ruta, { credentials: "same-origin", ...opciones });
  const datos = await respuesta.json().catch(() => ({ error: respuesta.statusText }));

  if (!respuesta.ok) {
    // Un 401 estando adentro significa que la sesion se cayo (expiro, o alguien
    // reinicio el servidor). Mostrar "Inicia sesion" dentro del chat no ayuda a
    // nadie: hay que devolver a la pantalla de acceso y decir por que.
    if (respuesta.status === 401 && estado.yo && !ruta.startsWith("/api/sesion")) {
      estado.yo = null;
      sesionCaida();
      throw Object.assign(new Error("Tu sesion se cerro."), { estado: 401, manejado: true });
    }
    const error = Object.assign(new Error(datos.error || `Error ${respuesta.status}`), { datos });
    error.estado = respuesta.status;
    throw error;
  }
  return datos;
}

/** Vuelve al acceso explicando que paso, sin perder lo que la persona escribio. */
function sesionCaida() {
  $("#app").hidden = true;
  $("#acceso").hidden = false;
  estado.modo = "entrar";
  pintarModoDeAcceso();
  nota(
    $("#aviso-acceso"),
    "Tu sesion se cerro.",
    " Puede haber vencido o el servidor se reinicio. Vuelve a entrar y sigues donde estabas.",
  );
}

const enviar = (ruta, cuerpo) =>
  pedir(ruta, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cuerpo || {}),
  });

/** Aviso de error que se calla si el fallo ya se resolvio en otra parte. */
function avisoDeError(elemento, titulo, error) {
  if (error?.manejado) return;
  nota(elemento, titulo, ` ${error.message}`, "mala");
}

/*
 * Lo mismo que dice la caja de aviso, dicho tambien en voz alta.
 *
 * Sincronizar un ramo y armar una guia son minutos, y el avance se pintaba en
 * la caja y nada mas: quien no la ve se quedaba mirando un boton apagado sin
 * saber si quedaban dos ramos o doce.
 *
 * Es UNA region, siempre en el DOM y nunca oculta. Poner `aria-live` en cada
 * caja de aviso no sirve: esas aparecen y desaparecen con [hidden], y una
 * region viva que entra y sale del arbol de accesibilidad no se anuncia de
 * forma fiable. Y se compara con lo anterior porque el avance se repregunta
 * cada tres segundos: sin eso, el mismo "4 de 12" se repetiria solo.
 */
let ultimoAnuncio = "";

function anunciar(texto) {
  const limpio = texto.trim();
  if (!limpio || limpio === ultimoAnuncio) return;
  ultimoAnuncio = limpio;
  $("#anuncio").textContent = limpio;
}

function nota(elemento, titulo, detalle, tono = "") {
  elemento.className = `nota ${tono}`.trim();
  elemento.innerHTML = "";
  if (titulo) {
    const fuerte = document.createElement("strong");
    fuerte.textContent = titulo;
    elemento.append(fuerte);
  }
  if (detalle) elemento.append(document.createTextNode(detalle));
  elemento.hidden = false;
  anunciar(`${titulo || ""} ${detalle || ""}`);
}

const ocultar = elemento => { elemento.hidden = true; };

function pintarSesionCanvas(viva) {
  const insignia = $("#estado-sesion");
  insignia.className = `insignia ${viva ? "viva" : "muerta"}`;
  insignia.textContent = viva ? "Canvas conectado" : "sin sesion de Canvas";
}

/* ───────── Acceso ───────── */

function pintarModoDeAcceso() {
  const registro = estado.modo === "registro";
  for (const campo of document.querySelectorAll(".campo-registro")) campo.hidden = !registro;
  for (const boton of document.querySelectorAll("#modos button")) {
    boton.classList.toggle("activa", boton.dataset.modo === estado.modo);
  }

  $("#acceso-clave").autocomplete = registro ? "new-password" : "current-password";

  if (estado.primerUsuario) {
    $("#modos").hidden = true;
    $("#titulo-acceso").textContent = "Crear administrador";
    $("#enviar-acceso").textContent = "Crear administrador";
    $("#ayuda-acceso").textContent =
      "Todavia no hay nadie. El primero que se registra queda como administrador y puede crear al resto.";
    for (const campo of document.querySelectorAll(".campo-registro")) campo.hidden = false;
    return;
  }

  $("#modos").hidden = false;
  $("#titulo-acceso").textContent = registro ? "Crear cuenta" : "Iniciar sesion";
  $("#enviar-acceso").textContent = registro ? "Crear cuenta" : "Iniciar sesion";
  $("#ayuda-acceso").textContent = registro
    ? "Se te crea un vault propio y vacio. La cookie de Canvas se pega despues, adentro."
    : "Entra con el correo con el que creaste tu cuenta.";
}

async function enviarAcceso(evento) {
  evento.preventDefault();
  const boton = $("#enviar-acceso");
  boton.disabled = true;

  const credenciales = {
    correo: $("#acceso-correo").value,
    contrasena: $("#acceso-clave").value,
  };
  // Sin identificador: el servidor lo deriva del correo. Nadie tiene por que
  // inventarse uno habiendo dado ya su direccion.
  const altaNueva = () => ({
    ...credenciales,
    nombre: $("#acceso-nombre").value,
    vault: $("#acceso-vault").value,
  });

  try {
    if (estado.primerUsuario) {
      await enviar("/api/bootstrap", altaNueva());
    } else if (estado.modo === "registro") {
      await enviar("/api/registro", altaNueva());
    } else {
      await enviar("/api/sesion", credenciales);
    }
    // La clave se limpia apenas se manda: no se queda en el formulario.
    $("#acceso-clave").value = "";
    ocultar($("#aviso-acceso"));
    await arrancar();
  } catch (error) {
    nota($("#aviso-acceso"), "No se pudo entrar", ` ${error.message}`, "mala");
  } finally {
    boton.disabled = false;
  }
}

async function salir() {
  await enviar("/api/sesion/cerrar").catch(() => {});
  estado.yo = null;
  await arrancar();
}

/* ───────── Material ───────── */

function tarjetaDeCurso(curso) {
  // Un boton y no un div: se puede llegar con el teclado y los lectores de
  // pantalla lo anuncian como lo que es, algo que se pulsa.
  const tarjeta = document.createElement(curso.course_id ? "button" : "article");
  tarjeta.className = curso.semestral ? "curso actual" : "curso";

  const titulo = document.createElement("h4");
  titulo.textContent = curso.titulo || curso.carpeta;

  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = curso.course_id ? `course_id ${curso.course_id}` : curso.carpeta;

  tarjeta.append(titulo, meta);

  // Antes esto se sabia solo por el color del borde, y entre los dos azules no
  // todo el mundo distingue. Ahora tambien se lee.
  if (curso.semestral) {
    const semestre = document.createElement("span");
    semestre.className = "semestre";
    semestre.textContent = "semestre actual";
    tarjeta.append(semestre);
  }

  if (curso.course_id) {
    tarjeta.type = "button";
    tarjeta.title = "Ver los archivos de este ramo";

    const ir = document.createElement("span");
    ir.className = "ir";
    ir.textContent = "ver archivos →";
    tarjeta.append(ir);

    tarjeta.addEventListener("click", () => {
      $("#archivos-ramo").value = curso.course_id;
      irAPanel("archivos");
    });
  }
  return tarjeta;
}

async function cargarMaterial() {
  const boton = $("#recargar");
  boton.disabled = true;
  $("#cursos").replaceChildren();
  $("#ruta-vault").textContent = "Leyendo el vault...";

  try {
    const datos = await pedir("/api/material");
    // El separador sale de la propia ruta: con «\\» fijo, en el contenedor
    // —que es Linux— la ruta salia como /app/vaults/alguien\\Canvas.
    const barra = datos.vault.includes("\\") ? "\\" : "/";
    $("#ruta-vault").textContent = `${datos.vault}${barra}${datos.subdir}`;
    pintarSesionCanvas(datos.sesion.viva);

    // El material se muestra aunque la sesion este caida: esta en disco y no
    // depende de Canvas. El aviso explica que es lo que no se pudo actualizar.
    if (datos.sesion.viva) {
      ocultar($("#aviso-material"));
    } else if (datos.sesion.vencida) {
      nota(
        $("#aviso-material"),
        "La sesion de Canvas esta vencida",
        " Esto que ves sigue siendo tu material sincronizado, no se perdio nada. Para traer novedades, pega una cookie nueva en Cookie de Canvas.",
      );
    } else {
      nota($("#aviso-material"), "Sin conexion con Canvas", ` ${datos.sesion.mensaje || ""}`);
    }

    if (datos.cursos_en_vault.length === 0) {
      const vacio = document.createElement("p");
      vacio.className = "vacio";
      vacio.textContent = datos.sesion.viva
        ? "Tu vault esta vacio. Usa «Sincronizar ahora» aqui arriba para traer tus ramos."
        : "Tu vault esta vacio. Primero guarda tu cookie en «Cookie de Canvas» y despues sincroniza.";
      $("#cursos").append(vacio);
      return;
    }

    const orden = [...datos.cursos_en_vault].sort(
      (a, b) => Number(b.semestral) - Number(a.semestral) || (b.course_id || 0) - (a.course_id || 0),
    );
    $("#cursos").append(...orden.map(tarjetaDeCurso));
    llenarRamosDelChat(orden);
  } catch (error) {
    $("#ruta-vault").textContent = "";
    avisoDeError($("#aviso-material"), "No se pudo leer el material", error);
  } finally {
    boton.disabled = false;
  }
}

/**
 * Trae los ramos de Canvas al vault.
 *
 * Lanza el trabajo y pregunta por el avance cada tres segundos. No deja la
 * peticion esperando: por un tunel de Cloudflare, una peticion de mas de 100
 * segundos se corta con un 524, y con adjuntos esto dura minutos.
 */
const espera = ms => new Promise(listo => setTimeout(listo, ms));

function textoDeAvance(avance) {
  if (!avance) return "Empezando...";
  const { hechos = 0, total, paso } = avance;
  const cuenta = total ? `${hechos} de ${total}` : `${hechos}`;
  return paso ? `${cuenta} — ${paso}` : cuenta;
}

async function sincronizar() {
  const boton = $("#sincronizar");
  const conArchivos = $("#descargar-archivos").checked;

  boton.disabled = true;
  boton.textContent = "Sincronizando...";
  nota($("#aviso-sync"), "Trayendo tus ramos desde Canvas.", " Empezando...");

  try {
    const { trabajo } = await enviar("/api/sincronizar", { descargar_archivos: conArchivos });

    let estadoTrabajo;
    for (;;) {
      await espera(3000);
      estadoTrabajo = await pedir(`/api/trabajo?id=${encodeURIComponent(trabajo)}`);
      if (estadoTrabajo.estado !== "corriendo") break;
      nota(
        $("#aviso-sync"),
        "Trayendo tus ramos desde Canvas.",
        ` ${textoDeAvance(estadoTrabajo.avance)}`,
      );
    }

    if (estadoTrabajo.estado === "fallido") {
      nota($("#aviso-sync"), "No se pudo sincronizar", ` ${estadoTrabajo.error}`, "mala");
      return;
    }

    const r = estadoTrabajo.resultado || {};
    const ok = r.cursos?.length ?? 0;
    const fallidos = r.fallidos || [];
    const descargas = (r.cursos || []).reduce((suma, c) => suma + (c.descargas || 0), 0);

    const detalle = [
      `${ok} de ${r.total} ${ok === 1 ? "ramo" : "ramos"}`,
      descargas ? `${descargas} archivos descargados` : null,
    ].filter(Boolean).join(", ");

    if (fallidos.length) {
      // Los que fallaron se nombran. Una sincronizacion a medias que dice
      // cuales faltan sirve; una que calla, no.
      nota(
        $("#aviso-sync"),
        `Sincronizados ${detalle}.`,
        ` Quedaron fuera: ${fallidos.map(f => f.name).join(", ")}. Suele ser que Canvas se demoro; vuelve a darle y normalmente entran.`,
      );
    } else {
      nota($("#aviso-sync"), "Listo.", ` ${detalle}.`, "buena");
    }
    await cargarMaterial();
  } catch (error) {
    avisoDeError($("#aviso-sync"), "No se pudo sincronizar", error);
  } finally {
    boton.disabled = false;
    boton.textContent = "Sincronizar ahora";
  }
}

/* ───────── Cookie de Canvas ───────── */

async function guardarCookie() {
  const campo = $("#cookie");
  const boton = $("#guardar-cookie");
  if (!campo.value.trim()) {
    nota($("#aviso-cookie"), "Falta la cookie", " Pega el valor del header Cookie antes de guardar.", "mala");
    return;
  }

  boton.disabled = true;
  try {
    const resultado = await enviar("/api/cookie", { cookie: campo.value });
    // El campo se limpia apenas se manda: la cookie no se queda dando vueltas
    // en pantalla ni en el historial del formulario.
    campo.value = "";
    $("#ruta-cookie").textContent = resultado.ruta;
    pintarSesionCanvas(resultado.sesion.viva);

    if (resultado.sesion.viva) {
      nota($("#aviso-cookie"), "Cookie guardada y la sesion responde.",
        " Ahora anda a Material y dale a Sincronizar.", "buena");
    } else {
      nota(
        $("#aviso-cookie"),
        "Cookie guardada, pero Canvas la rechaza.",
        ` ${resultado.sesion.mensaje || resultado.aviso || ""}`,
        "mala",
      );
    }
    await cargarMaterial();
  } catch (error) {
    avisoDeError($("#aviso-cookie"), "No se pudo guardar", error);
  } finally {
    boton.disabled = false;
  }
}

async function probarCookie() {
  const boton = $("#probar-cookie");
  boton.disabled = true;
  try {
    const resultado = await pedir("/api/cookie");
    $("#ruta-cookie").textContent = resultado.ruta;
    pintarSesionCanvas(resultado.sesion.viva);
    if (resultado.sesion.viva) nota($("#aviso-cookie"), "La sesion responde.", "", "buena");
    else nota($("#aviso-cookie"), "La sesion no responde.", ` ${resultado.sesion.mensaje || ""}`, "mala");
  } catch (error) {
    avisoDeError($("#aviso-cookie"), "No se pudo probar", error);
  } finally {
    boton.disabled = false;
  }
}

/* ───────── Archivos del ramo ───────── */

const NOMBRE_TIPO = {
  anuncio: "Anuncios", archivo: "Archivos", discusion: "Discusiones",
  modulo: "Modulos", pagina: "Paginas", tarea: "Tareas",
};

function dato(cifra, rotulo, alerta = false) {
  const caja = document.createElement("div");
  caja.className = `dato${alerta ? " alerta" : ""}`;
  const n = document.createElement("span");
  n.className = "cifra";
  n.textContent = cifra;
  const r = document.createElement("span");
  r.className = "rotulo";
  r.textContent = rotulo;
  caja.append(n, r);
  return caja;
}

function filaDeNota(item) {
  const fila = document.createElement("div");
  fila.className = "nota-item";

  const id = document.createElement("span");
  id.className = "id";
  id.textContent = item.id ?? "—";

  const nombre = document.createElement("span");
  nombre.className = "nombre";
  nombre.textContent = item.titulo;
  nombre.title = item.nota;

  fila.append(id, nombre);

  // Solo los adjuntos pueden tener (o no) texto extraido. Marcar los que no lo
  // tienen es el dato mas util de esta pantalla: son los que el ayudante no
  // puede leer, y hasta ahora eso solo se notaba cuando una respuesta salia pobre.
  if (item.tipo === "archivo") {
    const marca = document.createElement("span");
    marca.className = `marca-chica ${item.tiene_texto ? "ok" : "falta"}`;
    marca.textContent = item.tiene_texto ? "legible" : "sin texto";
    marca.title = item.tiene_texto
      ? "Tiene el texto extraido: el ayudante puede leerlo."
      : "Es una imagen o un PDF escaneado sin texto extraido.";
    fila.append(marca);

    // Solo se puede abrir lo que esta descargado. Un adjunto sin descargar
    // existe como nota, pero el archivo no esta en el disco.
    if (item.descargado) {
      const abrir = document.createElement("a");
      abrir.className = "abrir";
      abrir.href = `/api/archivo?course_id=${estado.ramoAbierto}&file_id=${item.id}`;
      abrir.target = "_blank";
      abrir.rel = "noopener";
      abrir.textContent = "abrir";
      fila.append(abrir);
    } else {
      const pendiente = document.createElement("span");
      pendiente.className = "marca-chica falta";
      pendiente.textContent = "sin descargar";
      pendiente.title = "Sincroniza marcando «descargar tambien los adjuntos».";
      fila.append(pendiente);
    }
  }
  return fila;
}

async function verArchivos() {
  const boton = $("#ver-archivos");
  const id = Number.parseInt($("#archivos-ramo").value, 10);
  if (!Number.isInteger(id)) return;

  boton.disabled = true;
  ocultar($("#aviso-archivos"));
  estado.ramoAbierto = id;

  try {
    const r = await pedir(`/api/ramo?course_id=${id}`);

    $("#resumen-ramo").replaceChildren(
      dato(r.resumen.notas, "notas"),
      dato(r.resumen.descargados, "descargados"),
      dato(r.resumen.textos_extraidos, "con texto"),
      dato(r.resumen.adjuntos_sin_texto, "sin texto", r.resumen.adjuntos_sin_texto > 0),
    );

    const bloques = r.grupos.map(grupo => {
      const card = document.createElement("div");
      card.className = "card grupo-archivos";

      const h = document.createElement("h3");
      h.textContent = NOMBRE_TIPO[grupo.tipo] || grupo.carpeta;
      const cuenta = document.createElement("span");
      cuenta.className = "cuenta";
      cuenta.textContent = `${grupo.total} ${grupo.total === 1 ? "nota" : "notas"}`;
      h.append(cuenta);

      const lista = document.createElement("div");
      lista.className = "lista-notas";
      lista.append(...grupo.items.map(filaDeNota));

      card.append(h, lista);
      return card;
    });

    $("#listado-ramo").replaceChildren(...bloques);
    if (!bloques.length) {
      nota($("#aviso-archivos"), "Este ramo no tiene nada en tu vault.", " Sincronizalo desde Material.");
    }
  } catch (error) {
    $("#listado-ramo").replaceChildren();
    avisoDeError($("#aviso-archivos"), "No se pudo leer el ramo", error);
  } finally {
    boton.disabled = false;
  }
}

/* ───────── Grafo del vault ───────── */

/*
 * Los seis tipos de nota, en una sola familia.
 *
 * Antes eran un arcoiris: azul, celeste, verde, ambar, gris y morado, un color
 * por tipo elegido sin relacion entre si. Contra el resto de la pantalla
 * —papel, tinta y un acento— el grafo parecia de otra aplicacion.
 *
 * Ahora los seis salen del mismo eje azul-tinta y se distinguen por claridad,
 * no por tono. El unico que se sale es el anuncio: es el tipo que avisa de
 * algo, conviene que salte, y un ocre apagado lo consigue sin traer un color
 * saturado a la paleta.
 *
 * Es el unico sitio de la interfaz con mas de tres valores, y es a proposito:
 * seis categorias necesitan seis marcas distinguibles, y la leyenda esta justo
 * debajo del lienzo para nombrarlas.
 */
const COLOR_TIPO = {
  modulo: "#004E9A",     // el acento: el nodo que estructura
  pagina: "#6BA3D6",     // azul claro
  tarea: "#13263A",      // casi tinta
  anuncio: "#A8762F",    // el unico calido: es el que avisa
  archivo: "#9BA5B0",    // pizarra clara
  discusion: "#5A6B7D",  // pizarra media
};

const ANCHO_GRAFO = 1400, ALTO_GRAFO = 900;

// Mas alla de esta distancia la repulsion entre notas es despreciable y no se
// calcula. La separacion a larga distancia la aportan los centros de ramo.
const CORTE = 110;

let simulacion = null;

/**
 * Detiene la simulacion en curso.
 *
 * El `viva` no sobra. Cancelar el cuadro pendiente no basta: el bucle anterior
 * vuelve a pedir uno nuevo desde dentro de si mismo y lo guarda en la
 * simulacion que acaba de reemplazarlo, asi que cada redibujo dejaba un bucle
 * zombi corriendo para siempre.
 */
function pararSimulacion() {
  if (simulacion) {
    simulacion.viva = false;
    cancelAnimationFrame(simulacion.cuadro);
    simulacion = null;
  }
}

const leerColor = nombre =>
  getComputedStyle(document.documentElement).getPropertyValue(nombre).trim();

/**
 * Dibuja el vault completo, como el grafo global de Obsidian.
 *
 * ───────── Decisiones que no son obvias ─────────
 *
 * 1. CANVAS y no SVG. Con un ramo (24 notas) el SVG iba perfecto; con las 1.252
 *    del vault hay que tocar unos 2.600 elementos del DOM por cuadro y eso no
 *    lo mueve ningun navegador. En canvas se repinta todo de una.
 *
 * 2. Repulsion en dos escalas. Entre notas es local, por rejilla: cada nota
 *    solo se compara con las de las celdas vecinas. Pero con solo eso los ramos
 *    quedaban revueltos, porque nada empuja a un grupo lejos de otro; entonces
 *    aparte se repelen los CENTROS de cada ramo — veinte puntos, coste nulo — y
 *    eso es lo que separa las islas.
 *
 * 3. La simulacion SE DUERME. Cuando el grafo se acomoda deja de calcular y de
 *    repintar, y solo despierta si mueves, haces zoom o arrastras. Un grafo
 *    quieto no tiene por que gastar bateria, y asi el tamano del vault deja de
 *    importar una vez colocado.
 */
function dibujarGrafo({ nodos, aristas }) {
  pararSimulacion();

  const lienzo = $("#lienzo-grafo");
  const ctx = lienzo.getContext("2d");
  const globo = $("#globo");
  globo.hidden = true;

  if (!nodos.length) {
    ctx.clearRect(0, 0, lienzo.width, lienzo.height);
    return;
  }

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  lienzo.width = ANCHO_GRAFO * dpr;
  lienzo.height = ALTO_GRAFO * dpr;

  const puntos = nodos.map((n, i) => {
    const t = i / nodos.length;
    const angulo = t * Math.PI * 2 * 9;
    const radio = 40 + t * 420;
    return {
      x: ANCHO_GRAFO / 2 + Math.cos(angulo) * radio,
      y: ALTO_GRAFO / 2 + Math.sin(angulo) * radio,
      vx: 0, vy: 0, fijo: false,
    };
  });

  const maxGrado = Math.max(1, ...nodos.map(n => n.grado));
  const radios = nodos.map(n => 2.5 + Math.sqrt(n.grado / maxGrado) * 8);
  const colores = nodos.map(n => COLOR_TIPO[n.tipo] || "#888");

  const ramos = [...new Set(nodos.map(n => n.curso))];
  const ramoDe = nodos.map(n => ramos.indexOf(n.curso));
  const centros = ramos.map(() => ({ x: 0, y: 0, n: 0, fx: 0, fy: 0 }));

  const etiquetas = [];
  nodos.forEach((n, i) => {
    if (n.grado >= Math.max(4, maxGrado * 0.5)) {
      etiquetas.push({ i, texto: n.titulo.length > 26 ? `${n.titulo.slice(0, 25)}…` : n.titulo });
    }
  });

  const REPULSION = 1200, RESORTE = 0.03, LARGO = 48;
  const REPULSION_RAMOS = 90_000, COHESION = 0.004, CENTRO = 0.15;

  const celdas = new Map();
  // La vista es independiente de la simulacion: encuadra sola hasta que tocas
  // el zoom, y desde ahi manda lo que tu hiciste.
  const vista = { escala: 1, dx: 0, dy: 0, manual: false };
  let alfa = 1;
  let repintar = true;

  const mia = { cuadro: 0, viva: true };

  /* ───────── Vista ───────── */

  function encuadrar() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of puntos) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const margen = 40;
    const escala = Math.min(
      (ANCHO_GRAFO - margen * 2) / Math.max(1, maxX - minX),
      (ALTO_GRAFO - margen * 2) / Math.max(1, maxY - minY),
      1.6,
    );
    // Se persigue con suavidad: si no, el dibujo da saltos mientras se acomoda.
    vista.escala += (escala - vista.escala) * 0.08;
    vista.dx += ((ANCHO_GRAFO - (minX + maxX) * vista.escala) / 2 - vista.dx) * 0.08;
    vista.dy += ((ALTO_GRAFO - (minY + maxY) * vista.escala) / 2 - vista.dy) * 0.08;
  }

  const aMundo = (sx, sy) => {
    const caja = lienzo.getBoundingClientRect();
    const x = ((sx - caja.left) / caja.width) * ANCHO_GRAFO;
    const y = ((sy - caja.top) / caja.height) * ALTO_GRAFO;
    return { x: (x - vista.dx) / vista.escala, y: (y - vista.dy) / vista.escala };
  };

  /* ───────── Dibujo ───────── */

  function pintar() {
    if (!vista.manual) encuadrar();

    const fondo = leerColor("--card");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = `hsl(${fondo})`;
    ctx.fillRect(0, 0, ANCHO_GRAFO, ALTO_GRAFO);
    ctx.translate(vista.dx, vista.dy);
    ctx.scale(vista.escala, vista.escala);

    ctx.strokeStyle = `hsl(${leerColor("--border-strong")} / .45)`;
    ctx.lineWidth = 0.7 / vista.escala;
    ctx.beginPath();
    for (const [a, b] of aristas) {
      ctx.moveTo(puntos[a].x, puntos[a].y);
      ctx.lineTo(puntos[b].x, puntos[b].y);
    }
    ctx.stroke();

    for (let i = 0; i < puntos.length; i += 1) {
      ctx.beginPath();
      ctx.arc(puntos[i].x, puntos[i].y, radios[i], 0, Math.PI * 2);
      ctx.fillStyle = colores[i];
      ctx.fill();
      // Los fijados llevan un anillo: hay que poder ver cuales clavaste.
      if (puntos[i].fijo) {
        ctx.lineWidth = 2 / vista.escala;
        ctx.strokeStyle = `hsl(${leerColor("--foreground")})`;
        ctx.stroke();
      }
    }

    ctx.font = `${10 / vista.escala}px ui-monospace, 'Cascadia Mono', Consolas, monospace`;
    ctx.textAlign = "center";
    ctx.lineWidth = 3 / vista.escala;
    ctx.strokeStyle = `hsl(${fondo})`;
    ctx.fillStyle = `hsl(${leerColor("--muted-foreground")})`;
    for (const e of etiquetas) {
      const y = puntos[e.i].y - radios[e.i] - 5 / vista.escala;
      ctx.strokeText(e.texto, puntos[e.i].x, y);
      ctx.fillText(e.texto, puntos[e.i].x, y);
    }
  }

  /* ───────── Simulacion ───────── */

  function fisica() {
    celdas.clear();
    for (let i = 0; i < puntos.length; i += 1) {
      const clave = `${Math.floor(puntos[i].x / CORTE)},${Math.floor(puntos[i].y / CORTE)}`;
      const celda = celdas.get(clave);
      if (celda) celda.push(i); else celdas.set(clave, [i]);
    }

    for (const [clave, aqui] of celdas) {
      const [cx, cy] = clave.split(",").map(Number);
      // Solo la mitad de las vecinas: la otra mitad ya mira hacia aca.
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
        const vecina = dx === 0 && dy === 0 ? aqui : celdas.get(`${cx + dx},${cy + dy}`);
        if (!vecina) continue;
        const misma = vecina === aqui;

        for (let m = 0; m < aqui.length; m += 1) {
          for (let k = misma ? m + 1 : 0; k < vecina.length; k += 1) {
            const i = aqui[m], o = vecina[k];
            let ddx = puntos[o].x - puntos[i].x, ddy = puntos[o].y - puntos[i].y;
            let d2 = ddx * ddx + ddy * ddy;
            if (d2 > CORTE * CORTE) continue;
            if (d2 < 1) { ddx = (i % 7) - 3; ddy = (o % 5) - 2; d2 = 10; }
            const d = Math.sqrt(d2);
            const f = (REPULSION / d2) * alfa;
            puntos[i].vx -= (ddx / d) * f; puntos[i].vy -= (ddy / d) * f;
            puntos[o].vx += (ddx / d) * f; puntos[o].vy += (ddy / d) * f;
          }
        }
      }
    }

    for (const [a, b] of aristas) {
      const dx = puntos[b].x - puntos[a].x, dy = puntos[b].y - puntos[a].y;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - LARGO) * RESORTE * alfa;
      puntos[a].vx += (dx / d) * f; puntos[a].vy += (dy / d) * f;
      puntos[b].vx -= (dx / d) * f; puntos[b].vy -= (dy / d) * f;
    }

    for (const c of centros) { c.x = 0; c.y = 0; c.n = 0; c.fx = 0; c.fy = 0; }
    for (let i = 0; i < puntos.length; i += 1) {
      const c = centros[ramoDe[i]];
      c.x += puntos[i].x; c.y += puntos[i].y; c.n += 1;
    }
    for (const c of centros) if (c.n) { c.x /= c.n; c.y /= c.n; }

    for (let i = 0; i < centros.length; i += 1) {
      for (let k = i + 1; k < centros.length; k += 1) {
        let dx = centros[k].x - centros[i].x, dy = centros[k].y - centros[i].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = (i % 5) - 2; dy = (k % 3) - 1; d2 = 10; }
        const d = Math.sqrt(d2);
        const f = (REPULSION_RAMOS / d2) * alfa;
        centros[i].fx -= (dx / d) * f; centros[i].fy -= (dy / d) * f;
        centros[k].fx += (dx / d) * f; centros[k].fy += (dy / d) * f;
      }
      centros[i].fx += (ANCHO_GRAFO / 2 - centros[i].x) * CENTRO * alfa;
      centros[i].fy += (ALTO_GRAFO / 2 - centros[i].y) * CENTRO * alfa;
    }

    let movimiento = 0;
    for (let i = 0; i < puntos.length; i += 1) {
      const p = puntos[i];
      if (p.fijo) { p.vx = 0; p.vy = 0; continue; }
      const c = centros[ramoDe[i]];
      p.vx += c.fx * 0.02 + (c.x - p.x) * COHESION * alfa;
      p.vy += c.fy * 0.02 + (c.y - p.y) * COHESION * alfa;
      p.x += p.vx; p.y += p.vy;
      p.vx *= 0.84; p.vy *= 0.84;
      movimiento += Math.abs(p.vx) + Math.abs(p.vy);
    }
    alfa *= 0.994;
    return movimiento / puntos.length;
  }

  function paso() {
    if (!mia.viva) return;

    if (alfa > 0.01) {
      const quietud = fisica();
      repintar = true;
      // Se duerme cuando ya casi no se mueve: a partir de ahi no se calcula ni
      // se repinta hasta que alguien toque algo.
      if (quietud < 0.02 && alfa < 0.25) alfa = 0;
    }

    if (repintar) { pintar(); repintar = false; }
    mia.cuadro = requestAnimationFrame(paso);
  }

  /** Vuelve a darle energia: al arrastrar, al fijar o al soltar los fijados. */
  function despertar(energia = 0.3) {
    alfa = Math.max(alfa, energia);
    repintar = true;
  }

  /* ───────── Puntero ───────── */

  function nodoEn(p) {
    let mejor = -1, mejorD = Infinity;
    for (let i = 0; i < puntos.length; i += 1) {
      const d = Math.hypot(puntos[i].x - p.x, puntos[i].y - p.y);
      const alcance = Math.max(radios[i] + 3, 7 / vista.escala);
      if (d < alcance && d < mejorD) { mejor = i; mejorD = d; }
    }
    return mejor;
  }

  let arrastrando = null;   // nodo
  let paneando = null;      // fondo

  lienzo.addEventListener("pointerdown", evento => {
    const p = aMundo(evento.clientX, evento.clientY);
    const i = nodoEn(p);
    lienzo.setPointerCapture(evento.pointerId);
    evento.preventDefault();

    if (i >= 0) {
      arrastrando = { i, movido: false, desde: p, estabaFijo: puntos[i].fijo };
      puntos[i].fijo = true;
    } else {
      paneando = { x: evento.clientX, y: evento.clientY, dx: vista.dx, dy: vista.dy };
      lienzo.style.cursor = "grabbing";
    }
  });

  lienzo.addEventListener("pointermove", evento => {
    if (arrastrando) {
      const p = aMundo(evento.clientX, evento.clientY);
      if (Math.hypot(p.x - arrastrando.desde.x, p.y - arrastrando.desde.y) > 4 / vista.escala) {
        arrastrando.movido = true;
      }
      puntos[arrastrando.i].x = p.x;
      puntos[arrastrando.i].y = p.y;
      despertar(0.25);
      globo.hidden = true;
      return;
    }

    if (paneando) {
      // Mover el fondo es cosa de la vista; en cuanto lo tocas, el encuadre
      // automatico se aparta y no vuelve a pelearte la camara.
      const caja = lienzo.getBoundingClientRect();
      const factor = ANCHO_GRAFO / caja.width;
      vista.manual = true;
      vista.dx = paneando.dx + (evento.clientX - paneando.x) * factor;
      vista.dy = paneando.dy + (evento.clientY - paneando.y) * factor;
      repintar = true;
      return;
    }

    const p = aMundo(evento.clientX, evento.clientY);
    const i = nodoEn(p);
    lienzo.style.cursor = i < 0 ? "grab" : "pointer";
    if (i < 0) { globo.hidden = true; return; }

    const n = nodos[i];
    globo.innerHTML = "";
    const t = document.createElement("strong");
    t.textContent = n.titulo;
    const sub = document.createElement("span");
    sub.textContent = `${n.curso} · ${n.tipo} · ${n.grado} enlaces${puntos[i].fijo ? " · fijado" : ""}`;
    globo.append(t, sub);
    globo.style.left = `${evento.clientX + 14}px`;
    globo.style.top = `${evento.clientY + 14}px`;
    globo.hidden = false;
  });

  lienzo.addEventListener("pointerleave", () => { globo.hidden = true; });

  lienzo.addEventListener("pointerup", evento => {
    lienzo.releasePointerCapture(evento.pointerId);

    if (paneando) { paneando = null; lienzo.style.cursor = "grab"; return; }
    if (!arrastrando) return;

    const { i, movido, estabaFijo } = arrastrando;
    arrastrando = null;

    if (movido) {
      // Arrastrar deja el nodo clavado donde lo soltaste. Es lo que se espera
      // al mover algo a proposito, y permite ordenar el grafo a mano.
      puntos[i].fijo = true;
      despertar(0.25);
      actualizarFijados();
      return;
    }

    // Sin movimiento es un clic: si ya estaba fijado, lo suelta; si no, abre.
    if (estabaFijo) {
      puntos[i].fijo = false;
      despertar();
      actualizarFijados();
    } else {
      // El pointerdown lo habia fijado para poder arrastrarlo; si no se movio,
      // se suelta. Hay que refrescar el contador o queda diciendo que hay uno
      // fijado cuando ya no lo esta.
      puntos[i].fijo = false;
      actualizarFijados();
      abrirNota(nodos[i]);
    }
  });

  /* ───────── Zoom ───────── */

  lienzo.addEventListener("wheel", evento => {
    evento.preventDefault();
    const caja = lienzo.getBoundingClientRect();
    const sx = ((evento.clientX - caja.left) / caja.width) * ANCHO_GRAFO;
    const sy = ((evento.clientY - caja.top) / caja.height) * ALTO_GRAFO;

    const factor = Math.exp(-evento.deltaY * 0.0014);
    const nueva = Math.max(0.15, Math.min(8, vista.escala * factor));

    // El zoom se ancla al cursor: el punto que esta bajo el raton se queda
    // donde esta. Sin esto, acercarse arrastra el grafo hacia una esquina.
    vista.dx = sx - ((sx - vista.dx) / vista.escala) * nueva;
    vista.dy = sy - ((sy - vista.dy) / vista.escala) * nueva;
    vista.escala = nueva;
    vista.manual = true;
    repintar = true;
  }, { passive: false });

  /* ───────── Controles ───────── */

  function actualizarFijados() {
    const n = puntos.filter(p => p.fijo).length;
    $("#soltar-fijados").hidden = n === 0;
    $("#soltar-fijados").textContent = n === 1 ? "Soltar 1 fijado" : `Soltar ${n} fijados`;
  }

  simulacion = mia;
  mia.soltarFijados = () => {
    for (const p of puntos) p.fijo = false;
    despertar(0.5);
    actualizarFijados();
  };
  mia.reencuadrar = () => {
    vista.manual = false;
    repintar = true;
  };
  actualizarFijados();
  mia.cuadro = requestAnimationFrame(paso);

  $("#leyenda-grafo").replaceChildren(
    ...Object.entries(COLOR_TIPO)
      .filter(([tipo]) => nodos.some(n => n.tipo === tipo))
      .map(([tipo, color]) => {
        const s = document.createElement("span");
        const i = document.createElement("i");
        i.style.background = color;
        s.append(i, document.createTextNode(NOMBRE_TIPO[tipo] || tipo));
        return s;
      }),
  );
}

/** Abre la nota de un nodo en el cajon lateral. */
async function abrirNota(nodo) {
  const cajon = $("#cajon");
  $("#cajon-titulo").textContent = nodo.titulo;
  $("#cajon-tipo").textContent = nodo.curso ? `${nodo.tipo} · ${nodo.curso}` : nodo.tipo;
  $("#cajon-cuerpo").textContent = "Leyendo...";
  $("#cajon-abrir").hidden = true;
  cajon.hidden = false;

  // El cajon se abre al pulsar un punto del grafo, lejos de aqui en la pagina.
  // Sin mover el foco, con teclado o lector de pantalla no hay forma de saber
  // que aparecio algo ni de llegar a leerlo.
  cajon.focus();

  try {
    // El nodo trae su propio ramo: en el grafo global conviven veinte.
    const curso = nodo.course_id ?? estado.ramoAbierto;
    const ruta = nodo.nodo ?? nodo.id;
    const n = await pedir(`/api/nota?course_id=${curso}&nodo=${encodeURIComponent(ruta)}`);
    $("#cajon-cuerpo").textContent = n.cuerpo.trim() || "Esta nota no tiene cuerpo.";

    // Si es un adjunto descargado, ademas del texto se puede abrir el archivo.
    if (n.tipo === "archivo" && n.descargado) {
      const abrir = $("#cajon-abrir");
      abrir.href = `/api/archivo?course_id=${curso}&file_id=${n.id}`;
      abrir.hidden = false;
    }
  } catch (error) {
    $("#cajon-cuerpo").textContent = `No se pudo leer: ${error.message}`;
  }
}

async function verGrafo() {
  const boton = $("#ver-grafo");
  boton.disabled = true;
  boton.textContent = "Dibujando...";
  ocultar($("#aviso-grafo"));
  $("#cajon").hidden = true;
  $("#resumen-grafo").textContent = "Leyendo el vault...";

  try {
    const g = await pedir("/api/grafo");
    dibujarGrafo(g);
    $("#resumen-grafo").textContent =
      `${g.nodos.length} notas de ${g.cursos.length} ramos, ${g.aristas.length} enlaces`;

    if (!g.nodos.length) {
      nota($("#aviso-grafo"), "Tu vault esta vacio.", " Sincroniza tus ramos desde Material.");
    }
  } catch (error) {
    $("#resumen-grafo").textContent = "";
    avisoDeError($("#aviso-grafo"), "No se pudo dibujar el grafo", error);
  } finally {
    boton.disabled = false;
    boton.textContent = "Dibujar todo";
  }
}

/* ───────── Guias de estudio ───────── */

/** El enlace a un archivo de una guia, o un aviso de que no esta. */
function enlaceDeGuia(guia, formato, texto) {
  if (formato !== "md" && !guia[formato]) {
    const falta = document.createElement("span");
    falta.className = "marca-chica falta";
    falta.textContent = `sin ${formato}`;
    falta.title = formato === "pdf"
      ? "LaTeX no estaba disponible cuando se armo. La guia existe igual."
      : "Esta guia se armo antes de que se guardara el .tex.";
    return falta;
  }

  const enlace = document.createElement("a");
  enlace.className = "abrir";
  enlace.href = `/api/guia/archivo?course_id=${guia.course_id}` +
    `&base=${encodeURIComponent(guia.base)}&formato=${formato}`;
  enlace.target = "_blank";
  enlace.rel = "noopener";
  enlace.textContent = texto;
  return enlace;
}

function filaDeGuia(guia) {
  const fila = document.createElement("div");
  fila.className = "nota-item";

  const nombre = document.createElement("span");
  nombre.className = "nombre";
  nombre.textContent = guia.titulo;
  nombre.title = guia.titulo;

  const detalle = document.createElement("span");
  detalle.className = "id";
  detalle.textContent = [
    guia.tema,
    guia.citas.length ? `${guia.citas.length} citas` : null,
    new Date(guia.modificado).toLocaleDateString("es-CL"),
  ].filter(Boolean).join(" · ");

  fila.append(nombre, detalle);
  fila.append(enlaceDeGuia(guia, "pdf", "PDF"));
  fila.append(enlaceDeGuia(guia, "tex", ".tex"));
  fila.append(enlaceDeGuia(guia, "md", "nota"));
  return fila;
}

async function cargarGuias() {
  const listado = $("#listado-guias");
  listado.textContent = "Leyendo el vault...";

  try {
    const { guias } = await pedir("/api/guias");
    if (!guias.length) {
      listado.replaceChildren();
      const vacio = document.createElement("p");
      vacio.className = "vacio";
      vacio.textContent = "Todavia no armas ninguna. Elige un ramo y un tema aca arriba.";
      listado.append(vacio);
      return;
    }
    listado.replaceChildren(...guias.map(filaDeGuia));
  } catch (error) {
    listado.replaceChildren();
    avisoDeError($("#aviso-guia"), "No se pudo leer tus guias", error);
  }
}

/** Lo que quedo fuera, agrupado por motivo: una lista de cuarenta no la lee nadie. */
function pintarExcluidas(excluidas) {
  const caja = $("#excluidas-guia");
  const porMotivo = new Map();
  for (const item of excluidas || []) {
    const motivo = (item.motivo || "sin motivo").trim();
    porMotivo.set(motivo, (porMotivo.get(motivo) || 0) + 1);
  }

  if (!porMotivo.size) {
    caja.hidden = true;
    return;
  }

  caja.replaceChildren();
  const rotulo = document.createElement("span");
  rotulo.className = "rotulo";
  rotulo.textContent = "Quedo fuera:";
  caja.append(rotulo);

  for (const [motivo, cuantas] of porMotivo) {
    const etiqueta = document.createElement("span");
    etiqueta.className = "cita";
    etiqueta.textContent = `${cuantas} ${cuantas === 1 ? "fuente" : "fuentes"} ${motivo}`;
    caja.append(etiqueta);
  }
  caja.hidden = false;
}

async function armarGuia() {
  const courseId = Number.parseInt($("#guia-ramo").value, 10);
  const tema = $("#guia-tema").value.trim();

  if (!Number.isInteger(courseId)) {
    nota($("#aviso-guia"), "Elige un ramo", " Primero sincroniza tus ramos en la pestana Material.", "mala");
    return;
  }
  if (!tema) {
    nota($("#aviso-guia"), "Falta el tema", " Es lo que decide que material entra en la guia.", "mala");
    $("#guia-tema").focus();
    return;
  }

  const boton = $("#armar-guia");
  boton.disabled = true;
  boton.textContent = "Armando...";
  ocultar($("#excluidas-guia"));
  nota($("#aviso-guia"), "Armando la guia.", " Buscando material...");

  try {
    const { trabajo } = await enviar("/api/guia", {
      course_id: courseId,
      tema,
      titulo: $("#guia-titulo").value.trim() || undefined,
      fecha_prueba: $("#guia-fecha").value || undefined,
      hora: $("#guia-hora").value.trim() || undefined,
      sala: $("#guia-sala").value.trim() || undefined,
      sin_modelo: $("#guia-sin-modelo").checked,
    });

    // El mismo bucle que la sincronizacion, y por el mismo motivo: seis
    // llamadas al modelo mas LaTeX son minutos, y ninguna peticion puede durar
    // eso.
    let estadoTrabajo;
    for (;;) {
      await espera(3000);
      estadoTrabajo = await pedir(`/api/trabajo?id=${encodeURIComponent(trabajo)}`);
      if (estadoTrabajo.estado !== "corriendo") break;
      nota($("#aviso-guia"), "Armando la guia.", ` ${textoDeAvance(estadoTrabajo.avance)}`);
    }

    if (estadoTrabajo.estado === "fallido") {
      nota($("#aviso-guia"), "No se pudo armar la guia", ` ${estadoTrabajo.error}`, "mala");
      return;
    }

    const r = estadoTrabajo.resultado || {};
    const extractos = (r.secciones || []).filter(s => s.origen === "extracto").length;

    const detalle = [
      `${(r.secciones || []).length} secciones`,
      `${(r.citas || []).length} citas`,
      extractos ? `${extractos} como extracto literal` : null,
    ].filter(Boolean).join(", ");

    const aviso = $("#aviso-guia");
    if (r.latex?.ok) {
      nota(aviso, "Listo.", ` ${detalle}. `, "buena");
      aviso.append(enlaceDeGuia({ ...r, pdf: true }, "pdf", "abrir el PDF"));
    } else {
      // La guia SI se armo: lo que falto es el PDF. Eso no es un error rojo.
      nota(
        aviso,
        "La guia quedo en Markdown y en .tex.",
        ` ${detalle}. El PDF no se compilo: ${r.latex?.mensaje || "motivo desconocido"}.`,
      );
    }

    for (const texto of r.avisos || []) {
      aviso.append(document.createElement("br"), document.createTextNode(texto));
    }
    pintarExcluidas(r.excluidas);
    await cargarGuias();
  } catch (error) {
    avisoDeError($("#aviso-guia"), "No se pudo armar la guia", error);
  } finally {
    boton.disabled = false;
    boton.textContent = "Armar la guia";
  }
}

/* ───────── Chat con el modelo local ───────── */

function turno(quien, texto, { clase = "", citas = [] } = {}) {
  const bloque = document.createElement("article");
  bloque.className = `turno ${clase}`.trim();

  const titulo = document.createElement("p");
  titulo.className = "quien";
  titulo.textContent = quien;

  const cuerpo = document.createElement("p");
  cuerpo.className = "texto";
  cuerpo.textContent = texto;

  bloque.append(titulo, cuerpo);

  // Las citas se muestran siempre que las haya: es la forma de comprobar que la
  // respuesta salio del material y no de la memoria del modelo.
  if (citas.length) {
    const pie = document.createElement("div");
    pie.className = "citas";
    const rotulo = document.createElement("span");
    rotulo.className = "rotulo";
    rotulo.textContent = "De tu material:";
    pie.append(rotulo);
    for (const c of citas.slice(0, 8)) {
      const etiqueta = document.createElement("span");
      etiqueta.className = "cita";
      etiqueta.textContent = c.cita;
      etiqueta.title = c.titulo || "";
      pie.append(etiqueta);
    }
    bloque.append(pie);
  }

  $("#conversacion").append(bloque);
  bloque.scrollIntoView({ block: "end", behavior: "smooth" });
  return bloque;
}

async function comprobarModelo() {
  const insignias = ["#estado-modelo", "#estado-modelo-guias"].map($);

  const pintar = (listo, texto) => {
    for (const insignia of insignias) {
      insignia.className = `insignia ${listo ? "viva" : "muerta"}`;
      insignia.textContent = texto;
    }
  };

  try {
    const estadoModelo = await pedir("/api/modelo");
    const listo = estadoModelo.vivo && estadoModelo.disponible;
    pintar(listo, listo ? estadoModelo.modelo : "modelo no disponible");
    $("#nombre-modelo").textContent = listo
      ? `${estadoModelo.modelo}, corriendo en tu maquina`
      : estadoModelo.mensaje || "";

    // Sin modelo la guia se puede armar igual, con extractos literales. Decirlo
    // aca evita que alguien pulse el boton y espere a que falle.
    $("#aviso-modelo-guias").textContent = listo
      ? ""
      : `${estadoModelo.mensaje || "Ollama no responde"}. Puedes armarla igual marcando «solo extractos literales».`;
  } catch {
    pintar(false, "modelo no disponible");
    $("#aviso-modelo-guias").textContent =
      "Ollama no responde. Puedes armar la guia igual marcando «solo extractos literales».";
  }
}

/** Los selectores de ramo se llenan con lo que hay en el vault. */
function llenarRamosDelChat(cursos) {
  const conId = cursos.filter(c => c.course_id);
  for (const selector of ["#chat-ramo", "#archivos-ramo", "#guia-ramo"]) {
    const select = $(selector);
    const previo = select.value;
    select.replaceChildren(...conId.map(c => new Option(c.titulo || c.carpeta, c.course_id)));
    if (previo && conId.some(c => String(c.course_id) === previo)) select.value = previo;
  }
  $("#preguntar").disabled = conId.length === 0;
  $("#armar-guia").disabled = conId.length === 0;
}

async function preguntar() {
  const campo = $("#chat-pregunta");
  const pregunta = campo.value.trim();
  const courseId = Number.parseInt($("#chat-ramo").value, 10);

  if (!pregunta) return;
  if (!Number.isInteger(courseId)) {
    nota($("#aviso-chat"), "Elige un ramo", " Primero sincroniza tus ramos en la pestana Material.", "mala");
    return;
  }

  const boton = $("#preguntar");
  boton.disabled = true;
  ocultar($("#aviso-chat"));

  turno("Tu", pregunta, { clase: "mio" });
  estado.chat.push({ role: "user", content: pregunta });
  campo.value = "";

  const esperando = turno("Ayudante", "Buscando en tu material...", { clase: "pensando" });

  try {
    const r = await enviar("/api/chat", {
      course_id: courseId,
      pregunta,
      historial: estado.chat.slice(0, -1),
    });

    esperando.remove();
    turno("Ayudante", r.respuesta, { citas: r.citas || [] });
    estado.chat.push({ role: "assistant", content: r.respuesta });

    // Si quedo material sin leer por falta de extractor, conviene saberlo: la
    // respuesta pudo salir incompleta por eso y no por el modelo.
    const sinTexto = (r.excluidas || []).filter(e => /sin texto/i.test(e.motivo || "")).length;
    if (sinTexto) {
      nota(
        $("#aviso-chat"),
        `${sinTexto} ${sinTexto === 1 ? "archivo quedo" : "archivos quedaron"} fuera por no tener texto extraido.`,
        " Son imagenes o PDF escaneados: el ayudante no pudo leerlos.",
      );
    }
  } catch (error) {
    esperando.remove();
    avisoDeError($("#aviso-chat"), "No se pudo responder", error);
  } finally {
    boton.disabled = false;
    campo.focus();
  }
}

/* ───────── Usuarios (administradores) ───────── */

function filaDeUsuario(usuario) {
  const fila = document.createElement("tr");

  const quien = document.createElement("td");
  const nombre = document.createElement("strong");
  nombre.textContent = usuario.nombre;
  const correo = document.createElement("div");
  correo.className = "mono";
  correo.textContent = usuario.correo;
  quien.append(nombre, correo);

  const rol = document.createElement("td");
  rol.textContent = usuario.rol;

  const vault = document.createElement("td");
  vault.className = "mono";
  vault.textContent = usuario.vault || "—";

  const cookie = document.createElement("td");
  if (usuario.cookie.existe) {
    cookie.textContent = `guardada ${new Date(usuario.cookie.modificado).toLocaleDateString("es-CL")}`;
  } else {
    cookie.innerHTML = '<span class="vacio">sin cookie</span>';
  }

  const acciones = document.createElement("td");
  if (usuario.id !== estado.yo?.id) {
    const borrar = document.createElement("button");
    borrar.className = "boton peligro";
    borrar.type = "button";
    borrar.textContent = "Quitar";
    borrar.addEventListener("click", () => quitarUsuario(usuario));
    acciones.append(borrar);
  }

  fila.append(quien, rol, vault, cookie, acciones);
  return fila;
}

async function cargarUsuarios() {
  if (estado.yo?.rol !== "admin") return;
  const { usuarios } = await pedir("/api/usuarios");
  $("#tabla-usuarios").replaceChildren(...usuarios.map(filaDeUsuario));
}

async function quitarUsuario(usuario) {
  // Quita la entrada de la configuracion; el vault y la cookie quedan en disco.
  // Por eso no se pide una confirmacion dramatica: no se pierde material.
  try {
    const resultado = await enviar("/api/usuarios/eliminar", { usuario: usuario.id });
    await cargarUsuarios();
    nota(
      $("#aviso-usuario"),
      `Se quito "${usuario.id}".`,
      ` Su vault sigue en disco: ${resultado.vault_conservado}`,
      "buena",
    );
  } catch (error) {
    avisoDeError($("#aviso-usuario"), "No se pudo quitar", error);
  }
}

async function crearUsuario() {
  const boton = $("#crear-usuario");
  boton.disabled = true;
  try {
    const { creado } = await enviar("/api/usuarios", {
      nombre: $("#nuevo-nombre").value,
      correo: $("#nuevo-correo").value,
      contrasena: $("#nueva-clave").value,
      rol: $("#nuevo-rol").value,
    });
    for (const campo of ["#nuevo-nombre", "#nuevo-correo", "#nueva-clave"]) {
      $(campo).value = "";
    }
    await cargarUsuarios();
    nota(
      $("#aviso-usuario"),
      `Usuario "${creado.id}" creado.`,
      ` Su vault es ${creado.vault}. Tiene que entrar con su correo y pegar su propia cookie de Canvas.`,
      "buena",
    );
  } catch (error) {
    avisoDeError($("#aviso-usuario"), "No se pudo crear", error);
  } finally {
    boton.disabled = false;
  }
}

/* ───────── Encuesta ───────── */

/** Dibuja una pregunta segun su tipo, con lo ya respondido si lo hay. */
function campoDePregunta(pregunta, respuesta) {
  const caja = document.createElement("div");
  caja.className = "pregunta";

  const enunciado = document.createElement("span");
  enunciado.className = "enunciado";
  enunciado.textContent = pregunta.obligatoria ? `${pregunta.texto} *` : pregunta.texto;
  caja.append(enunciado);

  if (pregunta.ayuda) {
    const ayuda = document.createElement("p");
    ayuda.className = "ayuda-p";
    ayuda.textContent = pregunta.ayuda;
    caja.append(ayuda);
  }

  // Escala y opcion se dibujan igual —una fila de radios—; lo unico que cambia
  // es de donde salen los valores y que se compara para marcar el elegido.
  if (pregunta.tipo === "escala" || pregunta.tipo === "opcion") {
    const valores =
      pregunta.tipo === "escala"
        ? Array.from({ length: pregunta.max - pregunta.min + 1 }, (_, i) => String(pregunta.min + i))
        : pregunta.opciones;

    const escala = document.createElement("div");
    escala.className = "escala";
    for (const valor of valores) {
      const etiqueta = document.createElement("label");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = `p-${pregunta.id}`;
      radio.value = valor;
      radio.checked = respuesta !== undefined && respuesta !== null && String(respuesta) === valor;
      const texto = document.createElement("span");
      texto.textContent = valor;
      etiqueta.append(radio, texto);
      escala.append(etiqueta);
    }
    caja.append(escala);
    return caja;
  }

  const area = document.createElement("textarea");
  area.name = `p-${pregunta.id}`;
  area.value = respuesta || "";
  area.maxLength = 2000;
  caja.append(area);
  return caja;
}

async function cargarEncuesta() {
  const destino = $("#encuesta-preguntas");
  destino.textContent = "Cargando...";
  try {
    const { preguntas, mia } = await pedir("/api/encuesta");
    estado.encuesta = preguntas;
    destino.textContent = "";
    for (const pregunta of preguntas) {
      destino.append(campoDePregunta(pregunta, mia?.respuestas?.[pregunta.id]));
    }
    $("#encuesta-cuando").textContent = mia
      ? `Respondida el ${new Date(mia.respondida).toLocaleDateString("es-CL")}. Si la vuelves a guardar, se reemplaza.`
      : "Todavia no la has respondido.";
  } catch (error) {
    if (error.manejado) return;
    destino.textContent = "";
    avisoDeError($("#aviso-encuesta"), "No se pudo cargar la encuesta", error);
  }
}

async function enviarEncuesta() {
  const boton = $("#enviar-encuesta");
  boton.disabled = true;
  try {
    const respuestas = {};
    for (const pregunta of estado.encuesta || []) {
      const campo =
        document.querySelector(`[name="p-${pregunta.id}"]:checked`) ||
        document.querySelector(`textarea[name="p-${pregunta.id}"]`);
      if (campo && campo.value !== "") respuestas[pregunta.id] = campo.value;
    }
    await enviar("/api/encuesta", { respuestas });
    await cargarEncuesta();
    nota($("#aviso-encuesta"), "Gracias.", " Queda guardada; puedes cambiarla cuando quieras.", "buena");
  } catch (error) {
    if (!error.manejado) avisoDeError($("#aviso-encuesta"), "No se pudo guardar", error);
  } finally {
    boton.disabled = false;
  }
}

/* ───────── Adopcion (administradores) ───────── */

function tarjetaDeMetrica(cifra, rotulo, detalle) {
  const caja = document.createElement("div");
  caja.className = "metrica";
  const n = document.createElement("div");
  n.className = "cifra";
  n.textContent = cifra;
  const r = document.createElement("div");
  r.className = "rotulo";
  r.textContent = rotulo;
  caja.append(n, r);
  if (detalle) {
    const d = document.createElement("div");
    d.className = "detalle";
    d.textContent = detalle;
    caja.append(d);
  }
  return caja;
}

/** Si o no, con la palabra escrita: el color solo no sirve para quien no lo ve. */
function pastilla(bueno) {
  const span = document.createElement("span");
  span.className = `pill ${bueno ? "si" : "no"}`;
  span.textContent = bueno ? "si" : "no";
  return span;
}

function filaDeAdopcion(fila) {
  const tr = document.createElement("tr");

  const quien = document.createElement("td");
  const nombre = document.createElement("strong");
  nombre.textContent = fila.nombre;
  const correo = document.createElement("div");
  correo.className = "nota-inline";
  correo.textContent = fila.correo;
  quien.append(nombre, correo);

  const termino = document.createElement("td");
  termino.append(pastilla(fila.termino));

  // Los tres pasos, abreviados. El title dice cual es cual sin gastar ancho.
  const pasos = document.createElement("td");
  const caja = document.createElement("div");
  caja.className = "pasos";
  for (const [clave, letra, largo] of [
    ["cookie", "C", "Cookie de Canvas pegada"],
    ["sincronizacion", "S", "Sincronizo un ramo"],
    ["guia", "G", "Genero una guia"],
  ]) {
    const span = document.createElement("span");
    span.textContent = letra;
    span.title = `${largo}: ${fila.pasos[clave] ? "si" : "no"}`;
    if (fila.pasos[clave]) span.classList.add("hecho");
    caja.append(span);
  }
  pasos.append(caja);

  const uso = document.createElement("td");
  uso.textContent = `${fila.uso.guias} guias · ${fila.uso.sincronizaciones} sinc · ${fila.uso.mensajes_chat} chat`;

  const dias = document.createElement("td");
  dias.append(document.createTextNode(String(fila.actividad.dias_activos)));
  if (fila.actividad.vuelve) {
    const vuelve = document.createElement("span");
    vuelve.className = "pill si";
    vuelve.style.marginLeft = "6px";
    vuelve.textContent = "vuelve";
    dias.append(vuelve);
  }

  const ultima = document.createElement("td");
  if (fila.actividad.ultima === null) {
    ultima.textContent = "nunca";
  } else {
    const d = fila.actividad.dias_desde_ultima;
    ultima.textContent = d === 0 ? "hoy" : d === 1 ? "ayer" : `hace ${d} dias`;
    ultima.title = new Date(fila.actividad.ultima).toLocaleString("es-CL");
  }

  const encuesta = document.createElement("td");
  encuesta.append(pastilla(fila.encuesta.respondida));

  tr.append(quien, termino, pasos, uso, dias, ultima, encuesta);
  return tr;
}

async function cargarAdopcion() {
  const cuerpo = $("#tabla-adopcion");
  cuerpo.textContent = "";
  try {
    const datos = await pedir("/api/metricas");
    const t = datos.totales;

    const totales = $("#adopcion-totales");
    totales.textContent = "";
    totales.append(
      tarjetaDeMetrica(`${t.terminaron}/${datos.usuarios}`, "Terminaron el recorrido", `${t.terminaron_pct} %`),
      tarjetaDeMetrica(`${t.vuelven}/${datos.usuarios}`, "Volvieron otro dia", `${t.vuelven_pct} %`),
      tarjetaDeMetrica(String(t.activos_ultimos_7_dias), "Activos los ultimos 7 dias", `${t.activos_pct} %`),
      tarjetaDeMetrica(
        `${t.respondieron_encuesta}/${datos.usuarios}`,
        "Respondieron la encuesta",
        t.promedio_sirvio === null
          ? `${t.respondieron_pct} %`
          : `${t.respondieron_pct} % · sirvio ${t.promedio_sirvio}/5`,
      ),
    );

    for (const fila of datos.filas) cuerpo.append(filaDeAdopcion(fila));

    // Las respuestas escritas, que es donde esta lo que no cabe en un numero.
    const respuestas = $("#adopcion-respuestas");
    respuestas.textContent = "";
    const conEncuesta = datos.filas.filter(f => f.encuesta.respondida);
    if (conEncuesta.length === 0) {
      const vacio = document.createElement("p");
      vacio.className = "nota-inline";
      vacio.textContent = "Nadie ha respondido todavia.";
      respuestas.append(vacio);
      return;
    }
    // Los enunciados salen de /api/encuesta, que puede no haberse pedido nunca:
    // a este panel se puede entrar directo, sin pasar por la pantalla de la
    // encuesta. Sin esto, la lista muestra las claves crudas ("guia_fiel").
    if (!estado.encuesta) {
      estado.encuesta = (await pedir("/api/encuesta").catch(() => null))?.preguntas || [];
    }
    const rotulos = Object.fromEntries(estado.encuesta.map(p => [p.id, p.texto]));
    for (const fila of conEncuesta) {
      const bloque = document.createElement("div");
      bloque.className = "pregunta";
      const quien = document.createElement("span");
      quien.className = "enunciado";
      quien.textContent = fila.nombre;
      bloque.append(quien);
      for (const [clave, valor] of Object.entries(fila.encuesta.respuestas)) {
        const linea = document.createElement("div");
        linea.className = "nota-inline";
        linea.textContent = `${rotulos[clave] || clave}: ${valor}`;
        bloque.append(linea);
      }
      respuestas.append(bloque);
    }
  } catch (error) {
    if (error.manejado) return;
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 7;
    td.textContent = `No se pudo cargar: ${error.message}`;
    tr.append(td);
    cuerpo.append(tr);
  }
}

/* ───────── Tareas pendientes y entrega ───────── */

/*
 * La entrega es lo unico irreversible de la plataforma, y el riesgo de verdad no
 * es tecnico: es que alguien revise la tarea 3, cambie el selector a la tarea 4
 * y confirme creyendo que confirma lo que vio.
 *
 * Por eso lo revisado se guarda entero y se compara antes de confirmar. Cualquier
 * cambio en la tarea, el archivo o el comentario invalida la confirmacion y
 * obliga a revisar de nuevo. Es la clase de error que no se puede reparar
 * despues, asi que se previene antes.
 */
let entregaRevisada = null;

function peticionDeEntrega() {
  const opcion = $("#entrega-tarea").selectedOptions[0];
  if (!opcion?.value) return null;
  const [course_id, assignment_id] = opcion.value.split(":").map(Number);
  const archivo = $("#listado-subidos").querySelector("input[name=archivo]:checked")?.value || "";
  return {
    course_id,
    assignment_id,
    archivo,
    comentario: $("#entrega-comentario").value.trim(),
    tarea: opcion.textContent,
  };
}

function olvidarRevision() {
  entregaRevisada = null;
  ocultar($("#plan-entrega"));
  $("#fila-confirmar").hidden = true;
}

const mismaEntrega = (a, b) =>
  a && b &&
  a.course_id === b.course_id &&
  a.assignment_id === b.assignment_id &&
  a.archivo === b.archivo &&
  a.comentario === b.comentario;

function filaDePendiente(tarea) {
  const bloque = document.createElement("article");
  bloque.className = "card";

  const titulo = document.createElement("h3");
  titulo.textContent = tarea.titulo || tarea.nombre || `Tarea ${tarea.assignment_id}`;
  bloque.append(titulo);

  const detalle = document.createElement("p");
  detalle.className = "ayuda";
  const partes = [];
  if (tarea.ramo || tarea.curso) partes.push(tarea.ramo || tarea.curso);
  if (tarea.vence || tarea.due_at) partes.push(`vence ${tarea.vence || tarea.due_at}`);
  if (tarea.entregado === true) partes.push("ya entregada");
  if (tarea.puntos != null) partes.push(`${tarea.puntos} puntos`);
  detalle.textContent = partes.join(" · ") || "sin fecha declarada";
  bloque.append(detalle);

  return bloque;
}

/** Las tareas del MCP vienen con nombres distintos segun la version; se acepta cualquiera. */
const listaDeTareas = datos =>
  datos.tareas || datos.pendientes || datos.assignments || datos.items || [];

async function verPendientes() {
  const listado = $("#listado-pendientes");
  const estadoTexto = $("#estado-pendientes");
  ocultar($("#aviso-tareas"));
  listado.textContent = "Preguntandole a Canvas...";
  estadoTexto.textContent = "";

  try {
    const datos = await pedir("/api/pendientes");
    const tareas = listaDeTareas(datos);

    pintarSubidos(datos.subidos || []);

    if (!tareas.length) {
      listado.replaceChildren();
      const vacio = document.createElement("p");
      vacio.className = "vacio";
      vacio.textContent = "Canvas no reporta tareas pendientes.";
      listado.append(vacio);
      $("#card-entrega").hidden = true;
      return;
    }

    listado.replaceChildren(...tareas.map(filaDePendiente));
    estadoTexto.textContent = `${tareas.length} pendiente${tareas.length === 1 ? "" : "s"}`;

    const selector = $("#entrega-tarea");
    selector.replaceChildren();
    for (const tarea of tareas) {
      const id = tarea.assignment_id ?? tarea.id;
      const ramo = tarea.course_id ?? tarea.curso_id;
      if (!id || !ramo) continue;
      const opcion = document.createElement("option");
      opcion.value = `${ramo}:${id}`;
      opcion.textContent = tarea.titulo || tarea.nombre || `Tarea ${id}`;
      selector.append(opcion);
    }
    $("#card-entrega").hidden = selector.options.length === 0;
    olvidarRevision();
  } catch (error) {
    listado.replaceChildren();
    $("#card-entrega").hidden = true;
    // La cookie vencida es el caso comun y tiene remedio propio: decirlo asi
    // evita que alguien crea que no tiene tareas cuando lo que falta es entrar.
    if (error.estado === 401) {
      nota(
        $("#aviso-tareas"),
        "Tu sesion de Canvas vencio.",
        " Renuevala en «Cookie de Canvas» y vuelve a preguntar. Esto se lee de Canvas, no del vault.",
        "mala",
      );
      return;
    }
    avisoDeError($("#aviso-tareas"), "No se pudo leer tus pendientes", error);
  }
}

function pintarSubidos(subidos) {
  const caja = $("#listado-subidos");
  caja.replaceChildren();

  if (!subidos.length) {
    const vacio = document.createElement("p");
    vacio.className = "ayuda";
    vacio.textContent = "Todavia no subiste ningun archivo.";
    caja.append(vacio);
    return;
  }

  for (const [indice, archivo] of subidos.entries()) {
    /*
     * El boton va FUERA de la etiqueta, no dentro.
     *
     * Un boton anidado en un <label> hereda su comportamiento: pulsar "Quitar"
     * marcaba tambien el radio, y un lector de pantalla lee el texto del boton
     * como parte del nombre de la casilla.
     */
    const grupo = document.createElement("div");
    grupo.className = "fila";

    const etiqueta = document.createElement("label");
    etiqueta.className = "campo-inline";

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "archivo";
    radio.value = archivo.archivo;
    if (indice === 0) radio.checked = true;
    radio.addEventListener("change", olvidarRevision);

    const texto = document.createElement("span");
    texto.textContent = `${archivo.archivo} (${Math.round(archivo.bytes / 1024)} KB)`;

    const quitar = document.createElement("button");
    quitar.type = "button";
    quitar.className = "boton suave";
    quitar.textContent = "Quitar";
    // Sin esto, con lector de pantalla los botones de la lista suenan todos
    // igual: "Quitar", "Quitar", "Quitar".
    quitar.setAttribute("aria-label", `Quitar ${archivo.archivo}`);
    quitar.addEventListener("click", async () => {
      try {
        await enviar("/api/entrega/olvidar", { archivo: archivo.archivo });
        const { subidos: quedan } = await pedir("/api/entrega/archivos");
        pintarSubidos(quedan);
        olvidarRevision();
      } catch (error) {
        avisoDeError($("#aviso-tareas"), "No se pudo quitar el archivo", error);
      }
    });

    etiqueta.append(radio, texto);
    grupo.append(etiqueta, quitar);
    caja.append(grupo);
  }
}

/** El archivo va en base64 dentro del JSON: ver el por que en entregas.mjs. */
const comoBase64 = archivo => new Promise((listo, falla) => {
  const lector = new FileReader();
  lector.onload = () => listo(String(lector.result).split(",")[1] || "");
  lector.onerror = () => falla(new Error("No se pudo leer el archivo."));
  lector.readAsDataURL(archivo);
});

async function subirArchivo() {
  const entrada = $("#entrega-archivo");
  const archivo = entrada.files?.[0];
  const boton = $("#subir-archivo");

  if (!archivo) {
    nota($("#aviso-tareas"), "Elige un archivo primero.", "", "mala");
    return;
  }

  boton.disabled = true;
  ocultar($("#aviso-tareas"));
  try {
    const contenido_base64 = await comoBase64(archivo);
    await enviar("/api/entrega/archivo", { nombre: archivo.name, contenido_base64 });
    const { subidos } = await pedir("/api/entrega/archivos");
    pintarSubidos(subidos);
    olvidarRevision();
    entrada.value = "";
    nota($("#aviso-tareas"), "Archivo subido.", " Todavia no se entrego nada: revisa y confirma abajo.");
  } catch (error) {
    avisoDeError($("#aviso-tareas"), "No se pudo subir el archivo", error);
  } finally {
    boton.disabled = false;
  }
}

/** Paso 1. Pregunta a Canvas y pinta lo que Canvas contesto, no lo que creemos. */
async function revisarEntrega() {
  const peticion = peticionDeEntrega();
  if (!peticion) {
    nota($("#aviso-tareas"), "Elige una tarea.", "", "mala");
    return;
  }
  if (!peticion.archivo) {
    nota($("#aviso-tareas"), "Sube un archivo y seleccionalo.", "", "mala");
    return;
  }

  const boton = $("#revisar-entrega");
  boton.disabled = true;
  $("#estado-entrega").textContent = "revisando contra Canvas...";
  olvidarRevision();

  try {
    const { plan } = await enviar("/api/entrega/revisar", peticion);
    entregaRevisada = peticion;

    const lineas = [
      `Tarea: ${plan?.tarea || plan?.assignment?.name || peticion.tarea}`,
      `Vence: ${plan?.vence || plan?.due_at || "sin fecha declarada"}`,
      `Envio previo: ${plan?.envio_previo || plan?.previous_submission || "ninguno"}`,
      `Archivo: ${peticion.archivo}`,
    ];
    if (peticion.comentario) lineas.push(`Comentario: ${peticion.comentario}`);

    nota(
      $("#plan-entrega"),
      "Esto es lo que se va a entregar:",
      ` ${lineas.join(" · ")}. Si algo no cuadra, cancela.`,
    );
    $("#fila-confirmar").hidden = false;
    $("#estado-entrega").textContent = "revisado, falta confirmar";
  } catch (error) {
    $("#estado-entrega").textContent = "";
    if (error.estado === 401) {
      nota($("#aviso-tareas"), "Tu sesion de Canvas vencio.", " Renuevala y vuelve a intentar.", "mala");
      return;
    }
    avisoDeError($("#aviso-tareas"), "No se pudo revisar la entrega", error);
  } finally {
    boton.disabled = false;
  }
}

/** Paso 2. Lo unico de esta plataforma que no se deshace. */
async function confirmarEntrega() {
  const ahora = peticionDeEntrega();

  if (!mismaEntrega(entregaRevisada, ahora)) {
    olvidarRevision();
    nota(
      $("#aviso-tareas"),
      "Cambio algo desde que revisaste.",
      " No se entrego nada. Revisa de nuevo para ver contra que tarea y con que archivo.",
      "mala",
    );
    return;
  }

  const boton = $("#confirmar-entrega");
  boton.disabled = true;
  $("#estado-entrega").textContent = "entregando en Canvas...";

  try {
    await enviar("/api/entrega", { ...ahora, confirmar: true });
    olvidarRevision();
    $("#estado-entrega").textContent = "";
    nota(
      $("#aviso-tareas"),
      "Entregado en Canvas.",
      " Revisalo en Canvas para verlo con tus propios ojos: desde aca no se puede deshacer.",
    );
    verPendientes();
  } catch (error) {
    $("#estado-entrega").textContent = "";
    avisoDeError($("#aviso-tareas"), "No se pudo entregar", error);
  } finally {
    boton.disabled = false;
  }
}

/* ───────── Armazon ───────── */

/** Cambia de panel como si se hubiera pulsado su boton en la barra lateral. */
function irAPanel(nombre) {
  const boton = document.querySelector(`.lateral-nav .nav-item[data-panel="${nombre}"]`);
  if (boton) boton.click();
}

function activarNavegacion() {
  for (const boton of document.querySelectorAll(".lateral-nav .nav-item")) {
    boton.addEventListener("click", () => {
      for (const otro of document.querySelectorAll(".lateral-nav .nav-item")) {
        otro.classList.remove("activa");
        // La clase pinta; aria-current es lo que se dice. Sin esto, con lector
        // de pantalla los nueve items suenan exactamente igual.
        otro.removeAttribute("aria-current");
      }
      for (const panel of document.querySelectorAll(".panel")) panel.hidden = true;
      boton.classList.add("activa");
      boton.setAttribute("aria-current", "page");
      $(`#panel-${boton.dataset.panel}`).hidden = false;
      if (boton.dataset.panel === "usuarios") cargarUsuarios();
      if (boton.dataset.panel === "encuesta") cargarEncuesta();
      if (boton.dataset.panel === "adopcion") cargarAdopcion();
      if (boton.dataset.panel === "chat") comprobarModelo();
      if (boton.dataset.panel === "archivos") verArchivos();
      if (boton.dataset.panel === "guias") { comprobarModelo(); cargarGuias(); }
      if (boton.dataset.panel === "tareas") verPendientes();
      if (boton.dataset.panel === "grafo") verGrafo();
      else pararSimulacion();
    });
  }

  for (const boton of document.querySelectorAll("#modos button")) {
    boton.addEventListener("click", () => {
      estado.modo = boton.dataset.modo;
      ocultar($("#aviso-acceso"));
      pintarModoDeAcceso();
    });
  }
}

function activarTema() {
  const boton = $("#tema");
  const guardado = localStorage.getItem("tema");
  if (guardado) document.documentElement.dataset.theme = guardado;

  const pintar = () => {
    boton.textContent = document.documentElement.dataset.theme === "dark" ? "Modo claro" : "Modo oscuro";
  };
  pintar();

  boton.addEventListener("click", () => {
    const oscuro = document.documentElement.dataset.theme === "dark";
    document.documentElement.dataset.theme = oscuro ? "light" : "dark";
    localStorage.setItem("tema", oscuro ? "light" : "dark");
    pintar();
  });
}

/** Decide que pantalla se ve: la de acceso o la aplicacion. */
async function arrancar() {
  const estadoServidor = await pedir("/api/estado");
  estado.primerUsuario = !estadoServidor.hay_usuarios;

  if (!estadoServidor.autenticado) {
    estado.yo = null;
    $("#app").hidden = true;
    $("#acceso").hidden = false;
    pintarModoDeAcceso();
    return;
  }

  estado.yo = estadoServidor.usuario;
  $("#acceso").hidden = true;
  $("#app").hidden = false;

  $("#yo-nombre").textContent = estado.yo.nombre;
  $("#yo-correo").textContent = estado.yo.correo;
  $("#yo-rol").textContent = estado.yo.rol;
  $("#nav-usuarios").hidden = estado.yo.rol !== "admin";
  $("#nav-adopcion").hidden = estado.yo.rol !== "admin";

  const yo = await pedir("/api/yo");
  $("#ruta-cookie").textContent = yo.cookie.ruta;

  comprobarModelo();

  await cargarMaterial();
}

function inicio() {
  activarNavegacion();
  activarTema();

  $("#form-acceso").addEventListener("submit", enviarAcceso);
  $("#salir").addEventListener("click", salir);
  $("#recargar").addEventListener("click", cargarMaterial);
  $("#sincronizar").addEventListener("click", sincronizar);
  $("#preguntar").addEventListener("click", preguntar);
  $("#ver-archivos").addEventListener("click", verArchivos);
  $("#ver-grafo").addEventListener("click", verGrafo);
  $("#soltar-fijados").addEventListener("click", () => simulacion?.soltarFijados?.());
  $("#reencuadrar").addEventListener("click", () => simulacion?.reencuadrar?.());
  const cerrarCajon = () => {
    const cajon = $("#cajon");
    if (cajon.hidden) return;
    cajon.hidden = true;
    // El foco vuelve al grafo, que es de donde salio. Si se deja en un
    // elemento que acaba de ocultarse, la siguiente tabulacion empieza de cero
    // arriba de la pagina.
    $("#lienzo-grafo").focus({ preventScroll: true });
  };

  $("#cajon-cerrar").addEventListener("click", cerrarCajon);
  document.addEventListener("keydown", evento => {
    if (evento.key === "Escape") cerrarCajon();
  });
  $("#limpiar-chat").addEventListener("click", () => {
    estado.chat = [];
    $("#conversacion").replaceChildren();
    ocultar($("#aviso-chat"));
  });
  // Enter manda, Shift+Enter hace salto de linea: es lo que espera cualquiera
  // que haya usado un chat antes.
  $("#chat-pregunta").addEventListener("keydown", evento => {
    if (evento.key === "Enter" && !evento.shiftKey) {
      evento.preventDefault();
      preguntar();
    }
  });
  $("#armar-guia").addEventListener("click", armarGuia);
  $("#recargar-guias").addEventListener("click", cargarGuias);
  // Enter en el tema arma la guia: es un formulario de un campo, en la practica.
  $("#guia-tema").addEventListener("keydown", evento => {
    if (evento.key === "Enter") {
      evento.preventDefault();
      armarGuia();
    }
  });
  $("#guardar-cookie").addEventListener("click", guardarCookie);
  $("#probar-cookie").addEventListener("click", probarCookie);
  $("#crear-usuario").addEventListener("click", crearUsuario);
  $("#enviar-encuesta").addEventListener("click", enviarEncuesta);

  $("#ver-pendientes").addEventListener("click", verPendientes);
  $("#subir-archivo").addEventListener("click", subirArchivo);
  $("#revisar-entrega").addEventListener("click", revisarEntrega);
  $("#confirmar-entrega").addEventListener("click", confirmarEntrega);
  $("#cancelar-entrega").addEventListener("click", () => {
    olvidarRevision();
    $("#estado-entrega").textContent = "";
    nota($("#aviso-tareas"), "Cancelado.", " No se entrego nada.");
  });
  // Cambiar la tarea o el comentario despues de revisar invalida la revision:
  // lo que se confirma tiene que ser exactamente lo que se vio.
  $("#entrega-tarea").addEventListener("change", olvidarRevision);
  $("#entrega-comentario").addEventListener("input", olvidarRevision);

  arrancar().catch(error => {
    $("#acceso").hidden = false;
    nota($("#aviso-acceso"), "No se pudo contactar al servidor", ` ${error.message}`, "mala");
  });
}

inicio();
