/**
 * De texto del vault a un PDF, pasando por LaTeX.
 *
 * ───────── Por que pdflatex y no xelatex ─────────
 *
 * Los .tex escritos a mano de este autor usan `fontspec` con `setmainfont{Arial}`,
 * que obliga a xelatex. Para un GENERADOR conviene lo contrario: `fontspec` ata
 * el documento a que la maquina tenga esa fuente instalada, y este PDF se tiene
 * que poder recompilar en la maquina del profesor. Con `inputenc` + `fontenc T1`
 * + `lmodern` los acentos y la ñ salen bien en cualquier distribucion de TeX, y
 * pdflatex es bastante mas rapido: esto corre dentro de un trabajo que ya gasta
 * minutos hablando con el modelo.
 *
 * Queda PLATAFORMA_LATEX=xelatex como salida de emergencia, y en ese caso si se
 * emite `fontspec`.
 *
 * ───────── Por que escapar es una sola pasada ─────────
 *
 * El error clasico es escapar en cadena: reemplazas `\` por `\textbackslash{}` y
 * la pasada siguiente, la de las llaves, destroza lo que acabas de introducir.
 * Aca se recorre el texto una vez y cada caracter se decide por su cuenta.
 *
 * El material viene de PDF de matematicas y de prosa de un modelo, asi que lo que
 * de verdad rompe la compilacion no son los `$` ni los `%`: son los caracteres
 * Unicode. Con `inputenc`, un `…` o un `Σ` suelto es un error duro ("Unicode
 * character not set up for use with LaTeX"). De ahi la tabla de transliteracion,
 * y de ahi la valvula del final: cualquier codepoint por encima de U+024F que no
 * este en la tabla se descarta. Un emoji en un anuncio no puede dejar a nadie sin
 * PDF.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const MOTOR_POR_DEFECTO = process.env.PLATAFORMA_LATEX || "pdflatex";

/** El .tex se llama siempre asi: ASCII puro, sin espacios ni acentos. */
export const NOMBRE_TEX = "guia.tex";

const ESPERA_POR_DEFECTO_MS = Number.parseInt(process.env.PLATAFORMA_LATEX_TIMEOUT || "60000", 10);

/* ───────── Escapado ───────── */

const ESPECIALES = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  "$": "\\$",
  "&": "\\&",
  "#": "\\#",
  "%": "\\%",
  "_": "\\_",
  "^": "\\textasciicircum{}",
  "~": "\\textasciitilde{}",
};

/*
 * Lo que aparece de verdad en el material: puntuacion tipografica de los anuncios
 * y simbolos de Grafos, Calculo, Metodos Numericos y Electromagnetismo. Las
 * acentuadas latinas no estan aca a proposito: T1 las imprime tal cual.
 */
