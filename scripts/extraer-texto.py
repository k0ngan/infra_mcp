"""Convierte los adjuntos descargados en texto citable.

Es la pieza que le faltaba a la plataforma para que las guias valgan algo. El
sincronizador baja los PDF, las presentaciones y los documentos a
`<ramo>/Descargas/`, pero ahi dentro son binarios: `canvas_study_sources` no
puede leerlos y los reporta como «sin texto extraido». En Grafos eso significaba
que una guia se armaba con 14 de 155 fuentes, y las otras 141 estaban en el disco
sin poder usarse.

El contrato con el MCP es exacto y esta en su codigo (`src/study.mjs`): para una
fuente con `file_id`, busca

    <carpeta del ramo>/Fuentes extraidas/<file_id>.txt

y si no esta, la fuente queda fuera de la guia. Asi que este script no inventa un
formato: escribe justo ese archivo, con ese nombre, en ese sitio.

    python scripts/extraer-texto.py                  todos los vaults
    python scripts/extraer-texto.py --usuario pepe   solo el de esa persona
    python scripts/extraer-texto.py --dry-run        dice que haria y no escribe
    python scripts/extraer-texto.py --rehacer        rehace los que ya existen

───────── Por que esta aparte y no dentro de la plataforma ─────────

La plataforma declara UNA dependencia de npm y ningun paso de compilacion, y esa
promesa es media nota del ramo. Extraer texto de PDF, DOCX y PPTX necesita
librerias que no se escriben en una tarde, asi que meterlas romperia esa promesa
para todos aunque solo las use quien tenga adjuntos.

Por eso es un paso OPCIONAL y aparte: la plataforma levanta y arma guias sin
esto. Lo que cambia al correrlo es cuanto material tienen esas guias.

Necesita Python 3.9+ y:

    pip install PyMuPDF python-docx python-pptx

───────── Que NO hace ─────────

No inventa texto. Un PDF escaneado —imagenes de paginas, sin capa de texto— no
se puede leer sin OCR, y este script no hace OCR: lo deja anotado como
`ocr_pendiente` y no escribe un .txt vacio que haria creer a la plataforma que la
fuente si se extrajo. Mentir ahi seria peor que no extraer.
"""

from __future__ import annotations

import argparse
import sys
import unicodedata
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent

# El MCP usa este nombre exacto de carpeta. No es decorativo: si cambia, la
# plataforma deja de encontrar el texto y vuelve a decir «sin texto extraido».
CARPETA_EXTRAIDAS = "Fuentes extraidas"
CARPETA_DESCARGAS = "Descargas"

# Debajo de esto no es texto: es el residuo de un PDF escaneado o de una
# presentacion de puras imagenes. Se marca para OCR en vez de escribirlo.
MINIMO_UTIL = 40


def dependencias():
    """Las librerias, importadas tarde para poder explicar que falta."""
    faltan = []
    try:
        import fitz  # noqa: F401
    except ImportError:
        faltan.append("PyMuPDF")
    try:
        import docx  # noqa: F401
    except ImportError:
        faltan.append("python-docx")
    try:
        import pptx  # noqa: F401
    except ImportError:
        faltan.append("python-pptx")

    if faltan:
        print(f"Faltan librerias: {', '.join(faltan)}", file=sys.stderr)
        print(f"  pip install {' '.join(faltan)}", file=sys.stderr)
        sys.exit(1)


def texto_de_pdf(ruta: Path) -> str:
    import fitz

    with fitz.open(ruta) as pdf:
        if not pdf.page_count:
            return ""
        return "\n\n".join(pagina.get_text() for pagina in pdf)


def texto_de_docx(ruta: Path) -> str:
    from docx import Document

    documento = Document(ruta)
    partes = [p.text for p in documento.paragraphs]
    # Las tablas tambien son contenido: en los temarios suele estar ahi la
    # informacion que mas se busca, como las fechas y las ponderaciones.
    for tabla in documento.tables:
        for fila in tabla.rows:
            partes.append(" | ".join(celda.text for celda in fila.cells))
    return "\n".join(partes)


