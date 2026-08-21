# NOIRÉA — prototype de site de lavage automobile

Prototype responsive conçu pour un service de detailing/lavage auto à Angoulême.

## Ce qui est déjà inclus

- Landing page premium desktop + mobile
- Prestations avec tarifs
- Parcours de réservation en 3 étapes
- Calendrier de disponibilité
- Créneaux retirés automatiquement lorsqu'ils sont réservés
- Espace professionnel pour bloquer des créneaux
- Gestion locale des réservations
- Résumé de commande
- Structure prête à brancher sur Stripe Checkout
- Design responsive avec barre de réservation mobile

## Important : passage en production

Le prototype utilise `localStorage` uniquement pour démontrer le fonctionnement.

Pour le vrai site, il faut :

1. Base de données (Supabase/PostgreSQL ou Firebase)
2. Authentification de l'espace pro
3. API serveur pour vérifier les disponibilités
4. Stripe Checkout + webhook `checkout.session.completed`
5. Création de la réservation uniquement après confirmation du paiement
6. Emails/SMS de confirmation et rappel
7. Gestion des durées et chevauchements selon la prestation
8. CGV, politique d'annulation, mentions légales et RGPD
9. Protection anti-double-réservation avec transaction côté serveur
10. Déploiement HTTPS

## Architecture recommandée

Frontend : HTML/CSS/JS ou React/Next.js
Backend : Supabase/PostgreSQL
Paiement : Stripe
Emails : Resend
Calendrier admin : interface propriétaire dédiée
Hébergement : Vercel/Netlify

Le point clé : le navigateur ne doit jamais être la source de vérité pour les disponibilités ou les paiements.