const UNICODE = {
  // Puntuacion
  "…": "\\ldots{}",
  "—": "---",
  "–": "--",
  "‐": "-",
  "‑": "-",
  "“": "``",
  "”": "''",
  "„": ",,",
  "‘": "`",
  "’": "'",
  "«": "\\guillemotleft{}",
  "»": "\\guillemotright{}",
  "·": "$\\cdot$",
  "•": "$\\bullet$",
  "′": "$'$",
  "″": "$''$",
  "°": "$^\\circ$",
  "ª": "\\textordfeminine{}",
  "º": "\\textordmasculine{}",
  "€": "\\texteuro{}",
  "£": "\\pounds{}",
  "©": "\\copyright{}",
  "®": "\\textregistered{}",
  " ": " ",
  " ": " ",
  " ": " ",
  "​": "",
  "﻿": "",
  // Relaciones y operadores
  "≤": "$\\leq$",
  "≥": "$\\geq$",
  "≠": "$\\neq$",
  "≈": "$\\approx$",
  "≡": "$\\equiv$",
  "±": "$\\pm$",
  "×": "$\\times$",
  "÷": "$\\div$",
  "∓": "$\\mp$",
  "∗": "$*$",
  "√": "$\\sqrt{\\;}$",
  "∞": "$\\infty$",
  "∝": "$\\propto$",
  "∑": "$\\sum$",
  "∏": "$\\prod$",
  "∫": "$\\int$",
  "∮": "$\\oint$",
  "∂": "$\\partial$",
  "∇": "$\\nabla$",
  // Flechas
  "→": "$\\rightarrow$",
  "←": "$\\leftarrow$",
  "↔": "$\\leftrightarrow$",
  "⇒": "$\\Rightarrow$",
  "⇐": "$\\Leftarrow$",
  "⇔": "$\\Leftrightarrow$",
  "↦": "$\\mapsto$",
  "↑": "$\\uparrow$",
  "↓": "$\\downarrow$",
  // Conjuntos y logica
  "∈": "$\\in$",
  "∉": "$\\notin$",
  "∋": "$\\ni$",
  "⊂": "$\\subset$",
  "⊆": "$\\subseteq$",
  "⊃": "$\\supset$",
  "⊇": "$\\supseteq$",
  "∪": "$\\cup$",
  "∩": "$\\cap$",
  "∖": "$\\setminus$",
  "∅": "$\\emptyset$",
  "∀": "$\\forall$",
  "∃": "$\\exists$",
  "¬": "$\\neg$",
  "∧": "$\\wedge$",
  "∨": "$\\vee$",
  "⟨": "$\\langle$",
  "⟩": "$\\rangle$",
  "⌈": "$\\lceil$",
  "⌉": "$\\rceil$",
  "⌊": "$\\lfloor$",
  "⌋": "$\\rfloor$",
  "‖": "$\\|$",
  "ℝ": "$\\mathbb{R}$",
  "ℕ": "$\\mathbb{N}$",
  "ℤ": "$\\mathbb{Z}$",
  "ℚ": "$\\mathbb{Q}$",
  "ℂ": "$\\mathbb{C}$",
  // Griegas
  "α": "$\\alpha$",
  "β": "$\\beta$",
  "γ": "$\\gamma$",
  "δ": "$\\delta$",
  "ε": "$\\varepsilon$",
  "ζ": "$\\zeta$",
  "η": "$\\eta$",
  "θ": "$\\theta$",
  "ι": "$\\iota$",
  "κ": "$\\kappa$",
  "λ": "$\\lambda$",
  "μ": "$\\mu$",
  "ν": "$\\nu$",
  "ξ": "$\\xi$",
  "π": "$\\pi$",
  "ρ": "$\\rho$",
  "σ": "$\\sigma$",
  "τ": "$\\tau$",
  "υ": "$\\upsilon$",
  "φ": "$\\varphi$",
  "χ": "$\\chi$",
  "ψ": "$\\psi$",
  "ω": "$\\omega$",
  "Γ": "$\\Gamma$",
  "Δ": "$\\Delta$",
  "∆": "$\\Delta$",
  "Θ": "$\\Theta$",
  "Λ": "$\\Lambda$",
  "Ξ": "$\\Xi$",
  "Π": "$\\Pi$",
  "Σ": "$\\Sigma$",
  "Φ": "$\\Phi$",
  "Ψ": "$\\Psi$",
  "Ω": "$\\Omega$",
  // Potencias e indices, que en los PDF vienen pegados al texto
  "⁰": "$^0$",
  "¹": "$^1$",
  "²": "$^2$",
  "³": "$^3$",
  "⁴": "$^4$",
  "ⁿ": "$^n$",
  "₀": "$_0$",
  "₁": "$_1$",
  "₂": "$_2$",
  "₃": "$_3$",
  "₄": "$_4$",
  "½": "$\\tfrac{1}{2}$",
  "¼": "$\\tfrac{1}{4}$",
  "¾": "$\\tfrac{3}{4}$",
};

/** Hasta aca llega lo que T1 imprime sin ayuda: latin-1 y latin extendido A/B. */
const TOPE_SEGURO = 0x024f;

