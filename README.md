# Plataforma de estudio sobre el MCP de Canvas

Proyecto semestral de **INFB6074 — Infraestructura para Ciencia de Datos**, UTEM 2026-2.

[![tests](https://github.com/k0ngan/infra_mcp/actions/workflows/test.yml/badge.svg)](https://github.com/k0ngan/infra_mcp/actions/workflows/test.yml)

Lee Canvas con el MCP que ya está escrito, ordena el material en **un vault de Obsidian por
usuario** y arma **guías de estudio en LaTeX que compila a PDF**. Un modelo local sobre Ollama
redacta la prosa; todo lo demás es código determinístico.

Ese reparto no es un adorno de diseño: **el código elige qué material entra y qué citas lleva
cada sección, y el modelo solo redacta**. Así la herramienta que escribe la guía puede validar
cita por cita —y falla si una no corresponde a material sincronizado— sin que eso se convierta en
una fuente constante de errores. Si el material no cubre el tema, la guía lo dice en vez de
rellenarlo.

> La idea original era darle las herramientas del MCP a un agente para que decidiera cuál llamar.
> No se pudo, y queda escrito por qué en `web/src/agente.mjs`: `llama3.1:8b` sobre Ollama 0.21.2
> no emite `tool_calls`. Terminó siendo mejor así.
>
> Los modelos que usa ahora sí las emiten, así que el canal existe otra vez detrás de
> `PLATAFORMA_TOOLS`, **apagado por defecto**. Lo que no cambió es el reparto: aun con
> herramientas disponibles, quien elige el material es el código. Y lo que un modelo podría ver
> es un subconjunto estricto y más corto de lo permitido (`HERRAMIENTAS_DEL_AGENTE`): nada de
> `canvas_sync_*` ni `canvas_download_*`, que son minutos de red que nadie pidió, y tampoco
> `canvas_write_study_guide`, porque toda la auditabilidad depende de que las citas las escriba
> el código. Hay pruebas que lo verifican.

**Hacia Canvas no sale nada que no hayas confirmado tú.** Durante un buen rato esto decía «nunca
escribe en Canvas», y era más fácil de prometer: `canvas_submit_assignment` estaba prohibida y
listo. La pantalla ahora permite entregar, así que la regla se volvió más estrecha en vez de
desaparecer. Entregar una tarea no se deshace y en varios ramos consume un intento, y eso está
defendido en cuatro capas que no se pisan entre sí:

1. **Dos pasos, y el primero lo exige el MCP.** `canvas_submit_assignment` sin `confirm: true`
   solo valida y devuelve el plan. La pantalla muestra *eso* —la tarea real, el vencimiento, el
   envío previo, el archivo— y recién con un segundo clic entrega. No es una confirmación
   inventada por la plataforma: son los datos que contestó Canvas.
2. **Lo que confirmas es exactamente lo que viste.** Si cambias de tarea, de archivo o de
   comentario después de revisar, la confirmación se invalida y hay que revisar de nuevo. El
   error que esto previene —revisar la tarea 3 y confirmar la 4— es el único que no se puede
   reparar después.
3. **El archivo solo puede salir de tu carpeta.** `CANVAS_UPLOAD_DIR` apunta a una carpeta por
   usuario y el MCP rechaza cualquier ruta de fuera. Antes no se declaraba, y eso era la
   garantía; declararla acotada da una garantía distinta, no menos: una entrega solo puede llevar
   un archivo que esa persona subió por la pantalla, nunca una ruta arbitraria del disco ni la
   tarea de otro.
4. **El modelo nunca la ve.** No está en `HERRAMIENTAS_DEL_AGENTE`, y `llamar()` la rechaza salvo
   que quien llama lo pida explícitamente, así que una ruta nueva no puede entregar por descuido.
   Entregar lo decide una persona, siempre.

Hay catorce pruebas sobre esto en `test/entregas.test.mjs`, y lo que verifican no es que funcione
—eso se ve usándolo— sino que no se entregue sin confirmar, que un nombre con `../` no saque el
archivo de su carpeta, que nadie entregue el archivo de otro y que una extensión que Canvas no
acepta se rechace diciendo cuáles sí. La lista de extensiones la decide el MCP (`.pdf`, `.sql`,
`.pbix`) y esta plataforma **no la amplía**: si una tarea pide otro formato, lo dice y se entrega
a mano.

## Cómo se levanta

```bash
npm run up       # levantar -> http://127.0.0.1:8080
npm run logs     # ver que hace
npm run down     # bajar
```

Eso es todo: `up` prepara las carpetas, construye la imagen si hace falta y deja el contenedor
corriendo. **`down` no borra nada tuyo** — el material, las guías, los usuarios y las cookies de
Canvas viven en el disco del anfitrión, montados como volúmenes; lo único que se va es el
contenedor.

Hace falta Docker. Y **Ollama corriendo en el anfitrión**, no dentro de la imagen: meter los
pesos adentro serían gigas que ya están en el disco y, de paso, le quitaría la GPU. El contenedor
le habla por `host.docker.internal`.

### Sin Docker

```bash
npm ci
npm start                        # http://127.0.0.1:8080
```

Node 18 o superior. **Una sola dependencia**: el MCP de Canvas, fijado por commit en
`package-lock.json`, y que tampoco tiene dependencias propias. No hay paso de compilación y el
frontend es HTML, CSS y JS a mano.

Esa dependencia es nueva y es a propósito. Antes el MCP se buscaba en una carpeta hermana del
disco (`../utem/Pruebas/mcp/mcp_canvas`), que existe en una sola máquina: clonar el repositorio y
correrlo no funcionaba, por más que el proyecto presumiera de «ambiente reproducible». Si esa
carpeta está, se sigue usando para desarrollar; si no, se usa el paquete instalado.

Aquí sí hace falta tener **LaTeX** instalado (MiKTeX o TeX Live) con `pdflatex` en el PATH; en la
imagen ya viene. Si no está, la plataforma no se cae: la guía queda en Markdown y en `.tex`, y la
pantalla dice por qué no hay PDF.

### Lo que comparten las dos formas

`usuarios.json` y `vaults/`, que son los mismos archivos del disco. Lo que no comparten por
defecto son las cookies de Canvas: el contenedor las guarda en `secretos/` y Windows en
`%LOCALAPPDATA%`. Si quieres que sean las mismas, declara `PLATAFORMA_COOKIES=secretos` también
fuera de Docker.

**Las rutas de `usuarios.json` se entienden desde la raíz del proyecto.** Por eso `"vault":
"vaults/franpintoabraham"` significa lo mismo en Windows y dentro del contenedor, y da igual
desde qué carpeta se lance el proceso. Una ruta absoluta sigue funcionando, pero amarra la
configuración a una máquina.

La primera vez no hace falta configurar nada: la pantalla de acceso detecta que no hay usuarios y
pide crear el administrador. Ahí mismo se puede apuntar a un vault de Obsidian que ya exista; si
se deja en blanco, se crea uno vacío en `vaults/<identificador>`.

Las variables de entorno están todas en `.env.example`, con lo que hace cada una. Ninguna es
obligatoria.

El servidor escucha solo en `127.0.0.1` salvo que se declare `PLATAFORMA_HOST` a propósito: la
plataforma guarda sesiones de Canvas de personas reales y no se expone a la red por accidente.

### Qué hay dentro de la imagen

Node fijado y la instalación mínima de LaTeX que compila las guías (`texlive-latex-base`,
`-recommended`, `-lang-spanish`, `-fonts-recommended` y `lmodern`: 816 MB). `texlive-latex-extra`
se deja fuera a propósito, son cientos de megas más, y por eso el documento no usa `enumitem` ni
`booktabs`. El MCP entra por `npm ci`.

El código va **horneado en la imagen**, no montado, para que lo que se prueba sea lo que se
construyó. Después de tocar código hay que reconstruir, que es lo que hace `npm run up`.

Lo que sí se monta, porque es tuyo y tiene que sobrevivir a `down`:

| En el disco | En el contenedor | Qué guarda |
|---|---|---|
| `vaults/` | `/app/vaults` | el material sincronizado y las guías |
| `secretos/` | `/app/secretos` | las cookies de Canvas y las sesiones abiertas |
| `usuarios.json` | `/app/usuarios.json` | los usuarios y los hashes de sus contraseñas |
| `metricas/` | `/app/metricas` | el registro de uso y las respuestas de la encuesta |
| `entregas/` | `/app/entregas` | los archivos subidos para entregar, una carpeta por usuario |

`usuarios.json` tiene que existir **antes** de levantar: un bind mount cuyo origen no existe
Docker lo crea como carpeta, y entonces el servidor muere con un error que no explica nada. De
eso se encarga `npm run preparar`, que `npm run up` ya llama.

## Usuarios

El modelo es el del proyecto ODS: **correo y contraseña, sesión de servidor y roles**
(`admin` y `estudiante`). Dos diferencias, las dos a propósito:

- ODS deriva la contraseña con bcrypt por passlib. Aquí la única dependencia es el MCP, así que se
  usa **scrypt**, que viene en el núcleo de Node y es una función de derivación dura en memoria.
  Lo que no se hace es inventar un hash propio ni usar sha256 pelado.
- La sesión es un **token opaco al azar guardado en el servidor**, entregado en una cookie
  `HttpOnly; SameSite=Strict`. Cerrar sesión la invalida de verdad, y el JavaScript de la página
  nunca puede leer el token.

Un administrador crea usuarios desde la pantalla Usuarios; cualquiera puede registrarse solo desde
la pantalla de acceso, porque el servidor escucha en localhost y quien llega ahí ya está sentado
frente a la máquina. Si alguna vez se publica a una red, `PLATAFORMA_REGISTRO=cerrado` lo cierra.

Un correo equivocado y una contraseña equivocada devuelven **el mismo mensaje**: decir cuál de los
dos falló le regala al que prueba la mitad de la respuesta.

### Un vault por usuario

El MCP no necesitó ningún cambio. `loadConfig(env)` recibe el entorno como argumento y
`createHandler(config)` recibe la configuración ya armada, así que **un usuario no es más que un
entorno distinto**, y dos usuarios nunca comparten estado porque nunca comparten configuración.

Y el usuario con el que se trabaja **sale siempre de la sesión, nunca de un parámetro de la URL**.
Es la diferencia entre «elige con qué vault trabajar» y «entra al tuyo»: con el usuario en la
query, cualquiera leería el material de otro cambiando una palabra.

### La cookie de Canvas

Es una credencial aparte de la cuenta de la plataforma, y se pega en su propia pantalla. **Ese
camino no pasa por el modelo**: guardar una credencial es una operación de dos líneas y meter un
LLM en el medio solo agregaría una forma nueva de equivocarse con la sesión de otra persona.

- Vive **fuera del repositorio**, en
  `%LOCALAPPDATA%\plataforma-estudio\<usuario>\canvas_session` salvo que `usuarios.json` declare
  otra ruta.
- **Nunca se devuelve por la API** ni se escribe en el log ni en el vault. Solo se informa si
  existe, cuánto pesa y cuándo se guardó.
- Al reemplazarla, la anterior queda al lado como `.anterior`: pegar algo mal no puede dejarte
  sin la sesión que sí servía.
- Después de guardarla se prueba contra Canvas y se informa el resultado tal cual. Si Canvas la
  rechaza, lo dice; no se inventa un «guardado con éxito» cuando la sesión sigue muerta.
- **Cada quien pega la suya.** Un administrador tampoco toca la credencial de otro.

El MCP relee el archivo en cada petición, así que no hay que reiniciar nada.

## Guías de estudio

Eliges un ramo y un tema, y sale un PDF armado solo con tu material. El reparto, paso a paso:

1. **El código busca.** `canvas_study_sources` dos veces: una reservada a anuncios y tareas, otra
   general. El cupo aparte no es capricho — el anuncio que dice «la prueba 2 entra hasta la unidad
   IV» pierde siempre contra un PDF largo si compiten por relevancia, y es justo el que responde
   lo que más se pregunta.
2. **El código arma el esqueleto.** Anuncios y tareas juntos en la primera sección, los módulos en
   la suya, el resto una sección por fuente fusionando las cortas. Las fuentes sin texto extraído
   se descartan antes de todo.
3. **El modelo redacta una sección por llamada**, con el material de esa sección y nada más.
   Devuelve prosa: no elige fuentes, no escribe las citas y no decide la estructura.
4. **El código valida y escribe.** Las citas de cada sección son las que el código le pasó, así
   que la validación de `canvas_write_study_guide` no puede fallar por una cita inventada. Si el
   modelo igual cuela un `(archivo:999)` que no existe, se borra antes de imprimir.
5. **Se compila a PDF** con `pdflatex` en una carpeta temporal. El `.aux` y el `.log` nunca entran
   al vault; el `.pdf` y el `.tex` quedan al lado de la nota, que es lo que permite abrirlos desde
   Obsidian y recompilarlos a mano.

Lo que no se puede hacer, se dice:

- **Sin modelo**, la guía se arma igual marcando «solo extractos literales»: el material tal cual,
  rotulado, sin redactar. El pie del PDF declara que no se usó modelo. Y si el modelo se cae a
  mitad, lo que ya se redactó se conserva: el resto sale como extracto, con un aviso, sin que la
  guía espere un timeout por cada sección que falta.
- **Sin LaTeX**, quedan el `.md` y el `.tex` y la pantalla explica por qué no hay PDF.
- **Si el ramo no tiene material con texto**, no se escribe nada: falla diciendo qué falta. Más
  vale eso que un PDF bonito que no dice nada.
- Lo que quedó fuera se cuenta por motivo, en pantalla y en el pie del PDF.

### Qué modelo y por qué

No se eligió de oído: se midió. `scripts/banco-de-modelos.mjs` (`npm run banco`) corre ocho
modelos sobre **once secciones armadas con material real del vault**, de tres ramos distintos, con
`SISTEMA_GUIA` importado del código para que el banco no mida un prompt que ya cambió.

Mide esta tarea y no las de los benchmarks públicos, porque no se parecen: aquí se le pide
**redactar en español de Chile a partir de pasajes dados, sin inventar y obedeciendo instrucciones
negativas** (no escribas el encabezado, no pongas una línea de «Fuentes:», no uses markdown). Un
modelo que programa bien puede ser malísimo en eso.

Las ponderaciones están escritas y razonadas en el archivo: **fidelidad 50, utilidad 30,
formato 15, velocidad 5.** Un modelo rápido que invente una fecha tiene que perder contra uno lento
que no, porque una guía que dice «la prueba es el 28» cuando el anuncio dice 27 hace llegar tarde a
alguien. El formato pesa poco porque el código lo limpia; la velocidad, porque entre 3 y 5 segundos
nadie nota la diferencia.

| Modelo | Peso | Nota | Fiel | Cifras | s/sección | tok/s | En VRAM |
|---|---|---|---|---|---|---|---|
| **`gemma4:e4b`** | 6,1 GiB | ~98 | 100% | **99%** | **1,1** | **149** | 100% |
| `gemma4:12b` | 7,5 GiB | 98,4 | 100% | 95% | 7,1 | 19 | 100% |
| `qwen3.5:9b-q4_K_M` | 6,1 GiB | 98,1 | 100% | 94% | 8,0 | 30 | 84% |
| `qwen3:8b` | 4,9 GiB | 96,1 | 100% | 90% | 8,5 | 25 | 80% |
| `qwen3.5:4b-q4_K_M` | 3,1 GiB | 95,6 | 89% | 96% | 2,1 | 92 | 100% |
| `gemma4:e2b-it-qat` | 4,0 GiB | 95,0 | 89% | 96% | 0,9 | 155 | 100% |
| `granite4:latest` | 2,0 GiB | 91,1 | 89% | 94% | 3,0 | 126 | 100% |
| `llama3.1:latest` | 4,6 GiB | 90,2 | **78%** | 91% | 6,9 | 35 | 87% |

«Fiel» es la proporción de secciones donde no inventó ninguna cifra, ningún mes y ninguna cita.
«Cifras» es cuántas fechas, horas y salas del material sobreviven textuales en la prosa.

**Cuánto confiar en la nota.** Repetida sobre el mismo modelo varía ±1 a 2 puntos, así que una
diferencia menor que eso no significa nada: `gemma4:e4b` midió 97,2 y 99,1 en dos corridas
limpias, y los tres primeros de la tabla están empatados. Lo que **sí** es reproducible corrida a
corrida es la velocidad, la residencia en VRAM y las dos columnas de fidelidad, y ahí las
diferencias son grandes.

> **El banco tuvo un defecto que falseaba sus propios números, y conviene que quede escrito.**
> Mandaba `keep_alive: "15m"` copiando a la plataforma, así que al pasar al modelo siguiente el
> anterior seguía residente y el nuevo entraba en la VRAM que sobraba. El síntoma que lo delató
> fue `gemma4:e4b` midiendo 35 s por sección y 5 tok/s cuando es capaz de 1,1 y 149: había quedado
> `gemma4:12b` ocupando la tarjeta, con 221 MiB libres. Eso explicaba también por qué la misma
> nota se movía hasta ocho puntos según el **orden** en que se corrieran los modelos. Ahora el
> banco descarga todo antes de cada candidato, y todas las cifras de la tabla son de tarjeta
> limpia. La lección es incómoda y vale igual: un banco de pruebas también hay que depurarlo.

Lo que se aprende de la tabla no es qué modelo gana, es **dónde está el filo**. Son dos filos
distintos y no coinciden:

- **La fidelidad se compra con tamaño.** Los cuatro de 4,9 GiB o más no inventaron nada en ninguna
  sección; los tres chicos inventan algo en 1 de cada 9; y `llama3.1` inventa en 2 de cada 9.
- **La velocidad se pierde al salir de la VRAM.** `qwen3:8b`, `qwen3.5:9b` y `llama3.1` no caben
  del todo —80 a 87%— y por eso tardan 7 a 8,5 s por sección. `gemma4:12b` sí cabe entero pero
  llena la tarjeta sin dejar aire y baja a 19 tok/s.

Puesto así, la elección se decide sola: **entre los que no inventan nada, `gemma4:e4b` es seis
veces más rápido que el siguiente**, y además es el que mejor conserva los datos duros (99% contra
95% y 94%). En la sección del calendario de evaluaciones deja las 15 fechas, horas y salas
textuales, mientras `qwen3.5:4b` llegaba a escribir «sala tres cero uno» en vez de «sala 301». Una
guía de estudio sirve justamente por esos datos.

`gemma4:12b` le gana en la nota compuesta por tres décimas, que es menos que el ruido de la propia
medición, y cuesta 7,1 s por sección en vez de 1,1. No compensa.

Y el peor de los ocho es `llama3.1:latest`, que era **el que corría antes de medir nada**: inventó
datos en 2 de 11 secciones.

#### Tres defectos que encontró el banco y que no eran del modelo

Vale la pena anotarlos porque ninguno se habría visto mirando una guía por encima:

1. **La ficha índice del ramo se convertía en sección.** Su texto son enlaces de Obsidian, no
   materia, así que el modelo devolvía o una lista de rutas de archivo copiadas o un párrafo
   explicando que no encontró nada. El código ya lo sabía a medias —`generarGuia` falla con 404 si
   esa ficha es la única fuente con texto—; ahora se excluye siempre.
2. **El encabezado repetido se imprimía debajo del `\section`.** El prompt lo prohíbe y los
   modelos lo escriben igual. `limpiarProsa` ahora lo quita, reconociéndolo con tildes, mayúsculas
   o dos puntos de más.
3. **Un hueco en el propio banco.** Su primera versión le dio 100% de formato a `gemma4:e4b`
   mientras repetía el encabezado en 3 de 10 secciones: la comprobación estaba en el diseño de la
   métrica y no en el código. Con ella puesta, el modelo baja de 99,6 a 98,7, que es el número
   honesto.

#### Dos cosas que conviene saber si se cambia el modelo

- **`num_ctx` se manda explícito, y eso arregló un error que estaba vivo.** No se mandaba nunca,
  así que el modelo corría con la ventana de su modelfile (4096 tokens por defecto). Lo que sobra
  no da error: Ollama lo corta **por adelante**, y por adelante van los anuncios, que el código
  pone primero a propósito. O sea que el recorte se comía justo el material que el orden estaba
  cuidando. Con el material, el historial y la respuesta, ya se pasaba con `llama3.1`.
- **El `razona` del perfil hay que medirlo, no suponerlo**, y rompe en las dos direcciones. A los
  que razonan hay que mandarles `think: false`: sin eso se gastan el presupuesto de tokens pensando
  y devuelven contenido **vacío**, así que cada sección caería a extracto literal sin explicación.
  A los que no razonan no se les puede mandar el campo: Ollama responde 400 con `"llama3.1:latest"
  does not support thinking`. Los dos casos están comprobados contra el Ollama de esta máquina.
  Aparte, el texto pasa por un filtro antes del PDF, y eso no es paranoia: el pensamiento del
  modelo suele repetir las claves de cita que acaba de leer, y esas claves **sí** están permitidas,
  así que el filtro de citas inventadas no las borraría.

> **Inkling 2 Mini**, de Thinking Machines, era el objetivo. No corre en esta máquina y hay dos
> razones independientes: Ollama lo soporta solo en Apple silicon (v0.40.17: *«PC support will
> follow in an upcoming release»*), y el tag oficial pesa 20 GB contra 8 de VRAM y 16 de RAM. Hay
> GGUF de terceros de 13,4 GB que sí cabrían por llama.cpp, pero con los expertos corriendo en
> RAM DDR4 una guía serían minutos por sección. Cuando Ollama saque el soporte para PC, el perfil
> es una entrada más en el registro.

## Qué hay hasta ahora

| | Estado |
|---|---|
| Puente en proceso con el MCP | listo |
| Acceso con correo, contrasena y roles | listo |
| Vault y cookie por usuario | listo |
| Crear, registrar y quitar usuarios | listo |
| Pantalla de material | listo |
| Archivos del ramo y grafo del vault | listo |
| Chat sobre tu propio material | listo |
| Guías en LaTeX → PDF | listo |
| Ambiente en contenedor | listo |
| Encuesta y cuadro de adopción | listo |
| Tareas pendientes y entrega en dos pasos | listo |
| Extracción de texto de los adjuntos | listo |
| Indexación distribuida, Parquet, registro verificable | fase 3 |

La pantalla de material se lee del disco, así que **sigue sirviendo aunque la sesión de Canvas
haya vencido**: muestra lo sincronizado y un aviso explicando qué es lo que no se pudo
actualizar, en vez de una pantalla en blanco.

### Extracción de texto

Hasta hace poco **ningún adjunto aportaba texto**: los PDF y las presentaciones estaban en el
disco pero no se podían leer, y una guía de Grafos se armaba con 14 de 155 fuentes. Las otras 141
eran el límite más grande de la plataforma.

`scripts/extraer-texto.py` lo resuelve. Escribe exactamente lo que el MCP busca —
`<ramo>/Fuentes extraidas/<file_id>.txt`, que es el contrato que está en su `src/study.mjs` — para
cada archivo de `<ramo>/Descargas/`.

```bash
pip install PyMuPDF python-docx python-pptx
python scripts/extraer-texto.py --dry-run     # dice qué haría
python scripts/extraer-texto.py
```

Sobre este vault: **415 adjuntos extraídos, 0 fallos**, 9 sin capa de texto y 50 en formatos que no
son texto (17 vídeos, 19 planillas, 10 imágenes). Y el cambio que importa no es el número: una guía
sobre autómatas pasó de tener secciones tituladas «Vista general del ramo» y «CALENDARIO
EVALUACIONES» a tenerlas tituladas «Teoría de Autómatas. Libro» y «Apuntes Leng Gramáticas
Autómatas», con la definición de máquina de Moore y los ejercicios del capítulo adentro.

Es un paso **opcional y aparte** a propósito. La plataforma declara una sola dependencia de npm y
ningún paso de compilación, y esa promesa es media nota del ramo; extraer PDF, DOCX y PPTX necesita
librerías de Python que la romperían para todo el mundo aunque solo las use quien tenga adjuntos.
La plataforma levanta y arma guías sin esto: lo que cambia al correrlo es cuánto material tienen
esas guías.

**No inventa texto.** Un PDF escaneado no se puede leer sin OCR, y el script no hace OCR: lo deja
anotado y no escribe un `.txt` vacío que haría creer a la plataforma que esa fuente ya se extrajo.

#### Dos cosas que solo aparecieron al extraer

Las dos estaban latentes y ninguna se habría visto sin material de verdad:

- **El índice de un libro no es materia.** Mientras las fuentes eran notas cortas daba igual; con
  un libro de trescientas páginas, su primer pasaje es el índice, y como el tope por fuente recorta
  por el principio, la sección salía enumerando títulos en vez de explicarlos. El umbral para
  detectarlo se midió, no se eligió a ojo: ese índice tiene 30% de líneas con puntos conductores
  —por debajo de cualquier umbral razonable— pero 61% de líneas que son **solo un número**. Sumadas
  dan 90%, contra 5% y 0% de los dos pasajes de materia que venían detrás.
- **Un carácter de control tumbaba el PDF entero.** Están por debajo del tope seguro de
  `escaparLatex`, así que pasaban enteros; un `0x03` en medio de un ejercicio mataba la compilación
  con «Fatal error occurred, no output PDF file produced» y el log solo decía `^^C`. Se filtran en
  los dos sitios: en el extractor y en el generador de LaTeX, que es el último portón antes del PDF.

Por eso la extracción de texto es la primera pieza de la fase 3, y no un ítem del temario: es la
que convierte cientos de archivos descargados en material citable.

## Adopción

Una plataforma que nadie usa no se distingue de una que funciona, si lo único que se mira es que
las pruebas pasen. Las cuatro preguntas que hay que poder contestar son concretas, y el panel
**Adopción** las contesta con datos:

| | Cómo se mide |
|---|---|
| **¿La terminó?** | Hizo los tres pasos del recorrido: pegar la cookie, sincronizar un ramo y generar una guía. El cuadro muestra los tres por separado, así que de quien no llegó se sabe dónde se quedó. |
| **¿Cuánto la usa?** | Guías generadas, sincronizaciones y mensajes de chat. |
| **¿Sigue entrando?** | Días distintos con actividad, cuándo fue la última vez y si estuvo activo en los últimos siete días. «Vuelve» exige **dos días distintos**: entrar diez veces en una tarde y no aparecer nunca más no es retención, es una prueba. |
| **¿Respondió la encuesta?** | Cinco preguntas, una sola obligatoria. Se puede responder de nuevo; se guarda la última y se conserva la fecha de la primera. |

Dos decisiones que vale declarar:

**La guía se cuenta cuando existe, no cuando se pide.** `POST /api/guia` solo encola un trabajo en
segundo plano. Si el evento se registrara ahí, el informe contaría intentos y «terminó» se pondría
en verdadero para alguien que lanzó una guía que falló. El registro va dentro del trabajo y después
del `await`.

**Medir no puede romper la plataforma.** `registrar()` nunca lanza: si el disco está lleno se
pierde el evento y la petición sigue su curso. Es preferible un hueco en la medición a una guía que
no se generó por culpa de una estadística.

### Lo que no se guarda

Esto son datos personales de compañeros de curso: quién entró, cuándo y cuántas veces. Por eso:

- La carpeta `metricas/` está en `.gitignore` y se monta como volumen, igual que `secretos/` y
  `vaults/`. No se versiona y no sale de esta máquina.
- **No se registra contenido.** Ni el tema de una guía, ni lo que se pregunta en el chat, ni qué
  ramo se sincronizó. Solo que la acción ocurrió.
- Los intentos de acceso fallidos no se registran: convertiría el archivo en un rastro de quién se
  equivoca de contraseña.
- El cuadro es **solo para administradores** (`GET /api/metricas` responde 403 a un estudiante).
  Cada quien ve su propia encuesta en `GET /api/encuesta` y nada más.
- El resumen arma cada fila nombrando los campos uno por uno, así que el hash de la contraseña no
  puede colarse. Hay una prueba que lo verifica.

El registro es `metricas/eventos.jsonl`, una línea por evento, que se agrega y no se reescribe: si
el proceso muere a mitad de una escritura se pierde a lo sumo la última línea y las anteriores
siguen siendo legibles.

## Pruebas

```bash
npm test
```

133 pruebas con el runner de Node, sin red, sin Ollama y sin tocar el vault. Lo que cubren es lo
que rompe un PDF en silencio: el escapado de LaTeX (una sola pasada, y ningún codepoint raro
sobrevive), que toda sección salga con al menos una cita y que todas vengan del material, que una
cita inventada se descarte, y que `canvas_submit_assignment` siga prohibida. La única que necesita
LaTeX instalado se salta sola si no está.

Las del modelo corren contra un Ollama de mentira —un servidor `node:http` en un puerto al azar,
no un `fetch` parcheado— así que se ejercita el `fetch` de verdad y los códigos de estado de
verdad sin que haya ningún modelo bajado. Cubren que la petición lleve `num_ctx` (ver abajo), que
el razonamiento del modelo no llegue nunca al PDF, que un modelo caído se intente una vez y no
una por sección, y que tener `qwen3.5:4b-q4_K_M` bajado con `qwen3.5:4b` configurado cuente como
disponible.

Las quince de adopción cubren lo que haría quedar mal al informe: que medir tumbe una
petición, que quien se registró y nunca volvió desaparezca del cuadro —justo el que hay que
mirar—, que «terminó» se ponga en verdadero sin haber generado una guía, y que el resumen
arrastre el hash de una contraseña.

Y corren **fuera de esta máquina** en cada push: `.github/workflows/test.yml` las pasa en Node 18
y en Node 24, los dos extremos del rango que declara `engines`. Es la parte verificable de
«ambiente reproducible»: si clonar el repositorio y correrlo solo funciona en el portátil donde se
escribió, no era reproducible. Ahí no hay LaTeX a propósito, así que la prueba que compila de
verdad se salta sola —eso ya lo cubre la imagen de Docker.

## Diseño visual

**La pantalla se parece a lo que la plataforma fabrica.** Lo que sale de aquí son guías
tipografiadas en LaTeX y un vault de Obsidian: documentos. Durante un tiempo la pantalla fue otra
cosa —un panel de control con lienzo gris, cards blancas con sombra, cabecera en degradado y seis
variantes distintas de píldora de 999 px—, que es exactamente lo primero que sale cuando una
aplicación tiene nueve secciones y tablas. Se notaba que era lo primero que salió.

Ahora es un impreso: filetes de 1 px en vez de cajas, un **índice numerado** en lugar de una barra
de pestañas, y el blanco puesto donde separa. La estructura —lateral, barra superior, paneles— se
queda como estaba, porque para nueve secciones funciona; lo que cambió es el tratamiento.

**Tres valores y se acabó: papel, tinta y un acento.** La tinta es el `#021C36` de la UTEM y el
acento su azul `#004E9A`. No hay verde de «bien» ni rojo de «mal»: el estado se dice con la palabra
escrita, con versalitas y con un punto lleno o hueco. Lo único que grita es el error, y grita
invirtiéndose a tinta plena, que destaca más que cualquier rojo y no gasta un color de la paleta.
El verde `#7AB82F` de la marca quedó fuera: con tres valores en total no caben dos acentos.

> Los colores vienen de Brandfetch, no del manual oficial: el PDF del Manual de Identidad Visual
> 2025 que publica utem.cl responde 404 y la página de identidad no lista códigos. Si el manual
> dice otra cosa, se cambian los `--utem-*` en `estilo.css`.

**Palatino para la estructura, Cascadia o Consolas para el dato.** Ninguna se trae por CDN —la
plataforma tiene que levantar sin red—, así que se elige dentro de lo que ya está instalado:
`ui-serif` resuelve Palatino en Apple y «Palatino Linotype» en Windows. Es una serif de libro de
verdad, no la Georgia que sale por descarte. La monoespaciada va donde hay dato —rótulos, cifras,
rutas, identificadores y los propios botones—, que es donde significa algo, y no como disfraz de
«esto es técnico». No hay sans, a propósito: serif + monoespaciada es la pareja de un documento
técnico, que es justo lo que esto produce.

El único sitio con más de tres tonos es el **grafo**, y es inevitable: seis tipos de nota necesitan
seis marcas distinguibles. Antes eran un arcoíris de seis colores sin relación entre sí; ahora
salen todos del mismo eje azul-tinta y se distinguen por claridad, salvo el anuncio —el tipo que
avisa— que lleva el único ocre.

Todo en CSS plano, sin Tailwind y sin paso de compilación: el proyecto no tiene más dependencia que
el MCP y no iba a sumar una para pintar botones. El modo oscuro va por `[data-theme]` y **ningún
texto baja de 4,5:1 de contraste en ninguno de los dos temas**, medido sobre la página.

## Estructura

```
web/src/servidor.mjs        http nativo de Node, sirve public/ y la API
web/src/auth.mjs            scrypt, sesiones de servidor y cookie HttpOnly
web/src/usuarios.mjs        usuarios, roles y un vault por cada uno
web/src/canvas.mjs          puente en proceso al MCP + lista de herramientas permitidas
web/src/cookie.mjs          guardar y probar la cookie de sesion, sin pasar por el modelo
web/src/sincronizacion.mjs  traer los ramos, uno por uno y con reintentos
web/src/trabajos.mjs        trabajos en segundo plano con avance consultable
web/src/vault.mjs           leer el vault: contenido del ramo, notas y grafo
web/src/agente.mjs          el modelo local; el codigo busca, el modelo redacta
web/src/guias.mjs           el pipeline de la guia: fuentes, secciones, citas
web/src/latex.mjs           escapado, plantilla y compilacion a PDF
web/src/metricas.mjs        adopcion: quien termino, cuanto usa, si vuelve, si respondio
web/src/entregas.mjs        entregar en Canvas, en dos pasos y acotado a tu carpeta
web/public/                 la pagina: HTML, CSS y JS a mano
scripts/extraer-texto.py    convierte los adjuntos en texto citable (opcional, Python)
scripts/banco-de-modelos.mjs  mide que modelo sirve para esta tarea (npm run banco)
test/                       node --test, sin red y sin vault
Dockerfile                  Node fijado + la instalacion minima de LaTeX
docker-compose.yml          el servicio web; Ollama se queda en el anfitrion
.env.example                todas las variables, con lo que hace cada una
usuarios.example.json       plantilla de configuracion (usuarios.json no se versiona)
.github/workflows/         los tests en Node 18 y 24, en cada push
```

## Lo que no entra al repositorio

Cookies de Canvas, claves de sesión y tokens. Ni en el código, ni en la documentación, ni en los
comandos registrados. `usuarios.json` está en `.gitignore` porque guarda los hashes de las
contraseñas; las cookies de Canvas no están ahí ni en ninguna parte del repositorio.

## Licencia

MIT, en `LICENSE`. El material de clase que la plataforma ordena **no** lo cubre: eso es de quien
lo escribió, vive en el vault de cada persona y no se versiona.
