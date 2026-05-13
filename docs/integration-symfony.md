# Guide d'intégration Symfony

En moins de 30 minutes, publiez des événements temps réel depuis votre application Symfony vers des clients SSE via Hubo.

## Prérequis

- **Symfony** 7+ avec PHP 8.2+
- Un hub Hubo opérationnel (voir [README](../README.md))
- Un tenant Hubo créé avec `hubo tenant add`

---

## Installation

```bash
composer require lcobucci/jwt symfony/http-client
```

---

## Variables d'environnement

Ajouter dans `.env` (ou `.env.local`) :

```env
HUBO_URL=https://hub.example.com
HUBO_APP_ID=my-symfony-app
HUBO_SECRET=my-secret-minimum-32-chars-long
```

---

## Service HuboPublisher

```php
<?php
// src/Service/HuboPublisher.php
namespace App\Service;

use Lcobucci\JWT\Configuration;
use Lcobucci\JWT\Signer\Hmac\Sha256;
use Lcobucci\JWT\Signer\Key\InMemory;
use Symfony\Contracts\HttpClient\HttpClientInterface;

class HuboPublisher
{
    public function __construct(
        private readonly string $hubUrl,
        private readonly string $appId,
        private readonly string $secret,
        private readonly HttpClientInterface $httpClient,
    ) {}

    public function createSubscriberToken(array $topics, int $ttl = 3600): string
    {
        $config = Configuration::forSymmetricSigner(
            new Sha256(),
            InMemory::plainText($this->secret)
        );

        $token = $config->builder()
            ->issuedBy($this->appId)
            ->withClaim('mode', 'subscribe')
            ->withClaim('topics', $topics)
            ->expiresAt(new \DateTimeImmutable("+{$ttl} seconds"))
            ->getToken($config->signer(), $config->signingKey());

        return $token->toString();
    }

    public function createPublisherToken(array $topics, int $ttl = 300): string
    {
        $config = Configuration::forSymmetricSigner(
            new Sha256(),
            InMemory::plainText($this->secret)
        );

        $token = $config->builder()
            ->issuedBy($this->appId)
            ->withClaim('mode', 'publish')
            ->withClaim('topics', $topics)
            ->expiresAt(new \DateTimeImmutable("+{$ttl} seconds"))
            ->getToken($config->signer(), $config->signingKey());

        return $token->toString();
    }

    public function publish(array $topics, array $data): string
    {
        $token = $this->createPublisherToken($topics);

        $response = $this->httpClient->request('POST', $this->hubUrl . '/publish', [
            'headers' => [
                'Authorization' => 'Bearer ' . $token,
                'Content-Type'  => 'application/json',
            ],
            'json' => [
                'topics' => $topics,
                'data'   => $data,
            ],
        ]);

        return $response->toArray()['id'];
    }
}
```

---

## Configuration `services.yaml`

```yaml
# config/services.yaml
services:
    App\Service\HuboPublisher:
        arguments:
            $hubUrl: '%env(HUBO_URL)%'
            $appId:  '%env(HUBO_APP_ID)%'
            $secret: '%env(HUBO_SECRET)%'
```

---

## Event Listener — Publication automatique

Déclencher une publication Hubo lors d'un événement Symfony :

```php
<?php
// src/EventListener/OrderStatusListener.php
namespace App\EventListener;

use App\Event\OrderStatusChanged;
use App\Service\HuboPublisher;
use Symfony\Component\EventDispatcher\Attribute\AsEventListener;

#[AsEventListener]
class OrderStatusListener
{
    public function __construct(
        private readonly HuboPublisher $hubo,
    ) {}

    public function __invoke(OrderStatusChanged $event): void
    {
        $this->hubo->publish(
            ["orders:{$event->orderId}:status"],
            [
                'status'    => $event->newStatus,
                'orderId'   => $event->orderId,
                'updatedAt' => time(),
            ]
        );
    }
}
```

