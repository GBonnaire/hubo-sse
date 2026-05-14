# Hubo — SSE Hub multi-tenant auto-hébergé

Hub Server-Sent Events pour Node.js. Alternative légère à Mercure, sans Go. Chaque tenant dispose de son propre canal d'événements isolé, sécurisé par JWT HS256/RS256, avec gestion des limites de débit et persistance via Redis Streams + MySQL.

Transparence IA : Application vibecodée à 80% par Claude AI
---

## Prérequis

- **Node.js** >= 20 LTS
- **Redis** >= 7.0
- **MySQL** >= 8.0 ou **MariaDB** >= 10.11

---

## Installation

```bash
git clone git@github.com:GBonnaire/hubo-sse.git
cd <your-folder>/app
npm install
npx prisma generate
npx prisma migrate deploy
npm run build
```

---

## Quick Start

### 1. Créer la configuration

Copier `.env.example` en `.env` et renseigner les valeurs :

```bash
cp .env.example .env
```

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PORT` | `3000` | Port d'écoute (prioritaire sur `HUBO_PORT`, injecté par Passenger) |
| `HUBO_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `DATABASE_URL` | — | URL MySQL/MariaDB (ex: `mysql://user:pass@host:3306/db`) |
| `REDIS_URL` | — | URL Redis (ex: `redis://localhost:6379`) |
| `HUBO_HTTPS_REDIRECT` | `false` | Redirection HTTP→HTTPS via `x-forwarded-proto` |
| `HUBO_ADMIN_TOKEN` | — | Token Bearer pour protéger `/metrics` |

Pour les surcharges locales (non versionnées), créer un `.env.local` :

```bash
# .env.local  (prioritaire sur .env)
HUBO_LOG_LEVEL=debug
```

### 2. Créer un tenant

```bash
node dist/cli/index.js tenant add \
  --app-id=my-app \
  --secret=mysecret-minimum-32-chars-long \
  --origins=http://localhost:8080
```

`--secret` est facultatif — Hubo génère un secret automatiquement si absent.

### 3. Démarrer le hub

```bash
node dist/cli/index.js start
```

### 4. Documentation d'intégration

- Documentation Next.js : `/docs/integration-nextjs.md`
- Documentation Symfony : `/docs/integration-symfony.md`

---

## Structure du JWT

Tous les JWT doivent être signés **HS256** (ou **RS256** pour la clé publique).

```json
{
  "iss": "my-app",
  "mode": "publish",
  "topics": ["updates:*"],
  "exp": 1713700000,
  "jti": "uuid-optionnel-pour-révocation"
}
```

