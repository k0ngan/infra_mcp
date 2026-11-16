/**
 * Lee el vault de Obsidian de un usuario: que hay en cada ramo y como se
 * enlazan las notas entre si.
 *
 * Todo se lee del disco. No toca Canvas, asi que funciona igual con la sesion
 * vencida, y es rapido porque son archivos locales.
 *
 * Una nota sobre seguridad: el `course_id` viene del navegador, asi que la
 * carpeta NUNCA se arma concatenando lo que llega. Se resuelve contra la lista
 * que reporta el propio MCP para ese usuario; si el id no esta en esa lista, no
 * existe. Sin eso, un id con ".." leeria cualquier carpeta de la maquina.
 */
import fs from "node:fs";
import path from "node:path";

import { llamar } from "./canvas.mjs";

const CARPETAS = {
  Anuncios: "anuncio",
  Archivos: "archivo",
  Discusiones: "discusion",
  Modulos: "modulo",
  Paginas: "pagina",
  Tareas: "tarea",
};

const EXTRAIDAS = "Fuentes extraidas";
const DESCARGAS = "Descargas";

function fallo(mensaje, estado = 404) {
  return Object.assign(new Error(mensaje), { estado });
}

/** Resuelve la carpeta de un ramo, solo entre las que el MCP reconoce. */
export async function carpetaDelRamo(usuario, courseId) {
  const estado = await llamar(usuario, "canvas_vault_status");
  const base = estado.configuracion.vault_dir;
  if (!base) throw fallo("Este usuario no tiene vault configurado.", 400);

  const carpeta = (estado.carpetas_de_curso || []).find(
    c => Number.parseInt(path.basename(c).split("-")[0], 10) === courseId,
  );
  if (!carpeta) throw fallo(`No encuentro el ramo ${courseId} en tu vault.`);

  const absoluta = path.resolve(base, carpeta);
  const raiz = path.resolve(base);
  if (absoluta !== raiz && !absoluta.startsWith(raiz + path.sep)) {
    throw fallo("Ruta fuera del vault.", 400);
  }
  return { absoluta, relativa: carpeta, vault: base };
}

const listar = dir => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

/** El id de Canvas va al principio del nombre: "275867 - Bienvenida...". */
function idDeNota(nombre) {
  const n = Number.parseInt(nombre.split(" - ")[0], 10);
  return Number.isFinite(n) ? n : null;
}

const titulo = nombre => nombre.replace(/\.md$/i, "").replace(/^\d+\s*-\s*/, "");

/**
 * Que hay en un ramo, agrupado por tipo.
 *
 * Para los adjuntos se informa ademas si tienen el texto extraido. Es el dato
 * que mas importa: un PDF sin texto extraido existe, pero el ayudante no lo
 * puede leer, y hasta ahora eso solo se sabia cuando una respuesta salia pobre.
 */
export async function contenidoDelRamo(usuario, courseId) {
  const { absoluta, relativa } = await carpetaDelRamo(usuario, courseId);

  const extraidas = new Set(
    listar(path.join(absoluta, EXTRAIDAS)).map(n => n.replace(/\.txt$/i, "")),
  );
  const descargas = listar(path.join(absoluta, DESCARGAS));

  const grupos = [];
  let sinTexto = 0;

  for (const [carpeta, tipo] of Object.entries(CARPETAS)) {
    const notas = listar(path.join(absoluta, carpeta)).filter(n => n.endsWith(".md"));
    if (notas.length === 0) continue;

    const items = notas.map(nombre => {
      const id = idDeNota(nombre);
      const item = { id, tipo, titulo: titulo(nombre), nota: `${relativa}/${carpeta}/${nombre}` };

      if (tipo === "archivo") {
        item.tiene_texto = id !== null && extraidas.has(String(id));
        item.descargado = descargas.some(d => d.startsWith(`${id}-`));
        if (!item.tiene_texto) sinTexto += 1;
      }
      return item;
    });

    grupos.push({ carpeta, tipo, total: items.length, items: items.sort((a, b) => a.titulo.localeCompare(b.titulo, "es")) });
  }

  return {
    course_id: courseId,
    carpeta: relativa,
    grupos,
    resumen: {
      notas: grupos.reduce((s, g) => s + g.total, 0),
      adjuntos_sin_texto: sinTexto,
      descargados: descargas.length,
      textos_extraidos: extraidas.size,
    },
  };
}

/*
 * Los enlaces de Obsidian son [[ruta/al/destino]]. Dentro puede haber corchetes
 * simples — "[Semana Nº1]" aparece en varios titulos —, asi que el cierre se
 * busca con `]]` y no con `]`.
 */
const ENLACE = /\[\[(.+?)\]\]/g;

