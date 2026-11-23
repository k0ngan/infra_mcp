/**
 * Lo que se prueba aca es lo que rompe un PDF en silencio: un escapado que se
 * come a si mismo, un simbolo Unicode que aborta la compilacion, una fecha
 * corrida por la zona horaria y un argumento que cuelga el proceso esperando a
 * una persona.
 *
 * Nada de esto toca la red, ni Ollama, ni el vault. La unica prueba que necesita
 * LaTeX instalado se salta sola si no esta.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  argumentosDe,
  comprobarLatex,
  compilar,
  cuerpoALatex,
  documentoDeGuia,
  escaparLatex,
  fechaEnPalabras,
  motivoDeFalloLatex,
} from "../web/src/latex.mjs";

/* ───────── escaparLatex ───────── */

test("un caracter de control no tumba el PDF entero", () => {
  /*
   * Estaban por debajo del tope seguro, asi que pasaban enteros. Mientras las
   * fuentes eran notas de Canvas no aparecia ninguno; desde que se extrae el
   * texto de los PDF vienen dentro, y un 0x03 en medio de un ejercicio mato una
   * compilacion entera: "Fatal error occurred, no output PDF file produced".
   */
  const control = c => String.fromCharCode(c);
  const conControl = `Demuestre${control(3)} que${control(0)} para todo n${control(31)} mayor que 0.`;
  const escapado = escaparLatex(conControl);

  const quedanControles = [...escapado].some(caracter => {
    const punto = caracter.codePointAt(0);
    return (punto < 0x20 && punto !== 0x0a && punto !== 0x09) || (punto >= 0x7f && punto <= 0x9f);
  });
  assert.ok(!quedanControles, "no puede quedar ningun caracter de control");
  assert.equal(escapado, "Demuestre que para todo n mayor que 0.");
});

test("el salto de linea y el tabulador si sobreviven", () => {
  // Son los dos controles que significan algo dentro de un documento.
  assert.equal(escaparLatex("uno\ndos"), "uno\ndos");
  assert.equal(escaparLatex("uno\tdos"), "uno\tdos");
});

test("escapa cada caracter especial de LaTeX", () => {
  assert.equal(escaparLatex("{"), "\\{");
  assert.equal(escaparLatex("}"), "\\}");
  assert.equal(escaparLatex("$"), "\\$");
  assert.equal(escaparLatex("&"), "\\&");
  assert.equal(escaparLatex("#"), "\\#");
  assert.equal(escaparLatex("%"), "\\%");
  assert.equal(escaparLatex("_"), "\\_");
  assert.equal(escaparLatex("^"), "\\textasciicircum{}");
  assert.equal(escaparLatex("~"), "\\textasciitilde{}");
  assert.equal(escaparLatex("\\"), "\\textbackslash{}");
});

test("escapa en una sola pasada: las llaves que introduce no se vuelven a escapar", () => {
  // Es la regresion que atrapa el escapado en cadena. Con replace encadenados,
  // el \textbackslash{} de la primera pasada queda destrozado por la de llaves.
  assert.equal(escaparLatex("a\\b{c}"), "a\\textbackslash{}b\\{c\\}");
});

test("no es idempotente, y es a proposito", () => {
  const una = escaparLatex("100%");
  assert.equal(una, "100\\%");
  // Escapar dos veces produce otra cosa. Se escapa UNA vez, en el borde.
  assert.notEqual(escaparLatex(una), una);
});

test("aguanta texto real de un PDF de matematicas", () => {
  assert.equal(
    escaparLatex("f(x)=x^2_i, 100% & 50#"),
    "f(x)=x\\textasciicircum{}2\\_i, 100\\% \\& 50\\#",
  );
});

test("vacio, null y undefined dan cadena vacia", () => {
  assert.equal(escaparLatex(""), "");
  assert.equal(escaparLatex(null), "");
  assert.equal(escaparLatex(undefined), "");
});

test("translitera la puntuacion y los simbolos que inputenc no sabe imprimir", () => {
  assert.equal(escaparLatex("…"), "\\ldots{}");
  assert.equal(escaparLatex("—"), "---");
  assert.equal(escaparLatex("≤"), "$\\leq$");
  assert.equal(escaparLatex("∈"), "$\\in$");
  assert.equal(escaparLatex("⊆"), "$\\subseteq$");
  assert.equal(escaparLatex("Σ"), "$\\Sigma$");
  assert.equal(escaparLatex("α"), "$\\alpha$");
  assert.equal(escaparLatex("→"), "$\\rightarrow$");
});

