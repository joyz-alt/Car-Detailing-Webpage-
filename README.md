# Épure Auto — site de detailing automobile

## Présentation
Site vitrine et système de demande de réservation pour Épure Auto à Angoulême.

## Technologies
- Frontend : HTML, CSS, JavaScript
- Backend : Node.js 20+ et Express (`src/server.js`)
- Réservations, créneaux bloqués, état de paiement et file d'e-mails : PostgreSQL
- Photos client : bucket Cloudflare R2 privé
- Paiement : Stripe Checkout avec validation via webhook
- Notifications : Resend HTTPS API (prioritaire) ou SMTP en solution de repli
- Vérifications de syntaxe : `npm run check`
- Tests d'intégration avec PostgreSQL : `npm test` (exige `TEST_DATABASE_URL` pointant vers une base de test jetable, jamais la production)

## Démarrage local
1. Installez Node.js 20 ou plus récent.
2. Copiez `.env.example` vers `.env` et renseignez vos propres valeurs.
3. Créez une base PostgreSQL et exécutez `database/schema.sql`.
4. Depuis la racine du dépôt, lancez `npm install`, puis `npm start`.
5. Ouvrez `http://localhost:3000/health`.

## Réservations & e-mails
Les demandes sont enregistrées dans PostgreSQL. La demande du client et la notification entreprise sont placées dans une file d'attente transactionnelle pour éviter de perdre les e-mails lorsqu'un fournisseur est temporairement indisponible. Les messages sont réessayés automatiquement ; les statuts et erreurs sont visibles dans l'espace professionnel. L'API Resend par HTTPS est recommandée sur Render Free car les connexions SMTP sortantes y sont bloquées.

## Stockage
Le serveur n'utilise plus les fichiers JSON locaux pour ses réservations. Les photos clients ne sont pas servies comme fichiers statiques. Le bucket R2 doit rester privé ; le tableau de bord admin reçoit des URL signées temporaires.

## Déploiement et sécurité
Lisez `DEPLOYMENT.md` avant toute mise en ligne. Ne publiez pas le service tant que la base durable, le stockage des photos, les secrets, Stripe, l'espace admin, les notifications et les pages légales n'ont pas été testés.

- Ne commitez jamais `.env` ni des secrets.
- Utilisez une valeur aléatoire longue pour `ADMIN_KEY`.
- Utilisez Stripe en mode test avant les vrais paiements.
- Ne placez jamais de secrets côté navigateur.