```php
<?php
// src/Event/OrderStatusChanged.php
namespace App\Event;

class OrderStatusChanged
{
    public function __construct(
        public readonly int    $orderId,
        public readonly string $newStatus,
    ) {}
}
```

Dispatcher l'événement depuis un service :

```php
$this->eventDispatcher->dispatch(new OrderStatusChanged(42, 'shipped'));
```

---

## Route pour le subscriber token

Exposer un endpoint pour que le front-end puisse obtenir un token JWT :

```php
<?php
// src/Controller/HuboTokenController.php
namespace App\Controller;

use App\Service\HuboPublisher;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\Routing\Attribute\Route;
use Symfony\Component\Security\Http\Attribute\IsGranted;

class HuboTokenController extends AbstractController
{
    #[Route('/api/hubo-token', methods: ['GET'])]
    #[IsGranted('ROLE_USER')]
    public function getToken(HuboPublisher $hubo): JsonResponse
    {
        $user = $this->getUser();

        $token = $hubo->createSubscriberToken([
            "orders:{$user->getId()}:*",
            "users:{$user->getId()}:*",
        ]);

        return $this->json([
            'token'     => $token,
            'expiresIn' => 3600,
        ]);
    }
}
```

---

## Côté front — JavaScript vanilla

```javascript
// public/js/realtime.js

// 1. Récupérer le token depuis Symfony
const { token } = await fetch('/api/hubo-token').then(r => r.json());

// 2. Ouvrir la connexion SSE
const hubUrl = 'https://hub.example.com';
const es = new EventSource(
  `${hubUrl}/subscribe?topics=orders:42:status&authorization=${token}`
);

es.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Mise à jour reçue :', data);
  // Mettre à jour le DOM
  document.getElementById('status').textContent = data.status;
};

es.addEventListener('token.expired', () => {
  es.close();
  // Rafraîchir le token et se reconnecter
  connectToHub();
});

es.onerror = () => {
  console.warn('Connexion SSE perdue, tentative de reconnexion...');
};
```

---

## Côté front — Symfony UX / Stimulus

```javascript
// assets/controllers/realtime_controller.js
import { Controller } from '@hotwired/stimulus'

export default class extends Controller {
  static values = { topic: String }

  connect() {
    this.fetchToken().then(token => this.startSSE(token))
  }

  disconnect() {
    this.es?.close()
  }

  async fetchToken() {
    const res = await fetch('/api/hubo-token')
    const { token } = await res.json()
    return token
  }

  startSSE(token) {
    const url = new URL(`${window.HUBO_URL}/subscribe`)
    url.searchParams.set('topics', this.topicValue)
    url.searchParams.set('authorization', token)

    this.es = new EventSource(url)
    this.es.onmessage = (event) => {
      const data = JSON.parse(event.data)
      this.element.dispatchEvent(new CustomEvent('hubo:message', { detail: data }))
    }

    this.es.addEventListener('token.expired', () => {
      this.es.close()
      this.fetchToken().then(t => this.startSSE(t))
    })
  }
}
```

Utilisation dans Twig :

```twig
{# templates/order/show.html.twig #}
<div data-controller="realtime"
     data-realtime-topic-value="orders:{{ order.id }}:status"
     data-action="hubo:message->updateStatus">
  <p id="status">{{ order.status }}</p>
</div>
```

---

## Gestion des erreurs et retry

```php
// Dans HuboPublisher::publish(), gérer les erreurs réseau :
try {
    $response = $this->httpClient->request('POST', $this->hubUrl . '/publish', [...]);
    return $response->toArray()['id'];
} catch (\Symfony\Contracts\HttpClient\Exception\TransportExceptionInterface $e) {
    // Log et retry ou mise en file d'attente (Messenger)
    throw new \RuntimeException('Hubo unavailable: ' . $e->getMessage(), 0, $e);
}
```

Pour une haute fiabilité, encapsuler la publication dans un **Symfony Messenger message** afin de bénéficier des retry automatiques.