/**
 * El grafo del ramo: una nota por nodo, un enlace por arista.
 *
 * Es el mismo grafo que dibuja Obsidian, construido leyendo las mismas notas.
 * Quien enlaza a quien lo decide el servidor del MCP cuando sincroniza: los
 * modulos apuntan a sus paginas, tareas y archivos.
 */
export async function grafoDelRamo(usuario, courseId) {
  const { absoluta, relativa } = await carpetaDelRamo(usuario, courseId);

  const nodos = [];
  const porNombre = new Map();

  for (const [carpeta, tipo] of Object.entries(CARPETAS)) {
    for (const nombre of listar(path.join(absoluta, carpeta)).filter(n => n.endsWith(".md"))) {
      const clave = nombre.replace(/\.md$/i, "");
      const nodo = {
        id: `${carpeta}/${clave}`,
        tipo,
        titulo: titulo(nombre),
        archivo: path.join(absoluta, carpeta, nombre),
      };
      nodos.push(nodo);
      porNombre.set(clave, nodo.id);
    }
  }

  const aristas = [];
  const vistas = new Set();

  for (const nodo of nodos) {
    let texto;
    try {
      texto = fs.readFileSync(nodo.archivo, "utf8");
    } catch {
      continue;
    }
    for (const [, destino] of texto.matchAll(ENLACE)) {
      // Los enlaces vienen con la ruta completa desde la raiz del vault; lo
      // unico que hace falta para identificar la nota es su nombre.
      const clave = destino.split("/").pop().trim();
      const id = porNombre.get(clave);
      if (!id || id === nodo.id) continue;

      const arista = `${nodo.id}→${id}`;
      if (vistas.has(arista)) continue;
      vistas.add(arista);
      aristas.push({ desde: nodo.id, hacia: id });
    }
  }

  // El grado sirve para dibujar mas grande lo que mas conecta: en estos vaults,
  // los modulos.
  const grado = new Map();
  for (const a of aristas) {
    grado.set(a.desde, (grado.get(a.desde) || 0) + 1);
    grado.set(a.hacia, (grado.get(a.hacia) || 0) + 1);
  }

  return {
    course_id: courseId,
    carpeta: relativa,
    nodos: nodos.map(({ archivo, ...n }) => ({ ...n, grado: grado.get(n.id) || 0 })),
    aristas,
  };
}

/**
 * Devuelve el archivo descargado de un adjunto, si esta en el vault.
 *
 * El nombre en Descargas/ empieza con el file_id: "1218706-GUIA.pdf". Se busca
 * por ese prefijo en vez de confiar en el nombre que venga del navegador, que
 * es lo que permitiria salirse de la carpeta.
 */
export async function archivoDescargado(usuario, courseId, fileId) {
  const { absoluta } = await carpetaDelRamo(usuario, courseId);
  const dir = path.join(absoluta, DESCARGAS);

  const nombre = listar(dir).find(n => n.startsWith(`${fileId}-`));
  if (!nombre) throw fallo("Ese adjunto no esta descargado en tu vault.");

  const archivo = path.join(dir, nombre);
  // Cinturon y tirantes: el nombre salio de readdir, pero se comprueba igual.
  if (!path.resolve(archivo).startsWith(path.resolve(dir) + path.sep)) {
    throw fallo("Ruta fuera del vault.", 400);
  }
  return { archivo, nombre: nombre.replace(`${fileId}-`, "") };
}

/**
 * Lee una nota del vault a partir del id de nodo del grafo ("Paginas/275867 - ...").
 *
 * La carpeta tiene que ser una de las conocidas y el archivo tiene que aparecer
 * en el readdir de esa carpeta. Asi el identificador que llega del navegador
 * nunca se usa para construir una ruta: solo para buscar en una lista.
 */
export async function notaDelRamo(usuario, courseId, nodoId) {
  const corte = String(nodoId || "").indexOf("/");
  if (corte < 1) throw fallo("Identificador de nota invalido.", 400);

  const carpeta = String(nodoId).slice(0, corte);
  const clave = String(nodoId).slice(corte + 1);
  if (!Object.prototype.hasOwnProperty.call(CARPETAS, carpeta)) {
    throw fallo("Identificador de nota invalido.", 400);
  }

  const { absoluta, relativa } = await carpetaDelRamo(usuario, courseId);
  const dir = path.join(absoluta, carpeta);

  // Se compara normalizado: la misma "o" con tilde puede venir como un caracter
  // o como dos segun de donde salga el texto, y entonces dos nombres que se ven
  // identicos no son iguales.
  const buscado = `${clave}.md`.normalize("NFC");
  const nombre = listar(dir).find(n => n.normalize("NFC") === buscado);
  if (!nombre) throw fallo("Esa nota no esta en tu vault.");

  const crudo = fs.readFileSync(path.join(dir, nombre), "utf8");
  // El frontmatter lo escribe el servidor del MCP y no aporta nada al leer.
  const cuerpo = crudo.startsWith("---")
    ? crudo.slice(crudo.indexOf("\n---", 3) + 4).replace(/^\s+/, "")
    : crudo;

  const id = idDeNota(nombre);
  const descargado = CARPETAS[carpeta] === "archivo"
    && listar(path.join(absoluta, DESCARGAS)).some(d => d.startsWith(`${id}-`));

  return {
    id,
    tipo: CARPETAS[carpeta],
    titulo: titulo(nombre),
    nota: `${relativa}/${carpeta}/${nombre}`,
    descargado,
    cuerpo: cuerpo.slice(0, 20_000),
  };
}

