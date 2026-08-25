# Notes pour l'implémentation réelle — Espace commercial CommercI.A.l

Document d'accompagnement de `maquette-dashboard.html`. La maquette montre le rendu visuel et le comportement attendu ; ce document explique les règles métier et le mapping Airtable qu'on a validés ensemble, pour que l'implémentation réelle ne les redécouvre pas par déduction.

---

## Principe transverse (non négociable)

Aucun commercial ni Sandrine ne doit jamais avoir besoin d'ouvrir Airtable directement. Tout champ affiché dans le dashboard doit être :
- soit **modifiable depuis le dashboard**, avec écriture en arrière-plan (PATCH) vers Airtable via une route API serverless — jamais d'appel direct au navigateur vers l'API Airtable (la clé serait exposée publiquement) ;
- soit **verrouillé et affiché en lecture seule** quand il est alimenté par une automatisation (Make, Calendly, Youtrust, Stripe), avec un badge 🔒, pour ne jamais désynchroniser une automatisation en écrivant par-dessus ce qu'elle croit avoir fait.

## Architecture cible

- Les routes API vivent dans `api/` sur Vercel — **limite stricte de 12 fonctions** (plan Hobby). Regrouper plusieurs actions par fichier (pattern déjà utilisé ailleurs dans le repo).
- Auth : cookie de session signé HMAC-SHA256 existant (`api/_session.js`) — identité dérivée de la session + vérification de propriété via les champs de liaison Airtable (empêche un commercial de voir les données d'un autre).
- Airtable reste la base d'enregistrement unique. Aucune donnée financière ou de progression ne doit être stockée en dur côté frontend — toujours recalculée à partir d'Airtable.

---

## Table `Consultants` (`tblZe72whfqw8IPAx`) — champs et statut

| Champ Airtable | Usage dans le dashboard |
|---|---|
| `Statut` (singleSelect) | **Champ de référence** pour la Décision (Nouveau candidat / RDV pris / Accepté / À revoir / Refusé / Actif). Le dropdown "Décision" du dashboard écrit ici. |
| `decision/statut` | **Champ legacy**, à ignorer / à supprimer. Ne pas écrire dedans. |
| `Prenom`, `Nom`, `Email`, `Téléphone` | Éditables depuis la fiche. |
| `Ville`, `LinkedIn `, `Situation`, `Experience`, `Disponibilité hebdo`, `SIRET`, `IBAN` | Éditables, regroupés dans le bloc "Identité" de la fiche complète. |
| `Source`, `Motif_RDV`, `Date_RDV`, `Date entretien` | 🔒 Lecture seule (alimentés par le formulaire de candidature / Calendly). Une correction manuelle exceptionnelle reste possible via le crayon dans la timeline (ex. RDV replanifié hors Calendly), mais ce n'est pas le flux normal. |
| `CGV_acceptees`, `Date_acceptation_CGV` | 🔒 Lecture seule (Youtrust). |
| `Contrat_signature_id`, `Date_envoi_contrat`, `Date_signature_contrat` | 🔒 Lecture seule (Youtrust). `Date_limite_signature` reste éditable (correction manuelle possible). |
| `Relance_J2_envoyee`, `Relance_J5_envoyee` | 🔒 Lecture seule (Make). Affichées comme pastilles dans la timeline sous "Contrat envoyé". |
| `Notification_J7_envoyee` | 🔒 Lecture seule. **Attention** : ce n'est pas une relance envoyée au candidat, c'est une notification interne pour Sandrine (le champ s'appelle bien "Notification", pas "Relance"). Ne pas mal libeller dans l'UI. |
| `Relance_RDV_4h/24h/3j_envoyee` | 🔒 Lecture seule (Make), pastilles sous l'étape RDV. |
| `Dashboard_envoye` | 🔒 Lecture seule. |
| `Date_decision` | Existe dans Airtable mais jugée non prioritaire par Sandrine — ne pas afficher pour l'instant. |
| `Formation_terminee`, `Premiere_publication_confirmee` | Champs auto-déclaratifs liés à l'onboarding du commercial. **Sandrine hésite à les garder** — ne pas les implémenter tant qu'elle n'a pas tranché (lié au chantier "onboarding avec % de progression", pas encore construit). |
| `Password_hash` | **Ne jamais afficher ni exposer**, nulle part dans le dashboard. |
| `Zone_geo`, `Consultant_ID` (champ IA), `Diagnostics` / `Diagnostics 2`, `Entreprise`, `Clients`, `Audits`, `Solution_proposee`, `Lien_Calendly`, `Lien_Zoom` | Champs côté "Client CAPE" de cette même table (elle sert aux deux usages), pas pertinents pour la fiche de recrutement commercial. `Consultant_ID` semble mal configuré (champ IA sur pièce jointe) — à vérifier avant tout usage. |

**Décision affichée mais pas stockée séparément** : la fiche distingue "Prospect" (en recrutement) vs "Commercial actif" via la valeur de `Statut` — pas un champ booléen séparé.

---

## Table `Evaluations` (`tblLSOIKDKUe1JJes`)

- `Type_evaluation` : "Scoring recrutement" ou "Self-audit CAPE" — le dashboard actuel ne traite que le scoring recrutement.
- 6 scores individuels (vérifiés dans Airtable, precision 1 décimale) : `Score_motivation` (/20), `Score_commercial` (/20), `Score_reseau` (/20), `Score_autonomie` (/15), `Score_numerique` (/10), `Score_disponibilite` (/15).
- `Score_total` = somme des 6 (formule Airtable).
- `Decision_IA` = formule Airtable, **vérifiée** : `≥75 → 🟢 Recommandé`, `≥50 → 🟠 À examiner`, `<50 → 🔴 Non recommandé`. Ne pas recalculer ce seuil ailleurs, utiliser directement le champ formule.
- `Compte_rendu_IA` (texte long) : à afficher dans l'étape "Évaluation IA" de la timeline, pas de "forces/points de vigilance" reconstruits à la main.

---

## Modèle financier — Suivi CA / Paiement (le plus important à bien reproduire)

**Principe validé avec Sandrine** : Studeria informe Sandrine (hors système, manuellement) qu'un client a payé. Il n'y a **aucun webhook automatique** entre Studeria et Airtable pour cette info — c'est Sandrine qui déclenche l'enregistrement depuis le dashboard.

Chaîne fonctionnelle à reproduire :
1. Un client passe par un commercial (`Clients.Origine` / lien vers `Consultants`), avec un devis Studeria (table `Audits`, statut `Signé`).
2. Depuis la fiche client, un bouton **"Enregistrer un paiement reçu"** apparaît dès que l'audit est `Signé` (ou `Payé` avec reste à encaisser > 0). Il ouvre un petit formulaire : montant, date.
3. Un client peut payer en plusieurs fois — chaque saisie crée une **nouvelle ligne** dans `Paiements`, liée au `Client` et au `Consultant`.
4. Dès que le cumulé encaissé atteint le montant du devis, l'audit passe automatiquement à `Payé`.
5. La commission (5%) se calcule **automatiquement sur le montant réellement encaissé**, jamais sur le montant du devis. **Elle n'est jamais saisie à la main.**
6. Le tableau "Suivi CA / Paiement" (par commercial) est entièrement dérivé de ces paiements — aucune donnée financière ne doit être stockée séparément sur la fiche du commercial.

**Écart à trancher avant le dev** : la table `Paiements` réelle (`tblxB3tjITPrkBUp8`) n'a pas de champ "commission" dédié — champs actuels : `Montant`, `Origine`, `Type_paiement`, `Date_paiement`, `Statut_paiement`, liens `Consultant_lien` / `Client_lien`. Deux options :
- (a) calculer la commission à la volée (5% × `Montant`) à chaque affichage — pas de nouveau champ Airtable ;
- (b) ajouter un champ `Commission` calculé (formule Airtable) sur `Paiements`, plus simple à interroger et à figer historiquement (utile si le taux de commission change un jour).
→ **Recommandation : option (b)**, plus robuste si le taux évolue un jour ou si des paliers sont introduits.

**Conditions d'éligibilité à la commission** (déjà dans la maquette, à confirmer) :
- `Clients.Origine` = commercial du réseau (pas client direct de Sandrine) ;
- `Audits.Statut` = "Signé" ou "Payé" ;
- Solution proposée = Studeria (pas une solution externe gérée par le commercial hors circuit).

**Blocages de versement** (déjà dans la maquette) :
- IBAN manquant sur la fiche du commercial → versement bloqué.
- Abonnement Stripe du commercial non payé pour la période → commission bloquée (affichée distinctement de "due").

---

## Comportements UI à reproduire

- **Timeline de progression** (fiche prospect/commercial) : toujours visible en entier même avant décision (étapes futures grisées), se coche automatiquement au fil des automatisations. Seul "Refusé" arrête définitivement la timeline ; "À revoir" la met en pause visuellement (violet, pointillé) sans la masquer.
- **Un seul crayon = une seule correction manuelle possible**, jamais de ressaisie manuelle de ce qui est normalement automatique.
- **Filtre Prospects / Commerciaux actifs** dans l'onglet "Prospects et commerciaux" : basé sur `Statut`.
- **Détail commission** (bouton dans "Suivi CA / Paiement") : doit lister, par vente, le nom du client, la date du paiement, le montant encaissé, la commission calculée, et — si versée — la date de versement. Sert de justificatif en cas de litige avec un commercial : ne jamais résumer/agréger sans le détail sous-jacent accessible.

---

## Ce qui n'est volontairement pas encore construit

- Onglets "Catalogue & ressources", "Mes liens", "Les outils", "Mon compte" : aucun contenu prévu pour l'instant.
- Onboarding avec % de progression (candidat devenu commercial actif) : conçu dans le workflow initial, jamais implémenté.
- Zone 4 (pilotage du matin / vue consolidée "aujourd'hui") : pas encore abordée dans la maquette.