/**
 * Texto plano -> texto que LaTeX puede imprimir.
 *
 * No es idempotente, y es a proposito: se escapa EXACTAMENTE una vez, en el
 * borde, cuando el texto entra al documento.
 */
export function escaparLatex(texto) {
  if (texto === null || texto === undefined) return "";
  let salida = "";
  for (const caracter of String(texto)) {
    const especial = ESPECIALES[caracter];
    if (especial !== undefined) {
      salida += especial;
      continue;
    }
    const equivalente = UNICODE[caracter];
    if (equivalente !== undefined) {
      salida += equivalente;
      continue;
    }
    const punto = caracter.codePointAt(0);

    /*
     * Los caracteres de control se van, y esto costo un PDF.
     *
     * Estan por DEBAJO del tope seguro, asi que pasaban enteros por la rama de
     * abajo. Mientras las fuentes eran notas de Canvas no aparecia ninguno;
     * desde que `scripts/extraer-texto.py` saca el texto de los PDF, vienen
     * dentro: un 0x03 en medio de un ejercicio del libro de automatas mato la
     * compilacion con "Fatal error occurred, no output PDF file produced",
     * y el log solo decia `^^C`.
     *
     * Se conservan el salto de linea y el tabulador, que si significan algo.
     */
    const esControl = (punto < 0x20 && punto !== 0x0a && punto !== 0x09) ||
      (punto >= 0x7f && punto <= 0x9f);
    if (esControl) continue;

    if (punto <= TOPE_SEGURO) {
      salida += caracter;
      continue;
    }
    // Lo que queda arriba del tope se descarta en silencio. No vale la pena
    // perder un PDF entero por un simbolo decorativo.
  }
  return salida;
}

/* ───────── Fechas ───────── */

const DIAS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/**
 * "2026-11-05" -> "jueves 5 de noviembre de 2026".
 *
 * Se parsea y se lee en UTC: con `new Date("2026-11-05")` y `getDate()` local,
 * en Chile la fecha se corre un dia para atras.
 */