def texto_de_pptx(ruta: Path) -> str:
    from pptx import Presentation

    presentacion = Presentation(ruta)
    partes = []
    for numero, lamina in enumerate(presentacion.slides, start=1):
        partes.append(f"[Lamina {numero}]")
        for figura in lamina.shapes:
            if figura.has_text_frame:
                partes.append(figura.text_frame.text)
            # Una tabla en una lamina suele ser el calendario del ramo.
            if getattr(figura, "has_table", False):
                for fila in figura.table.rows:
                    partes.append(" | ".join(c.text for c in fila.cells))
    return "\n".join(partes)


def texto_plano(ruta: Path) -> str:
    return ruta.read_text(encoding="utf-8", errors="replace")


EXTRACTORES = {
    ".pdf": texto_de_pdf,
    ".docx": texto_de_docx,
    ".pptx": texto_de_pptx,
}

# Lo que ya es texto se lee tal cual. El codigo fuente y los .tex que sube un
# profesor son material de estudio como cualquier apunte.
for _extension in (".txt", ".md", ".csv", ".sql", ".tex", ".cpp", ".c", ".h",
                   ".py", ".java", ".r", ".m", ".json", ".xml"):
    EXTRACTORES[_extension] = texto_plano

# Lo que NO se extrae, y por que:
#   .mp4 y companía  video, haria falta transcribir
#   .xlsx .xls .xlsm planillas; pedirian otra libreria y rara vez son material
#                    de estudio (suelen ser notas y listados)
#   .png .jpg        imagenes, harian falta OCR
#   .rar             comprimido
#   .ipynb           NO hace falta: el MCP ya lo lee directo de Descargas
#                    (`leerDescargaDirecta` en su study.mjs)


def limpiar(texto: str) -> str:
    """Normaliza lo justo para que el texto sea citable.

    Los PDF traen saltos de linea en mitad de las frases, por el ancho de la
    columna, y ligaduras tipograficas que no coinciden al buscar un termino.
    """
    texto = unicodedata.normalize("NFKC", texto)
    # Los PDF traen caracteres de control sueltos entre el texto. Un 0x03 en
    # medio de un ejercicio mataba la compilacion del PDF de la guia entera, y
    # el log de LaTeX solo decia `^^C`. Se van aca, en el origen, aunque el
    # generador de LaTeX tambien los filtre por su cuenta.
    texto = "".join(
        c for c in texto
        if c in "\n\t" or not unicodedata.category(c).startswith("C")
    )
    lineas = [linea.rstrip() for linea in texto.splitlines()]
    # Tres o mas lineas en blanco seguidas no separan nada.
    limpio = []
    vacias = 0
    for linea in lineas:
        if linea.strip():
            vacias = 0
            limpio.append(linea)
        else:
            vacias += 1
            if vacias <= 1:
                limpio.append("")
    return "\n".join(limpio).strip()


def id_del_archivo(nombre: str) -> str | None:
    """El `file_id` que el sincronizador pone de prefijo: "1230863-Unidad+2.pdf"."""
    if "-" not in nombre:
        return None
    posible = nombre.split("-", 1)[0]
    return posible if posible.isdigit() else None


def ramos_de(vault: Path):
    """Las carpetas de ramo: las que tienen Descargas adentro."""
    for descargas in sorted(vault.rglob(CARPETA_DESCARGAS)):
        if descargas.is_dir():
            yield descargas.parent


