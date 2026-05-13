# Résultats de performance baseline

Date : À compléter (YYYY-MM-DD)
Environnement : À compléter (CPU, RAM, Redis version, OS)
Instance Hubo : 1 (pas de scale horizontal)
Node.js : >= 20.0.0

## Configuration de l'environnement de test

```bash
# Variables d'environnement requises
HUB_URL=http://localhost
APP_ID=benchmark-app
PUBLISHER_SECRET=<secret>
SUBSCRIBER_SECRET=<secret>

# Exécution du test de charge (5 min)
tsx benchmark/load-test.ts

# Exécution du test anti-fuite mémoire (24h)
DURATION_HOURS=24 tsx benchmark/memory-leak-test.ts
```

Prérequis : créer un tenant `benchmark-app` avec `hubo tenant add --app-id benchmark-app --secret <secret>` avant de lancer les benchmarks.

---

## Test 1 : 1 000 connexions SSE + 500 events/sec (5 min)

| Métrique               | Cible NFR     | Résultat | Statut |
|------------------------|---------------|----------|--------|
| RSS max (Mo)           | < 200 Mo      | –        | –      |
| Latence p50 (ms)       | –             | –        | –      |
| Latence p95 (ms)       | < 100 ms      | –        | –      |
| Latence p99 (ms)       | –             | –        | –      |
| Connexions perdues     | 0             | –        | –      |
| Events delivered/sec   | ~500          | –        | –      |
| Events publiés (total) | –             | –        | –      |
| Erreurs publish        | 0             | –        | –      |

NFR1 (RSS < 200 Mo) : –
NFR2 (latence p95 < 100ms) : –
NFR3 (aucune connexion perdue) : –

---

## Test 2 : Test anti-fuite mémoire (24h)

| Heure | RSS process (Mo) | RSS hub (Mo) | Croissance |
|-------|-----------------|--------------|------------|
| 0h    | –               | –            | 0%         |
| 6h    | –               | –            | –          |
| 12h   | –               | –            | –          |
| 18h   | –               | –            | –          |
| 24h   | –               | –            | –          |

Croissance RSS sur 24h : – % (cible : < 5%)

NFR5 (no memory leak) : –

---

## Conclusion

> À compléter après exécution des benchmarks.

Les NFR1, NFR2, NFR3 (performance) et NFR5 (pas de fuite mémoire) sont validés / non validés dans cet environnement.