export function fechaEnPalabras(iso) {
  const texto = String(iso || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return null;
  const fecha = new Date(`${texto}T12:00:00Z`);
  if (Number.isNaN(fecha.getTime())) return null;
  return `${DIAS[fecha.getUTCDay()]} ${fecha.getUTCDate()} de ${MESES[fecha.getUTCMonth()]} de ${fecha.getUTCFullYear()}`;
}

/** Fecha y hora de generacion, para la portada. */
export function selloDeFecha(cuando = new Date()) {
  const dd = String(cuando.getDate()).padStart(2, "0");
  const mm = String(cuando.getMonth() + 1).padStart(2, "0");
  const hh = String(cuando.getHours()).padStart(2, "0");
  const mi = String(cuando.getMinutes()).padStart(2, "0");
  return `${dd}-${mm}-${cuando.getFullYear()} ${hh}:${mi}`;
}

/* ───────── Armado del documento ───────── */

/**
 * El cuerpo de una seccion, a LaTeX.
 *
 * Dos formas y nada mas: parrafos separados por una linea en blanco, y lineas
 * que empiezan con "- " o "* ", que se agrupan en un itemize. Es lo que el
 * modelo produce cuando se le pide prosa, y los extractos literales tambien
 * caen bien en ese molde.
 */
export function cuerpoALatex(texto) {
  const lineas = String(texto || "").replace(/\r\n/g, "\n").split("\n");
  const partes = [];

  let vinetas = null;
  const cerrarVinetas = () => {
    if (!vinetas) return;
    // Las dos longitudes hacen lo que hacia `\setlist{nosep}` de enumitem, sin
    // el paquete: una lista apretada en vez de una con aire de tesis.
    //
    // El `{}` delante del texto no es decorativo. `\item` busca un `[` para
    // leerlo como etiqueta opcional, y el material trae enlaces de Obsidian
    // (`- [[Canvas/...]]`). Sin el grupo, LaTeX se come el enlace como etiqueta,
    // y si el texto venia recortado con "…" la etiqueta nunca cierra: la
    // compilacion muere con "Paragraph ended before \@item was complete".
    partes.push(
      "\\begin{itemize}\n  \\setlength{\\itemsep}{1pt}\\setlength{\\parskip}{0pt}\n" +
      `${vinetas.map(v => `  \\item ${v.startsWith("[") ? "{}" : ""}${v}`).join("\n")}\n\\end{itemize}`,
    );
    vinetas = null;
  };

  let parrafo = [];
  const cerrarParrafo = () => {
    if (!parrafo.length) return;
    partes.push(escaparLatex(parrafo.join(" ")));
    parrafo = [];
  };

  for (const linea of lineas) {
    const limpia = linea.trim();
    if (!limpia) {
      cerrarParrafo();
      cerrarVinetas();
      continue;
    }

    const vineta = limpia.match(/^[-*•]\s+(.*)$/);
    if (vineta) {
      cerrarParrafo();
      (vinetas ||= []).push(escaparLatex(vineta[1]));
      continue;
    }
    cerrarVinetas();
    parrafo.push(limpia);
  }
  cerrarParrafo();
  cerrarVinetas();

  return partes.join("\n\n");
}

function preambulo(motor) {
  const tipografia = motor === "xelatex"
    ? ["\\usepackage{fontspec}", "\\setmainfont{Arial}"]
    : ["\\usepackage[utf8]{inputenc}", "\\usepackage[T1]{fontenc}", "\\usepackage{lmodern}"];

  return [
    "\\documentclass[11pt,a4paper]{article}",
    ...tipografia,
    // es-noshorthands: los shorthands de babel-spanish le dan significado a
    // caracteres como la comilla doble, y esto es texto generado. Desactivarlos
    // quita una familia entera de sorpresas.
    "\\usepackage[spanish,es-noshorthands]{babel}",
    "\\usepackage[margin=2.2cm,headheight=15pt]{geometry}",
    "\\usepackage{amsmath,amssymb}",
    // Sin enumitem ni booktabs a proposito: viven en texlive-latex-extra, que
    // son cientos de megas mas en la imagen del contenedor. El espaciado de las
    // listas se arregla con dos longitudes de LaTeX a secas (ver cuerpoALatex).
    "\\usepackage{xcolor}",
    "\\usepackage{fancyhdr}",
    "\\usepackage[hidelinks]{hyperref}",
    "",
    "\\definecolor{utemazul}{HTML}{004E9A}",
    "\\definecolor{utemverde}{HTML}{7AB82F}",
    "\\definecolor{apagado}{HTML}{52616D}",
    "",
    "\\setlength{\\parindent}{0pt}",
    "\\setlength{\\parskip}{5pt}",
    "\\renewcommand{\\contentsname}{Contenido}",
  ].join("\n");
}

/**
 * El documento completo.
 *
 * Las secciones llegan ya decididas por el codigo (ver guias.mjs): encabezado,
 * cuerpo y las citas en que se apoya. Aca no se elige nada, solo se imprime.
 */
export function documentoDeGuia({
  titulo,
  ramo,
  courseId,
  tema = null,
  fechaPrueba = null,
  hora = null,
  sala = null,
  secciones = [],
  citas = [],
  modelo = null,
  generado = new Date(),
  avisos = [],
  motor = MOTOR_POR_DEFECTO,
} = {}) {
  if (!Array.isArray(secciones) || secciones.length === 0) {
    throw new Error("Una guia sin secciones no se imprime.");
  }

  const conIndice = secciones.length >= 4;
  const nombreRamo = String(ramo || `curso ${courseId}`);
  const lineas = [];

  lineas.push(preambulo(motor));
  lineas.push(
    "\\pagestyle{fancy}",
    "\\fancyhf{}",
    `\\fancyhead[L]{\\small\\color{apagado} ${escaparLatex(nombreRamo.slice(0, 60))}}`,
    "\\fancyhead[R]{\\small\\color{apagado} Guia de estudio}",
    "\\fancyfoot[C]{\\thepage}",
    "\\renewcommand{\\headrulewidth}{0.3pt}",
    "",
    "\\begin{document}",
    "",
    "\\begin{center}",
    "{\\small\\color{apagado} Universidad Tecnologica Metropolitana}\\par\\vspace{6pt}",
    `{\\Huge\\bfseries\\color{utemazul} ${escaparLatex(titulo)}}\\par\\vspace{8pt}`,
    `{\\Large ${escaparLatex(nombreRamo)}}\\par\\vspace{4pt}`,
  );

  if (tema) lineas.push(`{\\large Tema: ${escaparLatex(tema)}}\\par\\vspace{4pt}`);

  const cuando = [fechaEnPalabras(fechaPrueba), hora, sala].filter(Boolean);
  if (cuando.length) {
    lineas.push(`{\\large\\bfseries ${escaparLatex(cuando.join(" · "))}}\\par\\vspace{4pt}`);
  }

  lineas.push(
    "\\vspace{4pt}{\\color{utemverde}\\rule{0.42\\linewidth}{1.4pt}}\\par\\vspace{8pt}",
    `{\\small\\color{apagado} Armada el ${escaparLatex(selloDeFecha(generado))} solo con el material sincronizado de este ramo.}`,
    "\\end{center}",
    "",
  );

  if (conIndice) lineas.push("\\tableofcontents", "\\vspace{10pt}", "");

  for (const seccion of secciones) {
    lineas.push(`\\section{${escaparLatex(seccion.encabezado)}}`, "");
    lineas.push(cuerpoALatex(seccion.cuerpo), "");
    const fuentes = (seccion.fuentes || []).map(c => `\\texttt{${escaparLatex(c)}}`).join(", ");
    if (fuentes) {
      lineas.push(`\\par\\smallskip{\\footnotesize\\color{apagado} Fuentes: ${fuentes}}`, "");
    }
  }

  lineas.push("\\section*{Material citado}");
  if (conIndice) lineas.push("\\addcontentsline{toc}{section}{Material citado}");
  lineas.push("", "\\begin{description}");
  for (const cita of citas) {
    // El tipo no se repite: la clave de la cita ya empieza por el ("modulo:84180").
    const clave = escaparLatex(typeof cita === "string" ? cita : cita.cita);
    const detalle = typeof cita === "string" ? "" : escaparLatex(cita.titulo || "");
    lineas.push(`  \\item[\\texttt{${clave}}] ${detalle || "material del ramo"}`);
  }
  lineas.push("\\end{description}", "");

  lineas.push(
    "\\vfill",
    "\\noindent{\\footnotesize\\color{apagado}",
    escaparLatex(
      "Todo lo que dice este documento sale de tu propio material de Canvas: anuncios, tareas, " +
      "paginas, modulos y adjuntos con texto extraido de este ramo. Las secciones y las citas las " +
      "decidio la plataforma; " +
      (modelo
        ? `el modelo local (${modelo}) solo redacto la prosa. `
        : "no se uso ningun modelo: las secciones son extractos literales de tu material. ") +
      "Si algo no estaba en tu material, no esta aca.",
    ),
  );

  for (const aviso of (avisos || []).filter(Boolean)) {
    lineas.push(`\\par ${escaparLatex(aviso)}`);
  }

  lineas.push("}", "", "\\end{document}", "");
  return lineas.join("\n");
}

/* ───────── Compilacion ───────── */

/**
 * Los argumentos del motor. Funcion aparte porque es lo unico de la compilacion
 * que se puede probar sin tener LaTeX instalado.
 *
 * `-disable-installer` solo con MiKTeX: sin eso, un paquete que falta abre el
 * dialogo del instalador y el proceso se queda esperando a una persona para
 * siempre. En TeX Live ese argumento no existe y abortaria la corrida, y dentro
 * del contenedor la distribucion es TeX Live.
 */
export function argumentosDe(rutaMotor, nombreTex = NOMBRE_TEX) {
  const argumentos = ["-interaction=nonstopmode", "-halt-on-error", "-file-line-error"];
  if (/miktex/i.test(String(rutaMotor || ""))) argumentos.push("-disable-installer");
  argumentos.push(nombreTex);
  return argumentos;
}

/** El motivo legible de un fallo, sacado del log de LaTeX. */
export function motivoDeFalloLatex(log) {
  const texto = String(log || "");
  const paquete = texto.match(/File ['`]([^'`]+\.sty)['`] not found/);
  if (paquete) return `falta el paquete ${paquete[1]} en tu instalacion de LaTeX`;

  const error = texto.match(/^[^\n]*?!\s+([^\n]+)$/m);
  if (error) return error[1].trim();

  const emergencia = texto.match(/^[^\n]*Emergency stop[^\n]*$/m);
  if (emergencia) return emergencia[0].trim();

  return "LaTeX fallo y no dejo un motivo claro en el log";
}

function ejecutar(comando, argumentos, { cwd, esperaMs } = {}) {
  return new Promise(listo => {
    let hijo;
    try {
      // `shell` se queda en false (el defecto) y no se toca: el titulo de la
      // guia lo escribe una persona, y con shell un "&" seria ejecucion de
      // ordenes.
      hijo = spawn(comando, argumentos, { cwd, windowsHide: true });
    } catch (error) {
      listo({ codigo: null, salida: "", motivo: error.message });
      return;
    }

    let salida = "";
    let matado = false;
    const recoger = trozo => { salida += trozo.toString("utf8"); };
    hijo.stdout?.on("data", recoger);
    hijo.stderr?.on("data", recoger);

    const reloj = esperaMs
      ? setTimeout(() => { matado = true; hijo.kill("SIGKILL"); }, esperaMs)
      : null;

    hijo.on("error", error => {
      if (reloj) clearTimeout(reloj);
      listo({ codigo: null, salida, motivo: error.message });
    });
    hijo.on("close", codigo => {
      if (reloj) clearTimeout(reloj);
      listo({
        codigo,
        salida,
        motivo: matado ? `el motor de LaTeX no termino en ${Math.round(esperaMs / 1000)} s` : null,
      });
    });
  });
}

async function resolverMotor(motor) {
  if (process.env.PLATAFORMA_LATEX_BIN) return process.env.PLATAFORMA_LATEX_BIN;

  const buscador = process.platform === "win32" ? "where" : "which";
  const { codigo, salida } = await ejecutar(buscador, [motor], { esperaMs: 5_000 });
  if (codigo !== 0) return null;

  const primera = salida.split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0];
  return primera || null;
}