def procesar(ramo: Path, *, rehacer: bool, dry_run: bool) -> dict:
    descargas = ramo / CARPETA_DESCARGAS
    destino = ramo / CARPETA_EXTRAIDAS
    cuenta = {"extraidos": 0, "ya_estaban": 0, "ocr_pendiente": 0, "sin_soporte": 0, "fallaron": 0}
    pendientes_de_ocr = []

    for archivo in sorted(descargas.iterdir()):
        if not archivo.is_file():
            continue

        file_id = id_del_archivo(archivo.name)
        if file_id is None:
            continue

        extractor = EXTRACTORES.get(archivo.suffix.lower())
        if extractor is None:
            cuenta["sin_soporte"] += 1
            continue

        salida = destino / f"{file_id}.txt"
        if salida.exists() and not rehacer:
            cuenta["ya_estaban"] += 1
            continue

        try:
            texto = limpiar(extractor(archivo))
        except Exception as error:  # noqa: BLE001
            cuenta["fallaron"] += 1
            print(f"    ! {archivo.name}: {type(error).__name__}: {error}")
            continue

        if len(texto) < MINIMO_UTIL:
            # Escribir un .txt casi vacio seria peor que no escribirlo: la
            # plataforma creeria que la fuente ya esta extraida y la ofreceria
            # como material.
            cuenta["ocr_pendiente"] += 1
            pendientes_de_ocr.append(archivo.name)
            continue

        if not dry_run:
            destino.mkdir(parents=True, exist_ok=True)
            salida.write_text(texto, encoding="utf-8")
        cuenta["extraidos"] += 1

    cuenta["pendientes_de_ocr"] = pendientes_de_ocr
    return cuenta


def main() -> int:
    parser = argparse.ArgumentParser(description="Extrae el texto de los adjuntos del vault.")
    parser.add_argument("--usuario", help="solo el vault de ese usuario")
    parser.add_argument("--vaults", default="vaults", help="carpeta de vaults (por defecto: vaults)")
    parser.add_argument("--rehacer", action="store_true", help="rehace los que ya existen")
    parser.add_argument("--dry-run", action="store_true", help="dice que haria y no escribe")
    args = parser.parse_args()

    dependencias()

    base = (RAIZ / args.vaults).resolve()
    if not base.is_dir():
        print(f"No existe la carpeta de vaults: {base}", file=sys.stderr)
        return 1

    vaults = [base / args.usuario] if args.usuario else [d for d in sorted(base.iterdir()) if d.is_dir()]

    total = {"extraidos": 0, "ya_estaban": 0, "ocr_pendiente": 0, "sin_soporte": 0, "fallaron": 0}
    ocr = []

    for vault in vaults:
        if not vault.is_dir():
            print(f"No existe el vault: {vault}", file=sys.stderr)
            return 1

        ramos = list(ramos_de(vault))
        if not ramos:
            continue
        print(f"\n{vault.name}: {len(ramos)} ramos con adjuntos")

        for ramo in ramos:
            cuenta = procesar(ramo, rehacer=args.rehacer, dry_run=args.dry_run)
            ocr += cuenta.pop("pendientes_de_ocr")
            for clave in total:
                total[clave] += cuenta[clave]
            if cuenta["extraidos"] or cuenta["ocr_pendiente"] or cuenta["fallaron"]:
                print(
                    f"  {ramo.name[:60]:<60} "
                    f"{cuenta['extraidos']:>3} extraidos  "
                    f"{cuenta['ocr_pendiente']:>2} sin capa de texto  "
                    f"{cuenta['fallaron']:>2} fallaron"
                )

    print(f"\n{'(dry-run) ' if args.dry_run else ''}Resumen")
    print(f"  extraidos          {total['extraidos']}")
    print(f"  ya estaban         {total['ya_estaban']}")
    print(f"  sin capa de texto  {total['ocr_pendiente']}  (hacen falta OCR; no se escribio nada)")
    print(f"  formato no leible  {total['sin_soporte']}")
    print(f"  fallaron           {total['fallaron']}")

    if ocr:
        # Se nombran en vez de contarlos y ya: para saber si lo que falta es un
        # anexo cualquiera o la clase entera de una unidad.
        print("\nSin capa de texto (necesitan OCR):")
        for nombre in ocr[:15]:
            print(f"  {nombre}")
        if len(ocr) > 15:
            print(f"  ... y {len(ocr) - 15} mas")

    return 0


if __name__ == "__main__":
    sys.exit(main())
