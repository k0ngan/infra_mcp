# Ambiente reproducible de la plataforma.
#
# Dos cosas viven aca adentro y no se dan por supuestas en la maquina de nadie:
# Node en una version fija y una instalacion de LaTeX capaz de compilar las
# guias. El MCP de Canvas entra por `npm ci`, fijado por commit en el
# package-lock, no por una carpeta hermana del disco.
#
# Lo que NO entra es el modelo: Ollama se queda en el anfitrion. Meter los pesos
# en la imagen (entre 3 y 7 GB segun el modelo) la haria inmanejable y ademas le
# quitaria la GPU, que es justo lo que hace que responda en segundos.
FROM node:24-slim

# El conjunto minimo que compila el preambulo de web/src/latex.mjs:
#   - texlive-latex-base .......... pdflatex, hyperref
#   - texlive-latex-recommended ... geometry, fancyhdr, xcolor
#   - texlive-lang-spanish ........ babel con español
#   - texlive-fonts-recommended ... las fuentes que usa lmodern
#   - lmodern ..................... la tipografia del documento
# texlive-latex-extra (enumitem, booktabs) se deja fuera a proposito: son
# cientos de megas y el documento no los necesita.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      texlive-latex-base \
      texlive-latex-recommended \
      texlive-lang-spanish \
      texlive-fonts-recommended \
      lmodern \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Las dependencias primero: mientras package-lock.json no cambie, esta capa se
# reaprovecha y reconstruir la imagen tarda segundos.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY web ./web
COPY usuarios.example.json ./

# Las carpetas que se montan como volumenes. Se crean aca para que existan
# aunque alguien corra la imagen suelta, sin compose.
RUN mkdir -p /app/vaults /app/secretos /app/metricas

# Dentro del contenedor si se escucha en todas las interfaces: lo que aisla es
# el contenedor, y el puerto se publica a mano en docker-compose.yml.
#
# PLATAFORMA_COOKIES saca las cookies de Canvas a un volumen. Sin eso se
# escribirian en la capa del contenedor y habria que volver a pegarlas en cada
# `docker compose up`.
ENV PLATAFORMA_HOST=0.0.0.0 \
    PLATAFORMA_PUERTO=8080 \
    PLATAFORMA_COOKIES=/app/secretos \
    PLATAFORMA_SESIONES=/app/secretos/sesiones.json \
    PLATAFORMA_METRICAS=/app/metricas \
    PLATAFORMA_ENTREGAS=/app/entregas \
    OLLAMA_URL=http://host.docker.internal:11434 \
    PLATAFORMA_MODELO=gemma4:e4b

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "web/src/servidor.mjs"]