/**
 * El grafo de TODO el vault, con los ramos juntos.
 *
 * Es el grafo global de Obsidian: cada nota un punto, cada enlace una linea.
 * Como los enlaces solo existen dentro de un mismo ramo, los ramos salen como
 * islas separadas, y eso es fiel a como esta el material de verdad.
 *
 * El id de cada nodo lleva la carpeta del curso delante, porque dos ramos
 * pueden tener notas con el mismo nombre ("Anuncios" esta en casi todos).
 */
export async function grafoDelVault(usuario) {
  const estado = await llamar(usuario, "canvas_vault_status");
  const base = estado.configuracion.vault_dir;
  if (!base) throw fallo("Este usuario no tiene vault configurado.", 400);

  const nodos = [];
  const aristas = [];
  const cursos = [];

  for (const carpetaCurso of estado.carpetas_de_curso || []) {
    const absoluta = path.resolve(base, carpetaCurso);
    if (!absoluta.startsWith(path.resolve(base) + path.sep)) continue;

    const nombreCurso = path.basename(carpetaCurso);
    const courseId = Number.parseInt(nombreCurso.split("-")[0], 10);
    // "31151-2026-2-grafos-y-lenguajes-formales" -> "2026 2 grafos y lenguajes formales"
    const cursoCorto = nombreCurso.replace(/^\d+-/, "").replace(/-/g, " ");
    const porNombre = new Map();
    const delCurso = [];

    for (const [carpeta, tipo] of Object.entries(CARPETAS)) {
      for (const nombre of listar(path.join(absoluta, carpeta)).filter(n => n.endsWith(".md"))) {
        const clave = nombre.replace(/\.md$/i, "");
        const nodo = {
          id: `${nombreCurso}::${carpeta}/${clave}`,
          nodo: `${carpeta}/${clave}`,
          course_id: Number.isFinite(courseId) ? courseId : null,
          curso: nombreCurso,
          cursoCorto,
          tipo,
          titulo: titulo(nombre),
          archivo: path.join(absoluta, carpeta, nombre),
        };
        delCurso.push(nodo);
        porNombre.set(clave, nodo.id);
      }
    }
    if (delCurso.length === 0) continue;

    cursos.push({
      course_id: Number.isFinite(courseId) ? courseId : null,
      carpeta: nombreCurso,
      titulo: cursoCorto,
      notas: delCurso.length,
    });

    const vistas = new Set();
    for (const nodo of delCurso) {
      let texto;
      try {
        texto = fs.readFileSync(nodo.archivo, "utf8");
      } catch {
        continue;
      }
      for (const [, destino] of texto.matchAll(ENLACE)) {
        const clave = destino.split("/").pop().trim();
        const id = porNombre.get(clave);
        if (!id || id === nodo.id) continue;
        const arista = `${nodo.id}→${id}`;
        if (vistas.has(arista)) continue;
        vistas.add(arista);
        aristas.push({ desde: nodo.id, hacia: id });
      }
    }
    nodos.push(...delCurso);
  }

  // Las aristas viajan como pares de indices y los nodos sin su id largo: con
  // 1.252 notas, repetir la carpeta del curso en cada una inflaba la respuesta
  // a medio mega. Asi baja a una fraccion y el dibujo no necesita nada mas.
  const posicion = new Map(nodos.map((n, i) => [n.id, i]));
  const grado = new Array(nodos.length).fill(0);
  const pares = [];

  for (const a of aristas) {
    const i = posicion.get(a.desde);
    const j = posicion.get(a.hacia);
    if (i === undefined || j === undefined) continue;
    pares.push([i, j]);
    grado[i] += 1;
    grado[j] += 1;
  }

  return {
    nodos: nodos.map((n, i) => ({
      course_id: n.course_id,
      nodo: n.nodo,
      curso: n.cursoCorto,
      tipo: n.tipo,
      titulo: n.titulo,
      grado: grado[i],
    })),
    aristas: pares,
    cursos: cursos.sort((a, b) => b.notas - a.notas),
  };
}