test("las acentuadas y la ñ pasan intactas: T1 las imprime", () => {
  assert.equal(escaparLatex("ñáéíóúü ÁÉÍÓÚÜÑ"), "ñáéíóúü ÁÉÍÓÚÜÑ");
});

test("ningun codepoint sobre U+024F sobrevive al escapado", () => {
  // La valvula de seguridad. Un emoji en un anuncio no puede tumbar un PDF, y
  // tampoco un simbolo exotico que no este en la tabla.
  let entrada = "";
  for (let i = 0; i < 200; i += 1) entrada += String.fromCodePoint(0x2500 + i * 7);

  for (const caracter of escaparLatex(entrada)) {
    assert.ok(caracter.codePointAt(0) <= 0x024f, `sobrevivio ${JSON.stringify(caracter)}`);
  }
  assert.equal(escaparLatex("🙂"), "");
});

/* ───────── cuerpoALatex ───────── */

test("los parrafos se separan y las vinetas se agrupan en un itemize", () => {
  const salida = cuerpoALatex("Primer parrafo.\n\n- uno\n- dos\n\nUltimo.");
  assert.match(salida, /\\begin\{itemize\}/);
  assert.match(salida, /\\item uno/);
  assert.match(salida, /\\item dos/);
  assert.match(salida, /\\end\{itemize\}/);
  assert.match(salida, /Primer parrafo\./);
  assert.match(salida, /Ultimo\./);
});

test("el cuerpo tambien se escapa", () => {
  assert.match(cuerpoALatex("el 50% de los casos"), /50\\%/);
});

