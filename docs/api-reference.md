# Hubo — Référence API

Ce document décrit tous les endpoints exposés par Hubo, les payloads associés, les codes d'erreur, et le fonctionnement du système d'authentification basé sur l'`app_id` et le `secret`.

---

## Sommaire

1. [Concepts : app_id, secret et JWT](#1-concepts--app_id-secret-et-jwt)
2. [Générer un token JWT](#2-générer-un-token-jwt)
3. [Endpoints](#3-endpoints)
   - [POST /publish](#post-publish)
   - [GET /subscribe](#get-subscribe)
   - [GET /listeners/:topic](#get-listenerstopic)
   - [GET /health](#get-health)
   - [GET /metrics](#get-metrics)
   - [GET /](#get-)
4. [Codes d'erreur](#4-codes-derreur)
5. [Wildcards sur les topics](#5-wildcards-sur-les-topics)

---

## 1. Concepts : app_id, secret et JWT

### app_id

L'`app_id` est l'identifiant unique de votre application (tenant). Il est créé via la CLI :

```bash
node dist/cli/index.js tenant add --app-id=mon-app --origins=https://mon-site.com
```

Chaque tenant est totalement isolé : ses topics, ses connexions et ses limites de débit lui sont propres.

### secret

Le `secret` est la clé symétrique utilisée pour signer et vérifier les JWT en HS256. Il est généré automatiquement si non fourni, ou passé explicitement :

```bash
node dist/cli/index.js tenant add \
  --app-id=mon-app \
  --secret=une-chaine-aleatoire-dau-moins-32-caracteres \
  --origins=https://mon-site.com
```

Pour RS256, on passe une clé publique à la place du secret :

```bash
node dist/cli/index.js tenant add \
  --app-id=mon-app \
  --algorithm=RS256 \
  --public-key="$(cat public.pem)" \
  --origins=https://mon-site.com
```

### Comment fonctionne l'authentification

Tous les appels à `/publish` et `/subscribe` nécessitent un JWT signé. Ce JWT est **généré par votre backend** (jamais exposé côté client) à partir de l'`app_id` et du `secret`.

```
Votre backend
  └─ signe un JWT avec (app_id + secret)
       └─ transmet le token au client
            └─ le client utilise le token pour s'abonner ou publier via Hubo
```

Hubo vérifie le JWT à chaque requête :
1. Décode le claim `iss` pour identifier le tenant (`app_id`).
2. Vérifie la signature avec le `secret` du tenant.
3. Vérifie les claims `mode`, `topics`, `exp`.
4. Si un `jti` est présent, vérifie qu'il n'est pas révoqué dans Redis.

---

## 2. Générer un token JWT

### Structure du payload

```json
{
  "iss": "mon-app",
  "mode": "publish",
  "topics": ["commandes:*", "alertes:critique"],
  "exp": 1713700000,
  "jti": "uuid-v4-optionnel",
  "session_id": "user-42"
}
```

| Claim | Type | Requis | Description |
|-------|------|--------|-------------|
| `iss` | `string` | oui | `app_id` du tenant |
| `mode` | `"publish"` \| `"subscribe"` | oui | Détermine les droits du token |
| `topics` | `string[]` | oui | Topics autorisés (supporte les wildcards, voir §5) |
| `exp` | `number` | oui | Expiration Unix timestamp |
| `jti` | `string` | non | ID unique du token, permet la révocation individuelle |
| `session_id` | `string` | non | Limite le nombre de connexions simultanées par session |

### Exemple en Node.js (HS256)

```js
import { SignJWT } from 'jose'

const secret = new TextEncoder().encode('votre-secret-32-chars-minimum')

const token = await new SignJWT({
  iss: 'mon-app',
  mode: 'subscribe',
  topics: ['commandes:*'],
})
  .setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h')
  .setJti(crypto.randomUUID())
  .sign(secret)
```

### Exemple en PHP (HS256)

```php
use Firebase\JWT\JWT;

$payload = [
    'iss'     => 'mon-app',
    'mode'    => 'subscribe',
    'topics'  => ['commandes:*'],
    'exp'     => time() + 3600,
    'jti'     => bin2hex(random_bytes(16)),
];

$token = JWT::encode($payload, 'votre-secret-32-chars-minimum', 'HS256');
```

---

## 3. Endpoints

### POST /publish

Publie un événement vers un ou plusieurs topics. Les abonnés connectés sur ces topics le reçoivent en temps réel.

**Authentification :** `Authorization: Bearer <token>` avec `mode: "publish"`.

#### Requête

```
POST /publish
Content-Type: application/json
Authorization: Bearer <publisher_token>
```

#### Body

```json
{
  "topics": ["commandes:42:statut", "alertes"],
  "data": {
    "statut": "expédié",
    "transporteur": "Colissimo"
  },
  "private": false,
  "id": "01JK8Q5ABCDEF",
  "retry": 3000
}
```

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `topics` | `string[]` | oui | Topics destinataires (au moins 1). Doivent être couverts par les `topics` du JWT. |
| `data` | `object` | oui | Données de l'événement, sérialisables en JSON. |
| `private` | `boolean` | non | Défaut `false`. Si `true`, l'événement n'est pas persisté dans Redis Streams. |
| `id` | `string` | non | ID de l'événement. Généré automatiquement si absent (UUIDv7). |
| `retry` | `number` | non | Délai de reconnexion SSE suggéré au client, en millisecondes. |

#### Réponse 200

```json
{ "id": "01JK8Q5ABCDEF123456789" }
```

#### Erreurs

| Code HTTP | `error` | Cause |
|-----------|---------|-------|
| 400 | `topics must have at least one element` | `topics` vide ou absent |
| 400 | `data must be JSON-serializable` | `data` non sérialisable |
| 401 | `missing_token` | Header `Authorization` absent ou mal formé |
| 401 | `invalid_token` | Signature invalide ou token malformé |
| 401 | `token_expired` | Token expiré (`exp` dépassé) |
| 401 | `unknown_tenant` | `iss` inconnu (tenant inexistant) |
| 401 | `token_revoked` | JTI présent dans la blacklist Redis |
| 403 | `wrong_mode` | Token avec `mode: "subscribe"` utilisé sur `/publish` |
| 403 | `topic_not_allowed` | Topic demandé non couvert par les `topics` du JWT |
| 413 | `payload_too_large` | Body dépasse `maxEventSize` du tenant (défaut : 64 Ko) |
| 429 | `rate_limit_exceeded` | Limite de publications par seconde atteinte (défaut : 100/s) |

#### Exemple curl

```bash
curl -X POST https://hubo.mon-domaine.com/publish \
  -H "Authorization: Bearer $PUBLISHER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "topics": ["commandes:42:statut"],
    "data": { "statut": "expédié" }
  }'
```

---

### GET /subscribe

Ouvre une connexion **Server-Sent Events (SSE)** et reçoit les événements en temps réel. La connexion reste ouverte jusqu'à déconnexion du client ou expiration du token.

**Authentification :** header `Authorization: Bearer <token>` ou query param `authorization=<token>`, avec `mode: "subscribe"`.

#### Requête

```
GET /subscribe?topics=commandes:42:statut,alertes&lastEventId=01JK8Q...
Authorization: Bearer <subscriber_token>
```

#### Query params

| Paramètre | Type | Requis | Description |
|-----------|------|--------|-------------|
| `topics` | `string` | oui | Topics à écouter, séparés par virgule. Peuvent aussi être passés en paramètres multiples (`?topics=a&topics=b`). Doivent être couverts par les `topics` du JWT. |
| `authorization` | `string` | non | Alternative au header `Authorization`. Utile pour les clients qui ne peuvent pas définir de headers (ex : `EventSource` natif du navigateur). |
| `lastEventId` | `string` | non | ID du dernier événement reçu. Déclenche le **replay** depuis Redis Streams pour récupérer les événements manqués pendant une déconnexion. Peut aussi être passé via le header standard `Last-Event-ID`. |

#### Format des événements SSE reçus

```
id: 01JK8Q5ABCDEF123456789
data: {"statut":"expédié","transporteur":"Colissimo"}

```

```
: ping
```

```
event: token.expired
data: {}

```

```
event: server.shutdown
data: {}

```

| Événement | Description |
|-----------|-------------|
| *(sans `event`)* | Événement métier publié via `/publish` |
| `: ping` | Commentaire de keep-alive envoyé périodiquement pour maintenir la connexion |
| `token.expired` | Le token JWT a expiré. Le client doit en obtenir un nouveau et se reconnecter. |
| `server.shutdown` | Le serveur s'arrête proprement. Le client doit se reconnecter après un délai. |

#### Headers de réponse

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

#### Erreurs (réponse HTTP avant ouverture du flux)

| Code HTTP | `error` | Cause |
|-----------|---------|-------|
| 400 | `topics_required` | Paramètre `topics` absent ou vide |
| 401 | `missing_token` | Token absent (ni header ni query param) |
| 401 | `invalid_token` | Signature invalide |
| 401 | `token_expired` | Token expiré |
| 401 | `unknown_tenant` | `iss` inconnu |
| 401 | `token_revoked` | JTI révoqué |
| 403 | `wrong_mode` | Token avec `mode: "publish"` utilisé sur `/subscribe` |
| 403 | `topic_not_allowed` | Topic demandé non couvert par les `topics` du JWT |
| 429 | `too_many_connections` | Limite de connexions simultanées du tenant atteinte (défaut : 500) |

#### Exemple curl

```bash
curl -N "https://hubo.mon-domaine.com/subscribe?topics=commandes:42:statut" \
  -H "Authorization: Bearer $SUBSCRIBER_TOKEN"
```

#### Exemple JavaScript (navigateur)

```js
// Le token est obtenu depuis votre backend
const token = await fetch('/api/hubo-token').then(r => r.text())

const url = new URL('https://hubo.mon-domaine.com/subscribe')
url.searchParams.set('topics', 'commandes:42:statut')
url.searchParams.set('authorization', token)

const es = new EventSource(url)

es.onmessage = (e) => {
  const data = JSON.parse(e.data)
  console.log('Événement reçu :', data)
}

es.addEventListener('token.expired', () => {
  es.close()
  // relancer la connexion avec un nouveau token
})

es.addEventListener('server.shutdown', () => {
  es.close()
  setTimeout(() => reconnect(), 5000)
})
```

#### Replay après déconnexion

Pour ne perdre aucun événement lors d'une reconnexion, passer le `lastEventId` du dernier événement reçu :

```js
es.onmessage = (e) => {
  lastId = e.lastEventId
}

// À la reconnexion :
url.searchParams.set('lastEventId', lastId)
```

Les événements sont conservés dans Redis Streams pendant le TTL du tenant (défaut : 1 heure). Au-delà, les événements anciens ne sont plus disponibles pour le replay.

---

### GET /listeners/:topic

Retourne le nombre de connexions SSE actives sur un topic donné pour le tenant authentifié.

**Authentification :** `Authorization: Bearer <token>` avec `mode: "publish"`.

#### Requête

```
GET /listeners/commandes:42:statut
Authorization: Bearer <publisher_token>
```

#### Paramètre de chemin

| Paramètre | Description |
|-----------|-------------|
| `topic` | Le topic exact à interroger (pas de wildcard). Scopé automatiquement au tenant du JWT. |

#### Réponse 200

```json
{ "topic": "commandes:42:statut", "listeners": 7 }
```

| Champ | Type | Description |
|-------|------|-------------|
| `topic` | `string` | Le topic interrogé (tel que passé dans l'URL) |
| `listeners` | `number` | Nombre de connexions SSE actives sur ce topic pour ce tenant |

#### Erreurs

| Code HTTP | `error` | Cause |
|-----------|---------|-------|
| 401 | `missing_token` | Header `Authorization` absent ou mal formé |
| 401 | `invalid_token` | Signature invalide ou token malformé |
| 401 | `token_expired` | Token expiré |
| 401 | `unknown_tenant` | `iss` inconnu |
| 403 | `wrong_mode` | Token avec `mode: "subscribe"` utilisé |

#### Exemple curl

```bash
curl "https://hubo.mon-domaine.com/listeners/commandes:42:statut" \
  -H "Authorization: Bearer $PUBLISHER_TOKEN"
```

---

### GET /health

Vérifie l'état des dépendances du hub. Utile pour les sondes de monitoring et les load balancers.

**Authentification :** aucune.

#### Requête

```
GET /health
```

#### Réponse 200 — tout est opérationnel

```json
{
  "status": "ok",
  "redis": "ok",
  "database": "ok",
  "uptime": 3600,
  "connections": 42
}
```

#### Réponse 503 — service dégradé

```json
{
  "status": "degraded",
  "redis": "error",
  "database": "ok",
  "uptime": 120,
  "connections": 0
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `status` | `"ok"` \| `"degraded"` | `ok` si Redis et la base sont accessibles, `degraded` sinon |
| `redis` | `"ok"` \| `"error"` | Résultat du `PING` Redis (timeout 1s) |
| `database` | `"ok"` \| `"error"` | Résultat d'un `SELECT 1` (timeout 1s) |
| `uptime` | `number` | Temps de fonctionnement du processus en secondes |
| `connections` | `number` | Nombre total de connexions SSE actives (tous tenants) |

#### Exemple curl

```bash
curl https://hubo.mon-domaine.com/health
```

---

### GET /metrics

Expose les métriques internes au format **Prometheus**.

**Authentification :** aucune si `HUBO_ADMIN_TOKEN` n'est pas défini. Si défini, le header `Authorization: Bearer <token>` est requis.

#### Requête

```
GET /metrics
Authorization: Bearer <admin_token>   # uniquement si HUBO_ADMIN_TOKEN est configuré
```

#### Réponse 200

```
# HELP hubo_connections_active Connexions SSE actives
# TYPE hubo_connections_active gauge
hubo_connections_active{tenant="mon-app"} 14

# HELP hubo_messages_published_total Messages publiés
# TYPE hubo_messages_published_total counter
hubo_messages_published_total{tenant="mon-app"} 1042

# HELP hubo_jwt_errors_total Erreurs JWT
# TYPE hubo_jwt_errors_total counter
hubo_jwt_errors_total{tenant="mon-app",reason="token_expired"} 3
```

#### Erreur

| Code HTTP | `error` | Cause |
|-----------|---------|-------|
| 401 | `unauthorized` | `HUBO_ADMIN_TOKEN` défini mais token absent ou incorrect |

#### Exemple curl

```bash
# Sans authentification
curl https://hubo.mon-domaine.com/metrics

# Avec authentification
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://hubo.mon-domaine.com/metrics
```

---

### GET /

Page de statut HTML. Affiche l'état en temps réel de Redis, de la base de données, et du serveur SSE. Se rafraîchit automatiquement toutes les 10 secondes.

**Authentification :** aucune.

---

## 4. Codes d'erreur

Tous les endpoints renvoient les erreurs sous la forme :

```json
{ "error": "<code>" }
```

| Code | HTTP | Description |
|------|------|-------------|
| `missing_token` | 401 | Token absent ou header `Authorization` mal formé |
| `invalid_token` | 401 | Signature invalide, token malformé ou `iss` manquant |
| `token_expired` | 401 | Claim `exp` dépassé |
| `unknown_tenant` | 401 | `iss` ne correspond à aucun tenant enregistré |
| `token_revoked` | 401 | JTI présent dans la blacklist Redis |
| `wrong_mode` | 403 | Token `publish` utilisé sur `/subscribe`, ou inversement |
| `topic_not_allowed` | 403 | Topic demandé non couvert par les `topics` du JWT |
| `topics_required` | 400 | Paramètre `topics` absent sur `/subscribe` |
| `payload_too_large` | 413 | Body de `/publish` dépasse la limite du tenant |
| `rate_limit_exceeded` | 429 | Trop de publications par seconde |
| `too_many_connections` | 429 | Trop de connexions SSE simultanées pour ce tenant |
| `unauthorized` | 401 | Token admin manquant ou incorrect sur `/metrics` |

---

## 5. Wildcards sur les topics

Les topics utilisent `:` comme séparateur de segments. Les JWT peuvent contenir des wildcards `*` dans les `topics` autorisés.

### Wildcard terminal

`orders:*` autorise **tous les sous-topics** à partir de ce préfixe :

```
orders:*  →  orders:42          ✓
             orders:42:status   ✓
             orders:99:events   ✓
             users:1            ✗
```

### Wildcard de segment

`orders:*:status` remplace **exactement un segment** :

```
orders:*:status  →  orders:42:status    ✓
                    orders:99:status    ✓
                    orders:42:events    ✗
                    orders:42           ✗
```

### Exemples pratiques

| Pattern JWT | Topic demandé | Autorisé |
|-------------|---------------|----------|
| `commandes:*` | `commandes:42` | oui |
| `commandes:*` | `commandes:42:statut` | oui |
| `commandes:*:statut` | `commandes:42:statut` | oui |
| `commandes:*:statut` | `commandes:42` | non |
| `alertes` | `alertes` | oui |
| `alertes` | `alertes:critique` | non |
| `*` | n'importe quel topic | oui |
