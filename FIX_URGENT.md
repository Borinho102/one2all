# 🚨 FIX URGENT - Clés Google Cloud Exposées

## ⚠️ DANGER CRITIQUE

GitHub a bloqué votre push car **api-key.json** contient des credentials Google Cloud !

**Ces clés donnent accès à vos services cloud** (Firebase, Storage, etc.)

---

## ✅ SOLUTION EN 3 ÉTAPES

### 1️⃣ RÉVOQUER LES CLÉS (5 minutes)

**C'EST L'ÉTAPE LA PLUS IMPORTANTE !**

1. Ouvrez https://console.cloud.google.com
2. Sélectionnez votre projet
3. Menu → **IAM & Admin** → **Service Accounts**
4. Trouvez votre service account
5. Cliquez sur **Actions** (3 points) → **Manage keys**
6. **DELETE** toutes les clés

**OU supprimez le service account entier si vous n'êtes pas sûr**

---

### 2️⃣ NETTOYER GIT (2 minutes)

Une fois les clés révoquées :

```bash
cd /Users/borix102/WebstormProjects/MonLook-API
./fix_api_key_leak.sh
```

Tapez **"oui"** quand demandé

---

### 3️⃣ CRÉER NOUVELLES CLÉS (3 minutes)

1. Google Cloud Console → **IAM & Admin** → **Service Accounts**
2. **Create Service Account** (ou utilisez celui existant après avoir supprimé les anciennes clés)
3. **Actions** → **Manage keys** → **Add Key** → **Create new key**
4. Choisissez **JSON**
5. Téléchargez et sauvegardez **LOCALEMENT** (pas dans Git !)

---

## ⏱️ TEMPS TOTAL : 10 MINUTES

---

## ❓ FAQ Rapide

### Q: Pourquoi GitHub bloque mon push ?
**R:** GitHub protège vos clés. C'est une bonne chose !

### Q: Dois-je vraiment révoquer les clés ?
**R:** **OUI !** Elles sont potentiellement compromises.

### Q: Puis-je juste cliquer sur "Allow" dans le lien GitHub ?
**R:** **NON !** Ça expose vos clés publiquement.

### Q: Et si je saute l'étape de révocation ?
**R:** Quelqu'un pourrait utiliser vos clés pour accéder à vos données ou générer des coûts.

---

## 🔐 Après la Correction

### Pour éviter ce problème à l'avenir :

Ajoutez à votre `.gitignore` :
```
api-key.json
*.json
.env
credentials.json
```

### Utilisez des variables d'environnement :

```javascript
// Au lieu de :
const serviceAccount = require('./api-key.json');

// Utilisez :
const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS);
```

---

## 📖 Documentation Complète

Pour plus de détails : **`SECURITE_API_KEY.md`**

---

## 🚀 COMMENCEZ MAINTENANT

**Étape 1** : Révoquez les clés sur https://console.cloud.google.com  
**Étape 2** : `./fix_api_key_leak.sh`  
**Étape 3** : Créez de nouvelles clés

**NE REPORTEZ PAS - FAITES-LE MAINTENANT ! ⚠️**