test("una vineta que empieza con corchete no se come el texto como etiqueta", () => {
  // El caso real: un extracto literal con enlaces de Obsidian. Sin el grupo,
  // \item lee "[[Canvas/...]" como etiqueta opcional y, si el texto venia
  // recortado con "…", la compilacion muere con un runaway argument.
  const salida = cuerpoALatex("- [[Canvas/Segundo semestre 2026/Modulo 2…");
  assert.match(salida, /\\item \{\}\[\[Canvas/);
});

test("una vineta normal no lleva el grupo de mas", () => {
  assert.match(cuerpoALatex("- repasar la unidad 2"), /\\item repasar/);
});

/* ───────── fechaEnPalabras ───────── */

test("escribe la fecha en palabras sin correrse de dia", () => {
  // Con new Date("2026-11-05") y getDate() local, en Chile esto da el 4.
  assert.equal(fechaEnPalabras("2026-11-05"), "jueves 5 de noviembre de 2026");
  assert.equal(fechaEnPalabras("2026-01-01"), "jueves 1 de enero de 2026");
  assert.equal(fechaEnPalabras("2026-12-31"), "jueves 31 de diciembre de 2026");
});

test("una fecha que no es fecha devuelve null, no 'Invalid Date'", () => {
  assert.equal(fechaEnPalabras("no-es-fecha"), null);
  assert.equal(fechaEnPalabras(""), null);
  assert.equal(fechaEnPalabras(null), null);
  assert.equal(fechaEnPalabras("5 de noviembre"), null);
});

/* ───────── documentoDeGuia ───────── */

const seccion = (encabezado, fuentes = ["anuncio:1"]) => ({
  encabezado,
  cuerpo: "Un cuerpo cualquiera, largo lo justo.",
  fuentes,
});

const guiaMinima = (extra = {}) => ({
  titulo: "Guia de prueba",
  ramo: "Grafos y Lenguajes Formales",
  courseId: 31151,
  tema: "automatas",
  secciones: [seccion("Primera")],
  citas: [{ cita: "anuncio:1", titulo: "Fecha Prueba 2", tipo: "anuncio" }],
  modelo: "llama3.1:latest",
  ...extra,
});

test("el documento trae portada, una seccion por entrada y el material citado", () => {
  const tex = documentoDeGuia(guiaMinima({
    secciones: [seccion("Primera"), seccion("Segunda")],
  }));

  assert.match(tex, /\\documentclass/);
  assert.match(tex, /\\begin\{document\}/);
  assert.match(tex, /\\end\{document\}/);
  assert.match(tex, /Grafos y Lenguajes Formales/);
  assert.match(tex, /Tema: automatas/);
  assert.match(tex, /\\section\{Primera\}/);
  assert.match(tex, /\\section\{Segunda\}/);
  assert.match(tex, /Material citado/);
  assert.match(tex, /anuncio:1/);
});

test("el indice aparece recien con cuatro secciones", () => {
  const con = n => documentoDeGuia(guiaMinima({
    secciones: Array.from({ length: n }, (_, i) => seccion(`S${i}`)),
  }));

  assert.doesNotMatch(con(3), /\\tableofcontents/);
  assert.match(con(4), /\\tableofcontents/);
});

test("el pie dice de donde sale todo y nombra el modelo", () => {
  const tex = documentoDeGuia(guiaMinima());
  assert.match(tex, /sale de tu propio material de Canvas/);
  assert.match(tex, /llama3\.1:latest/);
});

test("sin modelo, el pie lo dice en vez de callarlo", () => {
  const tex = documentoDeGuia(guiaMinima({ modelo: null }));
  assert.match(tex, /no se uso ningun modelo/);
});

test("los avisos de lo que quedo fuera llegan al PDF", () => {
  const tex = documentoDeGuia(guiaMinima({ avisos: ["141 fuentes sin texto extraido."] }));
  assert.match(tex, /141 fuentes sin texto extraido\./);
});

test("un titulo con & y un encabezado con _ salen escapados", () => {
  const tex = documentoDeGuia(guiaMinima({
    titulo: "Prueba & error",
    secciones: [seccion("Unidad_2")],
  }));
  assert.match(tex, /Prueba \\& error/);
  assert.match(tex, /\\section\{Unidad\\_2\}/);
});

test("por defecto no se usa fontspec: el PDF se tiene que poder recompilar en otra maquina", () => {
  assert.doesNotMatch(documentoDeGuia(guiaMinima()), /fontspec/);
  assert.match(documentoDeGuia(guiaMinima({ motor: "xelatex" })), /fontspec/);
});

test("una guia sin secciones no se imprime", () => {
  assert.throws(() => documentoDeGuia(guiaMinima({ secciones: [] })), /sin secciones/);
});

/* ───────── argumentosDe ───────── */

test("los argumentos son un arreglo, nunca una cadena de shell", () => {
  const argumentos = argumentosDe("/usr/bin/pdflatex");
  assert.ok(Array.isArray(argumentos));
  assert.ok(argumentos.includes("-interaction=nonstopmode"));
  assert.ok(argumentos.includes("-halt-on-error"));
  assert.equal(argumentos.at(-1), "guia.tex");
});

test("-disable-installer solo con MiKTeX", () => {
  // Sin esto, MiKTeX abre el dialogo del instalador y el proceso queda colgado
  // para siempre. En TeX Live el argumento no existe y abortaria la corrida.
  assert.ok(argumentosDe("C:/x/miktex/bin/x64/pdflatex.exe").includes("-disable-installer"));
  assert.ok(!argumentosDe("/usr/bin/pdflatex").includes("-disable-installer"));
});

/* ───────── motivoDeFalloLatex ───────── */

test("del log sale un motivo que se puede leer en pantalla", () => {
  assert.match(
    motivoDeFalloLatex("! LaTeX Error: File `fancyhdr.sty' not found."),
    /fancyhdr\.sty/,
  );
  assert.match(
    motivoDeFalloLatex("guia.tex:12: ! Undefined control sequence."),
    /Undefined control sequence/,
  );
});

test("un log vacio no devuelve undefined", () => {
  const motivo = motivoDeFalloLatex("");
  assert.equal(typeof motivo, "string");
  assert.ok(motivo.length > 0);
});

/* ───────── compilar (solo si hay LaTeX) ───────── */

const hayLatex = (await comprobarLatex()).disponible;

test("compila de verdad y no deja basura", { skip: !hayLatex }, async () => {
  const directorio = fs.mkdtempSync(path.join(os.tmpdir(), "prueba-latex-"));
  try {
    const resultado = await compilar(documentoDeGuia(guiaMinima()), { directorio });
    assert.equal(resultado.ok, true, resultado.motivo);
    assert.ok(fs.existsSync(resultado.pdf));

    const sobras = fs.readdirSync(directorio).filter(n => /\.(aux|toc|out)$/.test(n));
    assert.deepEqual(sobras, [], "quedaron auxiliares que no deberian salir del directorio de trabajo");
  } finally {
    fs.rmSync(directorio, { recursive: true, force: true });
  }
});

test("sin motor de LaTeX devuelve ok:false en vez de lanzar", async () => {
  const directorio = fs.mkdtempSync(path.join(os.tmpdir(), "prueba-latex-"));
  try {
    const resultado = await compilar("\\documentclass{article}\\begin{document}x\\end{document}", {
      directorio,
      motor: "motor-que-no-existe",
    });
    assert.equal(resultado.ok, false);
    assert.match(resultado.motivo, /No encontre motor-que-no-existe/);
  } finally {
    fs.rmSync(directorio, { recursive: true, force: true });
  }
});
