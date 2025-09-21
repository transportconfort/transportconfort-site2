# Transport Confort — Netlify Deploy

## Prérequis (Site + Functions)
- **Environment variables** (Netlify → Site settings → Environment):
  - `STRIPE_SECRET_KEY` (obligatoire, test ou live)
  - `SITE_URL` (optionnel, ex: https://transportconfort.netlify.app)
  - `SUCCESS_URL` (optionnel)
  - `CANCEL_URL` (optionnel)
- `config.json` (inclus) contient :
  - `STRIPE_PUBLISHABLE_KEY`
  - `GMAPS_KEY`
  - `CALENDLY_VTC` / `CALENDLY_MAD`

## Build Netlify
- **Build command**: (laisser vide)
- **Publish directory**: `.`
- **Functions directory**: `netlify/functions` (défini dans `netlify.toml`)

> Ce projet est un **site statique** + **Netlify Functions**. `package.json` déclare `stripe` pour permettre au bundler d'inclure la lib.
> Node 18+ recommandé (défini dans `engines`).

Si la construction reste bloquée, vérifier:
1. Variables d'environnement manquantes (surtout `STRIPE_SECRET_KEY`).
2. Conflits de build command non vide.
3. Droits des fichiers (réupload du ZIP).