| Claim | Requis | Description |
|-------|--------|-------------|
| `iss` | oui | `appId` du tenant (identifiant de l'application) |
| `mode` | oui | `"publish"` ou `"subscribe"` |
| `topics` | oui | Liste des topics autorisés (supporte les wildcards `*`) |
| `exp` | oui | Expiration Unix timestamp |
| `jti` | — | ID unique du token (pour la révocation via blacklist) |
| `session_id` | — | ID de session (limite par connexion simultanée) |

**Wildcards :** `orders:*` autorise `orders:42:status`, `orders:99:events`, etc.

---

## API

### `POST /publish`

Publie un événement vers un ou plusieurs topics.

```bash
curl -X POST http://localhost/publish \
  -H "Authorization: Bearer $PUBLISHER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "topics": ["orders:42:status"],
    "data": {"status": "shipped"},
    "id": "uuid-optionnel",
    "retry": 3000
  }'
```

**Réponse 200 :**
```json
{ "id": "01JK8Q..." }
```

**Erreurs :** `401 missing_token`, `401 invalid_token`, `401 token_expired`, `403 wrong_mode`, `403 topic_not_allowed`, `429 rate_limit_exceeded`

---

### `GET /subscribe`

Ouvre une connexion SSE et reçoit les événements en temps réel.

```bash
curl -N "http://localhost/subscribe?topics=orders:42:status&authorization=$SUBSCRIBER_TOKEN"
```

**Paramètres :**

| Paramètre | Description |
|-----------|-------------|
| `topics` | Topics à écouter, séparés par virgule (`orders:42,users:1`) |
| `authorization` | JWT subscriber (query string ou header `Authorization: Bearer ...`) |
| `lastEventId` | ID du dernier event reçu pour le replay (ou header `Last-Event-ID`) |

**Format des événements SSE :**

```
id: 01JK8Q...
data: {"status":"shipped"}

: ping

event: token.expired
data: {}

event: server.shutdown
data: {}
```

**Erreurs :** `400 topics_required`, `401`, `403 topic_not_allowed`, `429 too_many_connections`

---

### `GET /health`

```bash
curl http://localhost/health
```

```json
{
  "status": "ok",
  "redis": "ok",
  "database": "ok",
  "uptime": 3600,
  "connections": 42
}
```

---

### `GET /metrics`

Métriques Prometheus.

```bash
curl http://localhost/metrics
# ou avec auth si adminToken configuré :
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost/metrics
```

---

## Gestion des tenants

```bash
# Ajouter un tenant HS256
node dist/cli/index.js tenant add --app-id=my-app --secret=secret32chars --origins=https://example.com

# Ajouter un tenant RS256 (clé publique)
node dist/cli/index.js tenant add --app-id=my-app --algorithm=RS256 --public-key="$(cat public.pem)" --origins=https://example.com

# Lister les tenants
node dist/cli/index.js tenant list

# Supprimer un tenant
node dist/cli/index.js tenant remove --app-id=my-app

# Révoquer un token par JTI
node dist/cli/index.js token revoke --jti=uuid-du-token --tenant=my-app --exp=1713700000
```

---

## Déploiement

### Production standard (PM2)

```bash
git clone git@github.com:GBonnaire/hubo-sse.git
cd <your-folder>/app
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build

# Avec PM2
pm2 start dist/cli/index.js --name hubo -- start

# Ou directement
node dist/cli/index.js start
```

---

### Déploiement sur O2Switch (Phusion Passenger / cPanel)

#### Prérequis

- Node.js >= 20 (testé avec v24)
- Redis
- Base de données MySQL/MariaDB
- Accès SSH

#### Fichiers de configuration spécifiques

**`.npmrc`** — force l'installation des devDependencies :

```
include=dev
```

Les devDependencies (`typescript`, `@types/node`, etc.) ne sont pas installées par défaut sur O2Switch même sans `NODE_ENV=production`. Ce fichier est indispensable pour que le build fonctionne.

**`tsconfig.json`** — les types Node doivent être explicites :

```json
"types": ["node"]
```

**`prisma/schema.prisma`** — cible le runtime OpenSSL d'O2Switch :

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "debian-openssl-1.0.x"]
}
```

Sans cette ligne, Prisma génère un binaire pour `debian-openssl-1.1.x` (environnement local) qui ne fonctionne pas sur le serveur.

**`server.js`** — point d'entrée Passenger (IIFE async pour contourner les limitations ESM) :

```js
(async () => {
  const { loadConfig } = await import('./dist/config.js');
  const { buildApp } = await import('./dist/app.js');
  // ... démarrage sur 0.0.0.0
})();
```

#### Procédure de déploiement

Le Node.js système d'O2Switch est trop ancien pour Fastify v5. Toutes les commandes SSH doivent utiliser le Node.js du nodevenv :

```bash
source ~/nodevenv/<app>/<version>/bin/activate
```

Ensuite, dans le dossier de l'app :

```bash
npm install --include=dev --ignore-scripts
npx prisma generate
npm run build
npx prisma migrate deploy
```

> **Important :** toujours utiliser `--ignore-scripts` au premier `npm install`. Le script `postinstall` (`prisma generate`) échoue si les dépendances ne sont pas encore installées. Lancer `npx prisma generate` manuellement après.

#### Commandes CLI (gestion des tenants, tokens…)

Même règle : utiliser le Node.js du nodevenv, pas le `node` système.

```bash
source ~/nodevenv/<app>/<version>/bin/activate
node dist/cli/index.js tenant add --app-id=my-app --origins=https://example.com
```

#### Configuration Passenger (`.htaccess`)

```apache
PassengerAppType node
PassengerStartupFile server.js
PassengerNodejs "/home/<user>/nodevenv/<app>/<version>/bin/node"

