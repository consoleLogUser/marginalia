# Marginalia — lire, retenir, appliquer

Une web app pour iPhone (installable sur l'écran d'accueil) qui t'aide à **tirer quelque chose de tes lectures** :

- **Lire** — tu notes ce qui t'arrête (citation, idée, question, action à essayer), au clavier, en dictant ou en collant un passage ; tu chronomètres tes sessions ; objectif du jour, série, date de fin estimée.
- **Retenir** — chaque jour, quelques notes reviennent en cartes : tu retrouves l'idée **de mémoire**, puis tu vérifies (répétition espacée : 1, 3, 7, 14, 30, 60, 120 jours).
- **Appliquer** — tes « À appliquer » deviennent un plan : **une** action par semaine, puis ce que ça a donné, écrit dans la fiche.

Tes notes vivent dans **ton** dépôt GitHub privé, en Markdown lisible dans Obsidian. L'app fonctionne hors ligne et synchronise toute seule. **Coût : 0 €.**

```
 iPhone ─────────────────────────────────────────────┐
 │  Marginalia (web app installée)                    │      GitHub (gratuit)
 │   ├─ copie locale des fiches (IndexedDB)           │      ┌─────────────────────────────┐
 │   ├─ file des modifications à envoyer   ──commits──┼────► │ marginalia-data (PRIVÉ)     │
 │   └─ app elle-même en cache (service worker)       │ ◄────│  fiches/*.md   ← tes notes  │
 │  Raccourci « Noter » (feuille de partage, dictée,  │      │  boite/        ← raccourci  │
 │   bouton Action, Apple Intelligence) ──── PUT ─────┼────► │  .marginalia/  ← journal    │
 │  Automatisation « 21:00 » → rappel du rituel       │      └─────────────────────────────┘
 └────────────────────────────────────────────────────┘      ┌─────────────────────────────┐
                                                             │ marginalia (public) = l'app │
 PC : Obsidian + « Obsidian Git » sur marginalia-data        │ → GitHub Pages              │
                                                             └─────────────────────────────┘
```

## Mise en route (une seule fois, ~15 min)

