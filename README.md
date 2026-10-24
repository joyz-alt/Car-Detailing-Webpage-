# Épure Auto — site de detailing automobile

## Présentation
Site vitrine et système de demande de réservation pour Épure Auto à Angoulême.

## Technologies
- Frontend : HTML, CSS, JavaScript
- Backend : Node.js et Express (src/server.js)
- Réservations, créneaux bloqués et état de paiement : PostgreSQL
- Photos client : bucket Cloudflare R2 privé
- Paiement : Stripe Checkout
- Notifications : SMTP via Nodemailer

## Démarrage local
1. Installez Node.js 20 ou plus récent.
2. Copiez .env.example vers .env et renseignez les valeurs.
3. Créez une base PostgreSQL et exécutez database/schema.sql.
4. Depuis la racine du dépôt, lancez npm install.
5. Lancez npm start et ouvrez http://localhost:3000.

## Stockage
Le serveur n'utilise plus les fichiers JSON locaux pour ses réservations. Les fichiers clients ne sont pas servis comme fichiers statiques. Le bucket R2 doit rester privé ; le tableau de bord admin reçoit des URL signées temporaires pour les photos.

## Déploiement
Lisez DEPLOYMENT.md avant toute mise en ligne. Ne publiez pas ce service tant que la base, le stockage des photos, les variables secrètes, Stripe, l'espace admin et les pages légales n'ont pas été testés.

## Sécurité
- Ne commitez jamais .env ni des clés secrètes.
- Utilisez une longue valeur aléatoire pour ADMIN_KEY.
- Utilisez Stripe en mode test avant les vrais paiements.