function leerLog(directorio, salida) {
  const log = path.join(directorio, NOMBRE_TEX.replace(/\.tex$/, ".log"));
  if (fs.existsSync(log)) {
    try {
      return fs.readFileSync(log, "utf8");
    } catch {
      /* da igual: queda la salida del proceso */
    }
  }
  return salida;
}

let cacheDeComprobacion = null;

/**
 * Si se puede compilar, y con que.
 *
 * No se queda en "existe el binario": compila un documento sonda con el
 * preambulo de verdad, para que un `fancyhdr.sty` que falta se sepa antes de
 * gastar minutos redactando una guia que no iba a terminar en PDF.
 */
export async function comprobarLatex(motor = MOTOR_POR_DEFECTO, { recordar = true } = {}) {
  if (recordar && cacheDeComprobacion?.motor === motor) return cacheDeComprobacion;

  const ruta = await resolverMotor(motor);
  let resultado;

  if (!ruta) {
    resultado = {
      disponible: false,
      motor,
      ruta: null,
      mensaje: `No encontre ${motor} en el PATH. Instala MiKTeX o TeX Live, o declara PLATAFORMA_LATEX_BIN con la ruta al binario.`,
    };
  } else {
    const directorio = fs.mkdtempSync(path.join(os.tmpdir(), "sonda-latex-"));
    try {
      const sonda = `${preambulo(motor)}\n\\pagestyle{fancy}\n\\begin{document}\nsonda\n\\end{document}\n`;
      fs.writeFileSync(path.join(directorio, NOMBRE_TEX), sonda, "utf8");
      const { codigo, salida, motivo } = await ejecutar(ruta, argumentosDe(ruta), {
        cwd: directorio,
        esperaMs: 120_000,
      });
      resultado = codigo === 0
        ? { disponible: true, motor, ruta, mensaje: null }
        : { disponible: false, motor, ruta, mensaje: motivo || motivoDeFalloLatex(leerLog(directorio, salida)) };
    } finally {
      fs.rmSync(directorio, { recursive: true, force: true });
    }
  }

  if (recordar) cacheDeComprobacion = resultado;
  return resultado;
}

