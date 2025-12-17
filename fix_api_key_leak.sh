#!/bin/bash

# 🚨 FIX CRITIQUE - Suppression de api-key.json de l'historique Git
# ⚠️  IMPORTANT: Révoquez les clés sur Google Cloud Console AVANT d'exécuter ce script !

set -e

echo "🚨 FIX CRITIQUE - Suppression de api-key.json"
echo "=============================================="
echo ""

# Couleurs
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_step() {
    echo -e "${BLUE}==>${NC} ${GREEN}$1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_error "ALERTE SÉCURITÉ: api-key.json contient des credentials Google Cloud !"
echo ""
print_warning "AVANT DE CONTINUER, FAITES CECI:"
echo ""
echo "   1. 🌐 Allez sur https://console.cloud.google.com"
echo "   2. 🔑 IAM & Admin → Service Accounts"
echo "   3. 🗑️  SUPPRIMEZ le service account correspondant à api-key.json"
echo "   4. ✅ OU révoc les clés de ce service account"
echo "   5. 🔄 Créez un NOUVEAU service account avec de nouvelles clés"
echo ""
print_error "Si vous n'avez PAS révoqué les clés, ARRÊTEZ MAINTENANT !"
echo ""

read -p "Avez-vous RÉVOQUÉ les anciennes clés? (tapez 'oui' pour confirmer): " -r
echo
if [[ ! $REPLY == "oui" ]]; then
    print_error "Opération annulée pour votre sécurité."
    echo ""
    echo "Révoquez d'abord les clés sur Google Cloud Console, puis relancez ce script."
    exit 0
fi

echo ""
print_step "Étape 1/6: Suppression de api-key.json de l'historique Git..."

# Utiliser git filter-branch pour supprimer le fichier
git filter-branch --force --index-filter \
  'git rm --cached --ignore-unmatch api-key.json' \
  --prune-empty --tag-name-filter cat -- --all

echo ""
print_step "Étape 2/6: Mise à jour du .gitignore..."

# Ajouter au .gitignore si pas déjà présent
if ! grep -q "api-key.json" .gitignore 2>/dev/null; then
    echo "" >> .gitignore
    echo "# Google Cloud Credentials - NE JAMAIS COMMITTER" >> .gitignore
    echo "api-key.json" >> .gitignore
    echo "*.json" >> .gitignore
    echo "serviceAccountKey.json" >> .gitignore
    echo "credentials.json" >> .gitignore
    echo "   ✅ .gitignore mis à jour"
else
    echo "   ℹ️  .gitignore déjà configuré"
fi

echo ""
print_step "Étape 3/6: Nettoyage des références..."
rm -rf .git/refs/original/ 2>/dev/null || true
git reflog expire --expire=now --all

echo ""
print_step "Étape 4/6: Garbage collection..."
git gc --prune=now --aggressive

echo ""
print_step "Étape 5/6: Commit du .gitignore..."
git add .gitignore
git commit -m "🔒 Sécurité: Ajout de api-key.json au .gitignore" || echo "   ℹ️  Déjà commité"

echo ""
print_step "Étape 6/6: Push forcé vers GitHub..."
print_warning "Push forcé en cours..."

git push origin master --force

echo ""
echo "=============================================="
echo -e "${GREEN}✅ Succès !${NC}"
echo ""
echo "✨ api-key.json a été supprimé de l'historique Git"
echo "✅ Le push vers GitHub a réussi"
echo ""
print_warning "IMPORTANT - Prochaines étapes:"
echo ""
echo "   1. ✅ Créez un NOUVEAU service account sur Google Cloud"
echo "   2. 📥 Téléchargez les nouvelles clés"
echo "   3. 💾 Sauvegardez api-key.json LOCALEMENT (pas dans Git !)"
echo "   4. 🔐 Utilisez des variables d'environnement en production"
echo ""
echo "📖 Consultez SECURITE_API_KEY.md pour les bonnes pratiques"
echo ""

