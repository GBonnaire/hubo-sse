# Hubo — SSE Hub multi-tenant auto-hébergé

Hub Server-Sent Events pour Node.js. Alternative légère à Mercure, sans Go. Chaque tenant dispose de son propre canal d'événements isolé, sécurisé par JWT HS256/RS256, avec gestion des limites de débit et persistance via Redis Streams + MySQL.

---

## Prérequis

- **Node.js** ≥ 20 LTS
- **Redis** ≥ 7.0
- **MySQL** ≥ 8.0 ou **MariaDB** ≥ 10.11

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

Pour les surcharges locales (non versionnées), créez un `.env.local` :

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

`--secret` est facultatif, si vous ne le renseignez pas, hubo vous génèrera un secret automatiquement.

### 3. Démarrer le hub

```bash
node dist/cli/index.js start
```

N'oublie pas de charger les fichier env : `--env-file .env --env-file .env.local`
> **Note :** `--env-file` est disponible depuis Node.js 16.


### 4. Documentation pour le mettre dans votre application
Retrouver les autres documentations dans `/docs`

- Documentation NextJs : `/docs/integration-nextjs.md`
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
| `iss` | ✅ | `appId` du tenant (identifiant de l'application) |
| `mode` | ✅ | `"publish"` ou `"subscribe"` |
| `topics` | ✅ | Liste des topics autorisés (supporte les wildcards `*`) |
| `exp` | ✅ | Expiration Unix timestamp |
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

Vérifie l'état du hub.

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

### Variables d'environnement

Les variables sont lues depuis `.env`, puis `.env.local` (surcharge), puis `process.env` (priorité maximale).

| Variable | Défaut  | Description                                            |
|----------|---------|--------------------------------------------------------|
| `HUBO_PORT` | `80`    | Port d'écoute                                          |
| `REDIS_URL` | —       | URL Redis (ex: `redis://redis:6379`)                   |
| `DATABASE_URL` | —       | URL MySQL/MariaDB (ex: `mysql://user:pass@db:3306/db`) |
| `HUBO_LOG_LEVEL` | `info`  | `debug` \| `info` \| `warn` \| `error`                 |
| `HUBO_HTTPS_REDIRECT` | `false` | Redirection HTTP→HTTPS via `x-forwarded-proto`         |
| `HUBO_ADMIN_TOKEN` | —       | Token Bearer pour protéger `/metrics`                  |

### Production sans Docker

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

### Déploiement sur cPanel (Passenger)

1. Dans **cPanel → Setup Node.js App** : sélectionner Node.js ≥ 20, pointer vers le répertoire `app/`.

2. Dans le dossier de l'app, créer `.htaccess` :

```apache
PassengerAppType node
PassengerStartupFile dist/cli/index.js

# Éviter la coupure des flux SSE par le proxy
Header set X-Accel-Buffering "no"
Header set Cache-Control "no-cache"
ProxyTimeout 3600
ProxyReadTimeout 3600
```

3. Créer un fichier `app.js` à la racine si Passenger exige un point d'entrée spécifique :

```javascript
// app.js
import('./dist/cli/index.js')
```

4. Dans le panneau Node.js App de cPanel, définir les variables d'environnement (`DATABASE_URL`, `REDIS_URL`, `HUBO_PORT`).

5. Redémarrer l'application depuis cPanel.

> **Note :** Si les connexions SSE se coupent après 30-60s, vérifier que le proxy Apache ne bufferise pas la réponse. Le header `X-Accel-Buffering: no` est envoyé automatiquement par Hubo.

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

**Q : La connexion SSE se coupe après 30-60s sur cPanel/nginx**

Ajouter dans `.htaccess` :
```apache
Header set X-Accel-Buffering "no"
ProxyTimeout 3600
```
Pour nginx, ajouter dans le bloc `location` :
```nginx
proxy_buffering off;
proxy_read_timeout 3600s;
```

---

**Q : 429 `rate_limit_exceeded` sur `/publish`**

Le tenant a dépassé sa limite de publications par seconde. Par défaut : 100/sec. Modifier avec :
```bash
# Via Prisma Studio ou directement en base
UPDATE tenants SET rate_limit_publish = 500 WHERE app_id = 'my-app';
```

---

**Q : 429 `too_many_connections` sur `/subscribe`**

Le tenant a dépassé sa limite de connexions simultanées. Par défaut : 500. Modifier `rate_limit_connections` en base.

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