# Eviter la coupure des flux SSE par le proxy
Header set X-Accel-Buffering "no"
Header set Cache-Control "no-cache"
ProxyTimeout 3600
ProxyReadTimeout 3600
```

Remplacer `<user>`, `<app>` et `<version>` par les valeurs de votre environnement Node.js cPanel.

#### Variables d'environnement

Définir les variables dans **cPanel → Setup Node.js App** (pas dans `.env`) :

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | URL MySQL/MariaDB |
| `REDIS_URL` | URL Redis |
| `HUBO_LOG_LEVEL` | Niveau de log (`info` recommandé en prod) |
| `HUBO_HTTPS_REDIRECT` | `true` si le site est en HTTPS |
| `HUBO_ADMIN_TOKEN` | Token pour protéger `/metrics` |

> `PORT` est injecté automatiquement par Passenger — ne pas le définir manuellement. L'app ne doit jamais écouter sur le port 80 directement.

#### Redémarrage

Après chaque déploiement, redémarrer l'application depuis **cPanel → Setup Node.js App**.

#### Points d'attention

- `dist/` doit être buildé sur le serveur, ne pas le committer dans git.
- Le `node_modules` réel est dans `/home/<user>/nodevenv/.../lib/node_modules/` et non dans le dossier de l'app.
- Passenger charge le fichier de démarrage via `require()` — le fichier `server.js` contourne ce problème en wrappant les imports ESM dynamiques dans une IIFE async.
- En cas d'erreur Prisma au démarrage, vérifier que `binaryTargets` est bien défini dans `schema.prisma` et que `npx prisma generate` a été relancé sur le serveur.

---

### Docker (développement)

```bash
docker compose up
```

La configuration Docker monte le dossier `app/` dans le container et lance `npm install && npm run dev` au démarrage. Le `node_modules` est isolé dans un volume anonyme pour éviter les conflits de binaires entre macOS et Linux.

```bash
# Lancer les migrations au premier démarrage
docker compose exec node npx prisma migrate deploy
```

---

## Scalabilité multi-instances

Hubo supporte le scale horizontal via Redis Pub/Sub. Chaque instance subscribe au pattern `hubo:pubsub:*` et relaie les événements aux connexions locales. Aucune configuration supplémentaire n'est requise au-delà d'un Redis partagé.

---

## FAQ / Troubleshooting

**Q : JWT invalide → 401 `invalid_token`**

Vérifier que :
- Le claim `iss` correspond exactement à l'`app_id` du tenant en base.
- Le secret de signature correspond au `secret` du tenant.
- L'algorithme utilisé (`HS256` ou `RS256`) correspond à la configuration du tenant.

---

**Q : 401 `unknown_tenant`**

Le tenant n'existe pas. Vérifier avec `node dist/cli/index.js tenant list` et créer le tenant si nécessaire.

---

**Q : La connexion SSE se coupe après 30-60s**

Ajouter dans `.htaccess` :
```apache
Header set X-Accel-Buffering "no"
ProxyTimeout 3600
```
Pour nginx :
```nginx
proxy_buffering off;
proxy_read_timeout 3600s;
```

---

**Q : 429 `rate_limit_exceeded` sur `/publish`**

Le tenant a dépassé sa limite de publications par seconde (défaut : 100/sec). Modifier avec :
```bash
UPDATE tenants SET rate_limit_publish = 500 WHERE app_id = 'my-app';
```

---

**Q : 429 `too_many_connections` sur `/subscribe`**

Le tenant a dépassé sa limite de connexions simultanées (défaut : 500). Modifier `rate_limit_connections` en base.

---

**Q : Events non reçus après une reconnexion**

Passer le `Last-Event-ID` du dernier event reçu :
```bash
curl -N "http://localhost/subscribe?topics=orders&authorization=$TOKEN" \
  -H "Last-Event-ID: 01JK8Q..."
```
Les events stockés dans Redis Streams (TTL 1h par défaut) seront rejoués.

---

**Q : Le process s'arrête sans envoyer `server.shutdown`**

S'assurer que le processus reçoit bien `SIGTERM` (et pas `SIGKILL`). Hubo envoie `event: server.shutdown` à tous les subscribers avant de fermer, avec un délai de 30s pour les connexions actives.
