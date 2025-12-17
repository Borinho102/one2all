# 🚨 ALERTE SÉCURITÉ CRITIQUE - api-key.json

## ❌ PROBLÈME GRAVE

GitHub a détecté des **Google Cloud Service Account Credentials** dans votre code !

```
File: api-key.json
Type: Google Cloud Service Account Credentials
Commit: 962d6b27b8e59fa32178963d09782f85d54fce03
```

**⚠️ DANGER** : Ces clés donnent accès à vos services Google Cloud (Firebase, Storage, etc.)

---

## 🔴 ACTIONS URGENTES (AVANT TOUT)

### 1️⃣ RÉVOQUER LES CLÉS IMMÉDIATEMENT

**NE SAUTEZ PAS CETTE ÉTAPE !**

1. 🌐 Allez sur https://console.cloud.google.com
2. Sélectionnez votre projet
3. Menu → **IAM & Admin** → **Service Accounts**
4. Trouvez le service account correspondant à `api-key.json`
5. Cliquez sur les **3 points** → **Manage keys**
6. **DELETE** toutes les clés existantes
7. **OU supprimez complètement** le service account

**Pourquoi ?** Ces clés sont **publiques** maintenant. N'importe qui peut les utiliser !

---

### 2️⃣ SUPPRIMER LE FICHIER DE GIT

Une fois les clés révoquées, exécutez :

```bash
cd /Users/borix102/WebstormProjects/MonLook-API
./fix_api_key_leak.sh
```

**Tapez "oui"** quand demandé (après avoir révoqué les clés)

---

### 3️⃣ CRÉER DE NOUVELLES CLÉS

1. Sur Google Cloud Console
2. **IAM & Admin** → **Service Accounts**
3. Créez un **nouveau** service account
4. **Create Key** → JSON
5. Téléchargez le fichier
6. Renommez-le `api-key.json`
7. **NE LE METTEZ PAS DANS GIT !**

---

## 🛡️ BONNES PRATIQUES

### Comment Gérer les Clés Correctement

#### Option 1️⃣ : Variables d'Environnement (Production)

```bash
# .env (ajouter au .gitignore)
GOOGLE_APPLICATION_CREDENTIALS=/path/to/api-key.json
```

```javascript
// Dans votre code
const admin = require('firebase-admin');
admin.initializeApp({
  credential: admin.credential.cert(process.env.GOOGLE_APPLICATION_CREDENTIALS)
});
```

#### Option 2️⃣ : Fichier Local Non-Tracké

```bash
# Dans .gitignore
api-key.json
*.json
credentials.json
serviceAccountKey.json
```

Stockez le fichier **localement uniquement**, jamais dans Git.

#### Option 3️⃣ : Services de Secrets (Production)

- **Google Secret Manager**
- **AWS Secrets Manager**
- **HashiCorp Vault**
- **GitHub Secrets** (pour CI/CD)

---

## 📋 Checklist de Sécurité

### Avant d'Exécuter le Script

- [ ] ✅ Clés révoquées sur Google Cloud Console
- [ ] ✅ Nouveau service account créé
- [ ] ✅ Nouvelles clés téléchargées
- [ ] ✅ Sauvegarde locale de api-key.json (hors Git)

### Après le Script

- [ ] ✅ Push réussi vers GitHub
- [ ] ✅ api-key.json dans .gitignore
- [ ] ✅ Application fonctionne avec les nouvelles clés
- [ ] ✅ Aucun autre fichier sensible dans Git

---

## 🔍 Vérifier Autres Fichiers Sensibles

Vérifiez si vous avez d'autres fichiers sensibles :

```bash
# Chercher des fichiers de clés
find . -name "*.json" -not -path "./node_modules/*"
find . -name "*.pem"
find . -name "*.key"
find . -name ".env"

# Chercher dans l'historique Git
git log --all --full-history --source --find-object=api-key.json
```

**Fichiers à NE JAMAIS committer :**
```
api-key.json
serviceAccountKey.json
credentials.json
*.pem
*.key
.env
.env.local
firebase-adminsdk.json
google-services.json (avec des secrets)
```

---

## ⚠️ Que Faire Si Les Clés Étaient Publiques ?

Si votre repository était **public** :

1. **Considérez que les clés sont compromises**
2. **Vérifiez les logs d'utilisation** sur Google Cloud Console
3. **Surveillez les coûts** inhabituels
4. **Changez TOUS les secrets** liés au projet
5. **Activez les alertes** de sécurité

---

## 📊 Impact de Cette Fuite

Avec ces clés, quelqu'un pourrait :

- ❌ Accéder à votre base de données Firebase
- ❌ Lire/écrire dans Cloud Storage
- ❌ Utiliser vos quotas Google Cloud (coûts $$$)
- ❌ Supprimer des données
- ❌ Modifier des configurations

**C'est pourquoi c'est CRITIQUE !**

---

## 🆘 Aide Supplémentaire

### Liens Utiles

- [Google Cloud - Rotating Credentials](https://cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys)
- [GitHub Secret Scanning](https://docs.github.com/en/code-security/secret-scanning)
- [Best Practices for API Keys](https://cloud.google.com/docs/authentication/api-keys)

### Support GitHub

Le lien fourni par GitHub :
https://github.com/Borinho102/one2all/security/secret-scanning/unblock-secret/36yG4ba5YTRELPpLL1TtwIsAGlV

**NE CLIQUEZ PAS sur "Allow"** - Révoquez plutôt les clés !

---

## ✅ Résumé des Étapes

1. 🔴 **RÉVOQUER** les clés sur Google Cloud Console
2. 🧹 **EXÉCUTER** `./fix_api_key_leak.sh`
3. 🔑 **CRÉER** de nouvelles clés
4. 💾 **STOCKER** localement (pas dans Git)
5. ✅ **VÉRIFIER** que tout fonctionne

---

## ✨ Après la Correction

Une fois terminé, votre repository sera sécurisé et vous pourrez continuer à travailler en toute sécurité ! 🛡️

**Questions ?** Relisez ce guide attentivement avant d'agir.

**PRIORITÉ ABSOLUE** : Révoquez les clés MAINTENANT ! ⚠️

