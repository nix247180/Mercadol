# MERCADO — boutique CJ Dropshipping + CamPay (GitHub + Render)

Un seul dépôt, un seul service Render : le serveur sert le site (`public/index.html`) ET les API.

```
mercado-backend/
├── server.js          serveur (Express) : catalogue CJ, paiement CamPay, Telegram...
├── package.json
├── .env.example       modèle des variables (à copier dans Render > Environment)
├── .gitignore
├── public/
│   └── index.html     le site
└── data/
    └── products.json  produits de secours si CJ ne répond pas
```

## Déploiement sur Render
1. Mettre le dossier dans un dépôt GitHub (le fichier `.env` n'y va jamais).
2. Render > New > Web Service > connecter le dépôt.
3. Build Command : `npm install` — Start Command : `npm start`
4. Onglet Environment : ajouter les variables ci-dessous.
5. Dans CamPay, URL de webhook : `https://VOTRE-SERVICE.onrender.com/api/payment/campay/webhook`
6. Ouvrir `/api/health` : `cj`, `campay` et `telegram` doivent être `true`.

## Variables Render
| Variable | Rôle |
|---|---|
| `PUBLIC_BASE_URL` | adresse du site, sans `/` final |
| `CJ_API_KEY` | clé API CJ Dropshipping (le serveur gère le jeton tout seul) |
| `CAMPAY_ENV` | `DEMO` (tests) ou `PROD` (argent réel) |
| `CAMPAY_TOKEN` | jeton permanent CamPay (ou `CAMPAY_USERNAME` + `CAMPAY_PASSWORD`) |
| `PROFIT_USD` | marge cachée par produit, en dollars (10) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | recevoir les commandes et paiements |
| `ADMIN_KEY` | mot de passe des routes `/api/admin/*` (en-tête `x-admin-key`) |
| facultatif | `RESEND_API_KEY`, `RESEND_FROM`, `ANTHROPIC_API_KEY`, `DEEPL_API_KEY`, `GOOGLE_TRANSLATE_API_KEY`, `MIN_IMG_PX`, `REMINDER_DELAY_HOURS` |

## Fonctionnement
- Les prix viennent de CJ en dollars ; le serveur ajoute `PROFIT_USD`, puis convertit dans la devise du pays choisi (France = €, États-Unis = $, Cameroun = FCFA...).
- Le client paie en XAF via CamPay (Mobile Money MTN / Orange ou carte). Le total est recalculé par le serveur : le prix envoyé par le navigateur est ignoré.
- Le paiement n'est marqué « payé » qu'après vérification auprès de CamPay (webhook ou consultation du statut depuis l'inbox).
- Chaque commande (adresse complète, produits, lien CJ, marge) arrive sur Telegram.

## Limites connues
- `data/*.json` s'efface à chaque redéploiement sur le plan gratuit de Render.
- Les variantes CJ (taille, couleur) ne sont pas choisies par le client : l'identifiant et le lien CJ sont dans le message Telegram.
- Sans Resend, aucun email n'est envoyé (confirmation, rappels, alertes).
- Pas de recherche par photo (CJ n'en propose pas).