### 1. Publier l'app
Ce dépôt (`marginalia`, **public** : il ne contient que le code, aucune donnée) se publie tout seul sur GitHub Pages.
Une seule manipulation : **Settings › Pages › Build and deployment › Source : « GitHub Actions »**.
Au prochain push (ou via *Actions › Publier l'app › Run workflow*), l'app est en ligne sur
`https://<ton-compte>.github.io/marginalia/` (le nom de compte en minuscules).

### 2. Créer le dépôt de tes notes
Sur GitHub : **New repository** › nom `marginalia-data` › **Private** › rien d'autre (vide). C'est là que vivront tes fiches.

### 3. Installer l'app sur l'iPhone
Ouvre l'adresse de l'app dans **Safari** › **Partager** › **Sur l'écran d'accueil** › **Ajouter**.
Puis ouvre Marginalia **depuis l'icône** et continue là-bas : Safari et l'app installée ne partagent pas leur stockage.

### 4. Connecter l'app à ton dépôt
L'app te guide. Le lien « ouvrir GitHub » pré-remplit un **jeton à accès limité** (fine-grained) : dans *Repository access*, choisis
**Only select repositories › marginalia-data** ; la permission **Contents : Read and write** est déjà cochée ; expiration 1 an.
Génère, copie, colle dans l'app. L'app vérifie que le dépôt est bien **privé**, puis crée sa présentation et la liste des livres.

### 5. Le raccourci « Noter » et le rappel du soir
Dans l'app : **Réglages › Sur ton iPhone**. Deux guides pas à pas, personnalisés avec ton dépôt (boutons « Copier » pour chaque valeur) :
- **Raccourci « Noter »** : noter depuis la feuille de partage (un passage sélectionné dans Safari, Kindle, Livres…), en dictant
  (avec correction facultative par Apple Intelligence, sur l'appareil), ou d'une pression sur le bouton Action. La note part dans
  `boite/` ; l'app la range dans la bonne fiche à sa prochaine synchronisation.
- **Rappel du soir** : une automatisation iOS à l'heure de ton rituel (une web app ne peut pas envoyer de notification sans serveur ;
  ton iPhone, si).

### 6. (Facultatif) Tes notes dans Obsidian sur le PC
Clone `marginalia-data` dans ton vault (extension **Obsidian Git**, ou `git clone`). Tu peux y modifier tes fiches librement :
l'app relit tout à la synchronisation suivante. Tes fiches de la V1/V2 de bureau s'importent depuis **Réglages › Importer des fiches .md**.

## Comment ça marche

**Hors ligne d'abord.** Tout ce que tu fais est enregistré sur le téléphone *avant* d'être envoyé. L'écran affiche immédiatement
« dernière version connue + modifications en attente ». La pastille en haut indique l'état : *À jour*, *N à envoyer*, *Hors ligne*,
*À reconnecter*. Les notes partent en ~3 s, les révisions sont regroupées (~30 s), et tout part quand tu quittes l'app.

**Pas d'écrasement entre appareils.** Pour modifier un fichier, GitHub exige l'identifiant (sha) de la version qu'on remplace :
si la fiche a changé ailleurs (PC, Obsidian, autre iPhone), GitHub refuse, l'app relit la nouvelle version et **réapplique** son
opération dessus (« ajouter telle note », « cocher telle action »…). Ces opérations sont *idempotentes* : rejouées après une coupure
réseau, elles ne créent jamais de doublon.

**Un journal par appareil.** Révisions, sessions de lecture, progression et action de la semaine sont des événements ajoutés au
carnet de l'appareil (`.marginalia/journal/AAAA-MM-<appareil>.jsonl`). L'état (cartes, série, pages lues) est recalculé en rejouant
tous les carnets dans l'ordre : deux appareils n'écrivent jamais dans le même fichier de journal.

**La boîte de réception.** Le raccourci dépose un petit fichier par note dans `boite/`. L'identifiant de la note est calculé à partir
du nom du fichier : même si l'app s'arrête au milieu, ou si deux appareils rangent la même note, elle n'est ajoutée qu'une fois.

## Tes données

```
marginalia-data/
├─ README.md
├─ fiches/
│  └─ lettres-a-lucilius.md        ← une fiche par livre (format des V1/V2, compatible Obsidian)
├─ boite/                          ← vide la plupart du temps
└─ .marginalia/
   ├─ livres.json                  ← lu par le raccourci (livres en cours)
   ├─ reglages.json                ← objectif du jour, cartes par jour, heure du rituel
   └─ journal/2026-11-ab12cd.jsonl ← une ligne JSON par événement
```

Une note dans une fiche :

```markdown
> [!quote] Citation · p. 42 · 2026-11-17 21:31
> Ce n'est pas que nous ayons peu de temps, c'est que nous en perdons beaucoup.
>
> 💭 Mon problème le soir.
>
> #temps

^k3x9q2
```

La ligne `^k3x9q2` est l'identifiant de la note (il relie la note à son historique de révision) : évite de la modifier.

## Sécurité et vie privée

- Le dépôt des notes est **privé** (l'app refuse de se connecter à un dépôt public).
- Le jeton ne donne accès **qu'à ce dépôt**, ne quitte jamais le téléphone (stockage local de l'app) et ne sert qu'à parler à
  `api.github.com` ; il n'est jamais affiché (seulement copiable, pour le raccourci). Tu peux le révoquer à tout moment sur GitHub.
- Politique de sécurité de contenu stricte : aucun script externe, aucun script en ligne, une seule destination réseau (`api.github.com`).
- Le texte de tes notes est toujours inséré comme texte, jamais interprété comme du HTML.
- Le raccourci « Noter » contient ton jeton : ne le partage pas.

## Limites connues

- Pas de notification envoyée par l'app elle-même : c'est l'automatisation iOS qui fait le rappel du soir.
- Le jeton expire (1 an) : l'app le signale (« À reconnecter ») ; *Réglages › Changer de jeton*.
- La feuille de partage d'iOS n'accepte pas les web apps comme destination : c'est le rôle du raccourci « Noter ».

## Développement

```bash
npm test                       # 41 tests unitaires : format des fiches, révision, journal, synchronisation (faux GitHub)
npm install && npm run test:e2e  # 18 scénarios sur un iPhone simulé (WebKit) + captures dans test-results/
node scripts/serve.js --mock   # l'app sur http://localhost:8080/?mock avec un faux GitHub (compte « moi »)
node scripts/stamp-sw.js       # version du service worker (fait automatiquement à la publication)
```

```
app/                     ← tout ce qui est publié (aucune étape de build)
├─ index.html, manifest.webmanifest, sw.js, css/app.css, icons/
└─ js/
   ├─ api.js             ← window.marginalia : l'API utilisée par l'interface
   ├─ core/              ← logique pure, testée : fiches, révision espacée, journal, événements, boîte, calculs
   ├─ data/              ← GitHub (API REST), stockage local (IndexedDB), synchronisation, bibliothèque
   └─ ui/                ← un fichier par écran (Lire, Retenir, Appliquer, Progrès, Réglages, Connexion)
scripts/                 ← serveur local, faux GitHub, tests de bout en bout, version du service worker
test/                    ← tests unitaires (node --test)
```

Aucune dépendance à l'exécution : du JavaScript moderne, des modules ES, IndexedDB, un service worker.
