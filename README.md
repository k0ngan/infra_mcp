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

**Es solo para estudiar: nunca escribe en Canvas.** La herramienta `canvas_submit_assignment`
no está en la lista de permitidas (`web/src/canvas.mjs`) y el entorno que se le arma a cada
usuario no declara `CANVAS_UPLOAD_DIR`, así que el MCP tampoco podría subir nada aunque alguien
la invocara. Entregar una tarea no se deshace y en varios ramos consume un intento; esa decisión
se toma en Canvas, a mano.

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

Hace falta Docker. Y **Ollama corriendo en el anfitrión**, no dentro de la imagen: meter
`llama3.1` adentro serían 4,9 GB de pesos que ya están en el disco y, de paso, le quitaría la
GPU. El contenedor le habla por `host.docker.internal`.

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

- **Sin Ollama**, la guía se arma igual marcando «solo extractos literales»: el material tal cual,
  rotulado, sin redactar. El pie del PDF declara que no se usó modelo.
- **Sin LaTeX**, quedan el `.md` y el `.tex` y la pantalla explica por qué no hay PDF.
- **Si el ramo no tiene material con texto**, no se escribe nada: falla diciendo qué falta. Más
  vale eso que un PDF bonito que no dice nada.
- Lo que quedó fuera se cuenta por motivo, en pantalla y en el pie del PDF.

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
| Indexación distribuida, Parquet, registro verificable | fase 3 |

La pantalla de material se lee del disco, así que **sigue sirviendo aunque la sesión de Canvas
haya vencido**: muestra lo sincronizado y un aviso explicando qué es lo que no se pudo
actualizar, en vez de una pantalla en blanco.

### Lo que falta y por qué importa

Hoy **ningún adjunto aporta texto**: el vault no tiene carpetas `Fuentes extraidas/`, así que los
PDF y las presentaciones existen pero no se pueden leer, y las guías salen solo de notas Markdown
(anuncios, tareas, módulos y páginas). La plataforma lo informa en vez de disimularlo —en la
pantalla de Archivos, en el aviso de la guía y en el pie del PDF— pero sigue siendo el límite más
grande que tiene ahora mismo.

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

70 pruebas con el runner de Node, sin red, sin Ollama y sin tocar el vault. Lo que cubren es lo
que rompe un PDF en silencio: el escapado de LaTeX (una sola pasada, y ningún codepoint raro
sobrevive), que toda sección salga con al menos una cita y que todas vengan del material, que una
cita inventada se descarte, y que `canvas_submit_assignment` siga prohibida. La única que necesita
LaTeX instalado se salta sola si no está.

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

La estructura es la del proyecto ODS: los mismos tokens HSL, el lienzo gris con cards blancas y
bordes marcados, la barra lateral con cabecera en degradado y el modo oscuro por `[data-theme]`.
Va en CSS plano: el proyecto no tiene mas dependencia que el MCP, y no iba a
sumar uno para pintar botones.

La marca, en cambio, es de la UTEM: azul institucional `#004E9A`, verde `#7AB82F` y `#021C36` para
los fondos profundos. **Esos valores vienen de Brandfetch, no del manual oficial**: el PDF del
Manual de Identidad Visual 2025 que publica utem.cl responde 404 y la página de identidad no lista
códigos. Si el manual dice otra cosa, se cambian los tres valores `--utem-*` en `estilo.css` y lo
demás se acomoda solo.

IBM Plex se declara primero en la pila de fuentes y cae a `system-ui` si no está instalada. No se
trae por CDN a propósito: la plataforma tiene que levantar sin red.

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
web/public/                 la pagina: HTML, CSS y JS a mano
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