/** Para los tests y para cuando se cambia PLATAFORMA_LATEX en caliente. */
export function olvidarComprobacion() {
  cacheDeComprobacion = null;
}

/**
 * Compila una fuente .tex y dice donde quedo el PDF.
 *
 * **Nunca lanza por culpa de LaTeX**: devuelve `{ok:false, motivo}`. Es la
 * condicion para que la plataforma no se caiga cuando el PDF no se puede armar;
 * la guia queda en Markdown y en .tex, y la pantalla lo dice.
 *
 * El directorio de trabajo lo elige quien llama y se borra alla: asi el .aux, el
 * .log y el .toc nunca llegan al vault.
 */
export async function compilar(fuente, {
  directorio,
  esperaMs = ESPERA_POR_DEFECTO_MS,
  motor = MOTOR_POR_DEFECTO,
} = {}) {
  const arranque = Date.now();
  const comprobacion = await comprobarLatex(motor);
  if (!comprobacion.disponible) {
    return { ok: false, motivo: comprobacion.mensaje, log: "" };
  }

  fs.mkdirSync(directorio, { recursive: true });
  fs.writeFileSync(path.join(directorio, NOMBRE_TEX), fuente, "utf8");

  // Dos pasadas solo si hay indice, y se decide mirando la fuente: no es algo
  // que quien llama tenga que saber.
  const pasadas = /\\tableofcontents/.test(fuente) ? 2 : 1;
  let ultima = null;

  for (let pasada = 1; pasada <= pasadas; pasada += 1) {
    ultima = await ejecutar(comprobacion.ruta, argumentosDe(comprobacion.ruta), {
      cwd: directorio,
      esperaMs,
    });
    if (ultima.codigo !== 0) break;
  }

  const log = leerLog(directorio, ultima?.salida || "");
  const pdf = path.join(directorio, NOMBRE_TEX.replace(/\.tex$/, ".pdf"));

  // Los auxiliares se borran aca, una vez leido el log. Quien llama borra el
  // directorio entero igual, pero el contrato de esta funcion es que de LaTeX
  // solo queda el PDF: asi no depende de que el de arriba se acuerde.
  for (const archivo of fs.readdirSync(directorio)) {
    if (/\.(aux|log|out|toc|fls|fdb_latexmk|synctex\.gz)$/i.test(archivo)) {
      fs.rmSync(path.join(directorio, archivo), { force: true });
    }
  }

  if (ultima?.codigo !== 0 || !fs.existsSync(pdf)) {
    return {
      ok: false,
      motivo: ultima?.motivo || motivoDeFalloLatex(log),
      // Del log se guarda la cola: ahi esta el error, y el entero son decenas de
      // miles de lineas que no le sirven a nadie.
      log: log.slice(-2000),
    };
  }

  return { ok: true, pdf, pasadas, ms: Date.now() - arranque, motor: comprobacion.motor };
}
