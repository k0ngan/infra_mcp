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
    $("#ruta-vault").textContent = `${datos.vault}\\${datos.subdir}`;
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

const COLOR_TIPO = {
  modulo: "#004E9A", pagina: "#1E7FBF", tarea: "#7AB82F",
  anuncio: "#D97706", archivo: "#7C8894", discusion: "#9B59B6",
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

    ctx.font = `600 ${10 / vista.escala}px 'IBM Plex Sans', system-ui, sans-serif`;
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

/* ───────── Armazon ───────── */

/** Cambia de panel como si se hubiera pulsado su boton en la barra lateral. */
function irAPanel(nombre) {
  const boton = document.querySelector(`.lateral-nav .nav-item[data-panel="${nombre}"]`);
  if (boton) boton.click();
}

function activarNavegacion() {
  for (const boton of document.querySelectorAll(".lateral-nav .nav-item")) {
    boton.addEventListener("click", () => {
      for (const otro of document.querySelectorAll(".lateral-nav .nav-item")) otro.classList.remove("activa");
      for (const panel of document.querySelectorAll(".panel")) panel.hidden = true;
      boton.classList.add("activa");
      $(`#panel-${boton.dataset.panel}`).hidden = false;
      if (boton.dataset.panel === "usuarios") cargarUsuarios();
      if (boton.dataset.panel === "chat") comprobarModelo();
      if (boton.dataset.panel === "archivos") verArchivos();
      if (boton.dataset.panel === "guias") { comprobarModelo(); cargarGuias(); }
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
  $("#cajon-cerrar").addEventListener("click", () => { $("#cajon").hidden = true; });
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

  arrancar().catch(error => {
    $("#acceso").hidden = false;
    nota($("#aviso-acceso"), "No se pudo contactar al servidor", ` ${error.message}`, "mala");
  });
}

inicio();
