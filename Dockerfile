# BSAG Leitstand – schlankes Image fuer den Betrieb (z.B. Synology DS1522+).
# Node 22 bringt die SQLite-Datenbank eingebaut mit; keine npm-Pakete noetig.
FROM node:22-alpine

WORKDIR /app

# Nur die Laufzeit-Dateien ins Image
COPY package.json server.js db.js homag.js importer.js import-csv.js make-preview.js ./
COPY public ./public

# Datenbank + Backups liegen auf einem persistenten Volume
ENV DATA_DIR=/data
ENV PORT=3000
VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server.js"]
